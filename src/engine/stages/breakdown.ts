import { prepareWrite } from '../safe-fs.js';
import { join } from 'node:path';
import { FeaturesOut, type FeatureOut, type FeatureRow } from '../../domain/types.js';
import { templatePath } from '../../office/templates.js';
import { readUlnlCatalog, type UlnlCatalog } from '../../office/ulnl-catalog.js';
import { writeUlnl } from '../../office/ulnl-xlsx.js';
import { buildPrompt } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { OutputError, readJsonOutput, runClaudeStep } from './claude-json.js';
import { artifactName, contextFileVars, crResponsible, isIncremental, promptExtras } from './common.js';

const FEATURES_EXAMPLE = {
  features: [
    { id: 'F-01', code: 'QLDH_DS', name: 'Danh sách đơn hàng', description: 'Tìm kiếm, lọc, phân trang đơn hàng; ~12 trường hiển thị → mức 2', type_code: 'CN_WEB2', unit_test: true, note: 'TKCT: Thiết kế chi tiết > QLDH_DS - Danh sách đơn hàng', kind: 'function' },
    { id: 'NF-01', code: 'PM', name: 'Quản lý dự án', description: 'Quản lý dự án', type_code: 'PM', unit_test: false, note: '', kind: 'nonfunction' },
  ],
};

const cell = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

export function typeTable(cat: UlnlCatalog): string {
  if (!cat.types.length) return '(mẫu ULNL không có bảng loại chức năng — dùng mã ngắn mô tả loại, ví dụ CN_WEB1)';
  return ['| Mã | Tên | Nhóm | Giải thích (tiêu chí chọn) |', '|---|---|---|---|',
    ...cat.types.map(t => `| ${cell(t.code)} | ${cell(t.name)} | ${cell(t.group)} | ${cell(t.explain)} |`)].join('\n');
}

function nonFuncTable(cat: UlnlCatalog): string {
  if (!cat.nonFunctions.length) return '(mẫu ULNL không có bảng hạng mục phi chức năng)';
  return ['| Mã | Tên hạng mục | Phạm vi | Nỗ lực chuẩn (MH) |', '|---|---|---|---|',
    ...cat.nonFunctions.map(n => `| ${cell(n.code)} | ${cell(n.name)} | ${cell(n.scope)} | ${cell(n.effort)} |`)].join('\n');
}

function checkFeatures(path: string, fs: FeatureOut[], cat: UlnlCatalog): void {
  const errs: string[] = [];
  const typeCodes = new Set(cat.types.map(t => t.code));
  const nfCodes = new Set(cat.nonFunctions.map(n => n.code));
  const ids = new Set<string>();
  const codes = new Set<string>();
  const functions = fs.filter(f => f.kind === 'function' && f.scope_status === 'active');
  if (!functions.length) errs.push('chưa có chức năng nào còn hiệu lực (kind = "function", scope_status khác "cancelled")');
  for (const f of fs) {
    if (ids.has(f.id)) errs.push(`${f.id}: id bị trùng`);
    ids.add(f.id);
    if (f.kind === 'function') {
      if (!/^[A-Z0-9_]+$/.test(f.code)) errs.push(`${f.id}: code "${f.code}" chỉ được gồm A-Z, 0-9, _`);
      if (codes.has(f.code)) errs.push(`${f.id}: code "${f.code}" bị trùng`);
      codes.add(f.code);
      if (typeCodes.size && !typeCodes.has(f.type_code.trim())) errs.push(`${f.id}: type_code "${f.type_code}" không có trong bảng loại chức năng`);
    } else if (nfCodes.size && !nfCodes.has(f.code.trim())) {
      errs.push(`${f.id}: mã phi chức năng "${f.code}" không có trong bảng hạng mục phi chức năng`);
    }
  }
  if (errs.length) throw new OutputError(`File ${path} có lỗi:\n- ${errs.join('\n- ')}`);
}

const toRow = (f: FeatureOut): FeatureRow => ({
  id: f.id, code: f.code, name: f.name, description: f.description, typeCode: f.type_code, unitTest: f.unit_test, note: f.note, kind: f.kind,
  scopeStatus: f.scope_status, changedByCr: null,
});

