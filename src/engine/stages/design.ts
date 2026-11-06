import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from '../../db/repo.js';
import { renderDocx } from '../../office/docx.js';
import { templatePath } from '../../office/templates.js';
import { buildPrompt } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { OutputError, readTextOutput, runClaudeStep } from './claude-json.js';
import {
  artifactName, contextFileVars, effectiveChanges, ensureOnBranch, headingHasCode, headings, integrationBranch, isIncremental,
  missingHeadings, promptExtras, pushIfRemote,
} from './common.js';

/** Required headings of the company templates (spec §7, templates/default/*.docx). */
const TKCT_HEADINGS: [number, string][] = [
  [1, 'TỔNG QUAN'], [2, 'Tổng quan dự án'], [2, 'Yêu cầu chức năng'], [2, 'Yêu cầu phi chức năng'], [2, 'Yêu cầu hiệu năng'], [2, 'Yêu cầu khác'],
  [1, 'THIẾT KẾ TỔNG THỂ'], [2, 'Mô hình tổng thể'], [2, 'Danh sách kết nối'],
  [1, 'THIẾT KẾ CHI TIẾT'], [2, 'Thiết kế giao tiếp'], [2, 'Cơ sở dữ liệu'],
  [1, 'PHỤ LỤC'], [2, 'Sơ đồ luồng dữ liệu nghiệp vụ'], [2, 'Câu hỏi mở và giả định'],
];
const TKDB_HEADINGS: [number, string][] = [
  [1, 'GIỚI THIỆU'], [2, 'Mục tiêu tài liệu'], [2, 'Định nghĩa thuật ngữ và các từ viết tắt'], [2, 'Tài liệu tham khảo'], [2, 'Mô tả chung'],
  [1, 'CƠ SỞ DỮ LIỆU'], [2, 'Các mô hình quan hệ dữ liệu'], [3, 'Danh sách bảng'], [3, 'Danh sách mã lỗi'], [2, 'Script rollback'],
];

export const CHANGE_HISTORY_HEADING = 'Lịch sử thay đổi';

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** dd/mm/yyyy (local time). */
export function viDate(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}
const tcell = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * "## Lịch sử thay đổi" section of the TKCT, generated from the DB (never written by Claude): one row for the first
 * version, then one per accepted/applied CR (rejected CRs are excluded). Empty string when no CR changed the request.
 */
export function changeHistoryMarkdown(repo: Repo, reqId: string): string {
  const req = repo.getRequest(reqId);
  const crs = effectiveChanges(repo.listChangeRequests(reqId));
  if (!req || !crs.length) return '';
  const who = (id: number | null): string => (id === null ? 'DevFlow (tự động)' : (repo.web.getUser(id)?.username ?? `#${id}`));
  return [
    `## ${CHANGE_HISTORY_HEADING}`,
    '',
    '| Phiên bản | CR | Ngày | Nội dung | Người duyệt |',
    '|---|---|---|---|---|',
    `| v1 | — | ${viDate(req.createdAt)} | Phiên bản đầu tiên | — |`,
    ...crs.map(c => `| v${c.baselineTo} | ${c.id} | ${viDate(c.decidedAt ?? c.createdAt)} | ${tcell([c.title, c.impactSummary].filter(Boolean).join(': '))} | ${tcell(who(c.decidedBy))} |`),
  ].join('\n');
}

/**
 * Puts the generated change-history section at the end of the PHỤ LỤC chapter (before the next H1, or at the end),
 * replacing any "Lịch sử thay đổi" section Claude wrote. Fenced code is not scanned for headings.
 */
export function withChangeHistory(md: string, section: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const norm = (s: string): string => s.normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
  const level = (l: string): { lvl: number; text: string } | undefined => {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(l);
    return m ? { lvl: m[1]!.length, text: norm(m[2]!.replace(/^\d+(\.\d+)*\.?\s+/, '')) } : undefined;
  };
  const heads: { i: number; lvl: number; text: string }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = fence ? undefined : level(l);
    if (h) heads.push({ i, ...h });
  });
  // Drop Claude's own section(s).
  const drop = new Set<number>();
  heads.forEach((h, k) => {
    if (h.lvl !== 2 || h.text !== norm(CHANGE_HISTORY_HEADING)) return;
    const end = heads.slice(k + 1).find(x => x.lvl <= 2)?.i ?? lines.length;
    for (let i = h.i; i < end; i++) drop.add(i);
  });
  const keptIdx = lines.map((_, i) => i).filter(i => !drop.has(i));
  const appendixAt = heads.find(h => h.lvl === 1 && h.text === norm('PHỤ LỤC') && !drop.has(h.i));
  const nextH1 = appendixAt ? heads.find(h => h.lvl === 1 && h.i > appendixAt.i && !drop.has(h.i)) : undefined;
  const insertBefore = nextH1?.i ?? lines.length;
  const before = keptIdx.filter(i => i < insertBefore).map(i => lines[i]!);
  const after = keptIdx.filter(i => i >= insertBefore).map(i => lines[i]!);
  while (before.length && !before[before.length - 1]!.trim()) before.pop();
  return [...before, '', section, '', ...after].join('\n');
}