/**
 * Incremental BREAKDOWN (after accepted CRs): Claude's list is merged into the existing features. Existing ids keep
 * their CR traceability unless Claude changed scope_status (then the responsible CR is recorded); a feature cancelled
 * earlier is never reactivated (a re-added function needs a new id); new features record the responsible CR; features
 * Claude omitted are kept, never deleted. Returns the merged rows.
 */
export function mergeFeatures(ctx: StageContext, out: FeatureOut[]): FeatureRow[] {
  const prev = new Map(ctx.repo.listFeatures(ctx.req.id).map(f => [f.id, f]));
  const rows = out.map(f => {
    const row = toRow(f);
    const old = prev.get(f.id);
    if (!old) return { ...row, changedByCr: crResponsible(ctx, 'feature', f.id) ?? null };
    if (old.scopeStatus === 'cancelled') {
      if (f.scope_status !== 'cancelled') ctx.log(`${f.id} đã bị hủy${old.changedByCr ? ` theo ${old.changedByCr}` : ''}, giữ trạng thái hủy (chức năng làm lại phải dùng id mới)`, 'warn');
      return { ...row, scopeStatus: 'cancelled' as const, changedByCr: old.changedByCr };
    }
    return { ...row, changedByCr: f.scope_status !== old.scopeStatus ? (crResponsible(ctx, 'feature', f.id) ?? old.changedByCr) : old.changedByCr };
  });
  const seen = new Set(out.map(f => f.id));
  const omitted = [...prev.values()].filter(f => !seen.has(f.id));
  if (omitted.length) ctx.log(`features.json thiếu ${omitted.map(f => f.id).join(', ')} — giữ nguyên các mục này (không xóa khi cập nhật theo thay đổi)`, 'warn');
  return [...rows, ...omitted].sort((a, b) => a.id.localeCompare(b.id));
}

export async function breakdown(ctx: StageContext): Promise<StageOutcome> {
  const { ws, req } = ctx;
  const tpl = templatePath(ctx.cfg, 'ulnl');
  const cat = await readUlnlCatalog(tpl);
  const out = join(ws.devflowDir, 'features.json');

  const prompt = buildPrompt('analyst-breakdown', {
    ...contextFileVars(ctx),
    type_catalog: typeTable(cat),
    nonfunction_catalog: nonFuncTable(cat),
  }, promptExtras(ctx, [
    { path: out, description: 'Danh sách chức năng và hạng mục phi chức năng.', example: FEATURES_EXAMPLE },
  ]));

  const r = await runClaudeStep(ctx, {
    prompt,
    clean: [out],
    validate: async () => {
      const { features } = await readJsonOutput(out, FeaturesOut);
      checkFeatures(out, features, cat);
      return features;
    },
  });
  if (!r.ok) return { kind: 'fail', error: r.error };

  let features: FeatureRow[];
  if (isIncremental(ctx)) {
    features = mergeFeatures(ctx, r.value);
    ctx.repo.upsertFeatures(req.id, features);
  } else {
    features = r.value.map(toRow);
    ctx.repo.replaceFeatures(req.id, features);
  }
  const cancelledBy = (f: FeatureRow): { cancelledBy?: string } => (f.scopeStatus === 'cancelled' ? { cancelledBy: f.changedByCr ?? '' } : {});
  const fns = features.filter(f => f.kind === 'function');
  const nfs = features.filter(f => f.kind === 'nonfunction');
  const xlsx = join(ws.artifactsDir, artifactName('ULNL', ctx.ws.key, ctx.baseline));
  prepareWrite(xlsx);
  await writeUlnl(
    tpl,
    fns.map(f => ({ code: f.code, name: f.name, description: f.description, type_code: f.typeCode, unit_test: f.unitTest, note: f.note, ...cancelledBy(f) })),
    nfs.map(f => ({ code: f.code, name: f.name, description: f.description, ...cancelledBy(f) })),
    req.title,
    xlsx,
  );
  const cancelled = features.filter(f => f.scopeStatus === 'cancelled').length;
  ctx.log(`Đã bóc tách ${fns.length} chức năng và ${nfs.length} hạng mục phi chức năng${cancelled ? ` (${cancelled} mục đã hủy, không tính nỗ lực)` : ''}; ULNL: ${xlsx}`);
  return { kind: 'next' };
}