export async function design(ctx: StageContext): Promise<StageOutcome> {
  const { ws, req, repo } = ctx;
  const dir = join(ws.devflowDir, 'design');
  mkdirSync(dir, { recursive: true });
  const files = { stack: join(dir, 'tech-stack.md'), tkct: join(dir, 'tkct.md'), tkdb: join(dir, 'tkdb.md') };
  const all = repo.listFeatures(req.id).filter(f => f.kind === 'function');
  const fns = all.filter(f => f.scopeStatus === 'active');
  if (!fns.length) return { kind: 'fail', error: 'Chưa có danh sách chức năng — hãy chạy lại giai đoạn BREAKDOWN.' };
  const cancelled = all.filter(f => f.scopeStatus === 'cancelled');
  const featureList = [
    ...fns.map(f => `- ${f.code} - ${f.name}: ${f.description}`),
    ...cancelled.map(f => `- ${f.code} - ${f.name}: ĐÃ HỦY${f.changedByCr ? ` theo ${f.changedByCr}` : ''} — không thiết kế thêm`),
  ].join('\n');

  const prompt = buildPrompt('architect', { ...contextFileVars(ctx), feature_list: featureList }, promptExtras(ctx, [
    { path: files.stack, description: 'Lựa chọn công nghệ (markdown, theo dàn ý tech-stack.md).' },
    { path: files.tkct, description: 'Tài liệu thiết kế chi tiết TKCT (markdown, đúng dàn ý TKCT, không đánh số tiêu đề).' },
    { path: files.tkdb, description: 'Tài liệu thiết kế cơ sở dữ liệu TKDB (markdown, đúng dàn ý TKDB, không đánh số tiêu đề).' },
    { path: join(dir, '<ten-so-do>.mmd'), description: 'Mỗi sơ đồ mermaid một file .mmd (tối thiểu: mô hình tổng thể, luồng dữ liệu nghiệp vụ, mô hình quan hệ dữ liệu).' },
  ]));

  // A fresh run starts from empty outputs; a rejected run (feedback) lets Claude revise the existing ones.
  // After accepted CRs the existing documents are updated in place, never discarded.
  const clean = ctx.feedback || isIncremental(ctx) ? [] : [...Object.values(files), ...readdirSync(dir).filter(n => n.endsWith('.mmd')).map(n => join(dir, n))];
  const r = await runClaudeStep(ctx, {
    prompt,
    clean,
    validate: async () => {
      await readTextOutput(files.stack, 10);
      const tkct = await readTextOutput(files.tkct, 50);
      const tkdb = await readTextOutput(files.tkdb, 50);
      const errs: string[] = [];
      for (const h of missingHeadings(tkct, TKCT_HEADINGS)) errs.push(`tkct.md thiếu tiêu đề "${h}"`);
      for (const h of missingHeadings(tkdb, TKDB_HEADINGS)) errs.push(`tkdb.md thiếu tiêu đề "${h}"`);
      const h2 = headings(tkct, 2);
      for (const f of fns) {
        if (!h2.some(h => headingHasCode(h, f.code))) errs.push(`tkct.md thiếu phần thiết kế chi tiết "## ${f.code} - ${f.name}"`);
      }
      if (!readdirSync(dir).some(n => n.endsWith('.mmd'))) errs.push(`chưa có file sơ đồ .mmd nào trong ${dir}`);
      if (errs.length) throw new OutputError(`Tài liệu thiết kế chưa đạt:\n- ${errs.join('\n- ')}`);
      return { tkct, tkdb };
    },
  });
  if (!r.ok) return { kind: 'fail', error: r.error };

  const tkctOut = join(ws.artifactsDir, artifactName('TKCT', ctx.ws.key, ctx.baseline));
  const tkdbOut = join(ws.artifactsDir, artifactName('TKDB', ctx.ws.key, ctx.baseline));
  const history = changeHistoryMarkdown(repo, req.id);
  await renderDocx(templatePath(ctx.cfg, 'tkct'), history ? withChangeHistory(r.value.tkct, history) : r.value.tkct, tkctOut, ws.trustRoot);
  await renderDocx(templatePath(ctx.cfg, 'tkdb'), r.value.tkdb, tkdbOut, ws.trustRoot);
  ctx.log(`Đã xuất ${tkctOut} và ${tkdbOut}`);

  if (existsSync(join(ws.repoDir, '.git'))) {
    const branch = integrationBranch(ctx.ws.key);
    await ensureOnBranch(ctx, branch);
    // Only docs/devflow is committed: build outputs left by the scan must not land on the branch.
    const committed = await ctx.git.commitPaths([ctx.ws.docsRel], `docs(devflow): ${req.id} phân tích, bóc tách và thiết kế`);
    const pushed = committed && (await pushIfRemote(ctx, branch));
    ctx.log(committed ? `Đã commit tài liệu lên nhánh ${branch}${pushed ? ' và push lên GitLab' : ' (chưa có remote, không push)'}` : 'Tài liệu không thay đổi, không cần commit');
  } else {
    ctx.log('Workspace chưa có repo git — bỏ qua commit tài liệu', 'warn');
  }
  return { kind: 'next' };
}
