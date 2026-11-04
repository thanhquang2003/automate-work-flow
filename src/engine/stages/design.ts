import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderDocx } from '../../office/docx.js';
import { templatePath } from '../../office/templates.js';
import { buildPrompt } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { OutputError, readTextOutput, runClaudeStep } from './claude-json.js';
import { contextFileVars, ensureOnBranch, integrationBranch, pushIfRemote, promptExtras } from './common.js';

const TKCT_H1 = ['TỔNG QUAN', 'THIẾT KẾ TỔNG THỂ', 'THIẾT KẾ CHI TIẾT', 'PHỤ LỤC'];
const TKCT_H2 = ['Tổng quan dự án', 'Yêu cầu chức năng', 'Yêu cầu phi chức năng', 'Yêu cầu hiệu năng', 'Mô hình tổng thể', 'Danh sách kết nối', 'Thiết kế giao tiếp', 'Cơ sở dữ liệu', 'Sơ đồ luồng dữ liệu nghiệp vụ', 'Câu hỏi mở và giả định'];
const TKDB_H1 = ['GIỚI THIỆU', 'CƠ SỞ DỮ LIỆU', 'Script rollback'];
const TKDB_H2 = ['Mục tiêu tài liệu', 'Mô tả chung', 'Các mô hình quan hệ dữ liệu', 'Danh sách bảng'];

/** Heading texts of a level, normalised (numbering prefix stripped, case/space folded). */
function headings(md: string, level: number): string[] {
  const re = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`, 'gm');
  return [...md.matchAll(re)].map(m => norm(m[1]!.replace(/^\d+(\.\d+)*\.?\s+/, '')));
}
const norm = (s: string): string => s.normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();

function missingHeadings(md: string, level: number, wanted: string[]): string[] {
  const have = headings(md, level);
  return wanted.filter(w => !have.includes(norm(w)));
}

export async function design(ctx: StageContext): Promise<StageOutcome> {
  const { ws, req, repo } = ctx;
  const dir = join(ws.devflowDir, 'design');
  mkdirSync(dir, { recursive: true });
  const files = { stack: join(dir, 'tech-stack.md'), tkct: join(dir, 'tkct.md'), tkdb: join(dir, 'tkdb.md') };
  const fns = repo.listFeatures(req.id).filter(f => f.kind === 'function');
  if (!fns.length) return { kind: 'fail', error: 'Chưa có danh sách chức năng — hãy chạy lại giai đoạn BREAKDOWN.' };
  const featureList = fns.map(f => `- ${f.code} - ${f.name}: ${f.description}`).join('\n');

  const prompt = buildPrompt('architect', { ...contextFileVars(ctx), feature_list: featureList }, promptExtras(ctx, [
    { path: files.stack, description: 'Lựa chọn công nghệ (markdown, theo dàn ý tech-stack.md).' },
    { path: files.tkct, description: 'Tài liệu thiết kế chi tiết TKCT (markdown, đúng dàn ý TKCT, không đánh số tiêu đề).' },
    { path: files.tkdb, description: 'Tài liệu thiết kế cơ sở dữ liệu TKDB (markdown, đúng dàn ý TKDB, không đánh số tiêu đề).' },
    { path: join(dir, '<ten-so-do>.mmd'), description: 'Mỗi sơ đồ mermaid một file .mmd (tối thiểu: mô hình tổng thể, luồng dữ liệu nghiệp vụ, mô hình quan hệ dữ liệu).' },
  ]));

  const r = await runClaudeStep(ctx, {
    prompt,
    validate: async () => {
      await readTextOutput(files.stack, 10);
      const tkct = await readTextOutput(files.tkct, 50);
      const tkdb = await readTextOutput(files.tkdb, 50);
      const errs: string[] = [];
      for (const h of missingHeadings(tkct, 1, TKCT_H1)) errs.push(`tkct.md thiếu tiêu đề cấp 1 "# ${h}"`);
      for (const h of missingHeadings(tkct, 2, TKCT_H2)) errs.push(`tkct.md thiếu tiêu đề cấp 2 "## ${h}"`);
      for (const h of missingHeadings(tkdb, 1, TKDB_H1)) errs.push(`tkdb.md thiếu tiêu đề cấp 1 "# ${h}"`);
      for (const h of missingHeadings(tkdb, 2, TKDB_H2)) errs.push(`tkdb.md thiếu tiêu đề cấp 2 "## ${h}"`);
      const h2 = headings(tkct, 2);
      for (const f of fns) {
        const code = norm(f.code);
        if (!h2.some(h => h === code || (h.startsWith(code) && /^[\s:\-–—]/.test(h.slice(code.length))))) errs.push(`tkct.md thiếu phần thiết kế chi tiết "## ${f.code} - ${f.name}"`);
      }
      if (!readdirSync(dir).some(n => n.endsWith('.mmd'))) errs.push(`chưa có file sơ đồ .mmd nào trong ${dir}`);
      if (errs.length) throw new OutputError(`Tài liệu thiết kế chưa đạt:\n- ${errs.join('\n- ')}`);
      return { tkct, tkdb };
    },
  });
  if (!r.ok) return { kind: 'fail', error: r.error };

  const tkctOut = join(ws.artifactsDir, `TKCT_${req.id}.docx`);
  const tkdbOut = join(ws.artifactsDir, `TKDB_${req.id}.docx`);
  await renderDocx(templatePath(ctx.cfg, 'tkct'), r.value.tkct, tkctOut);
  await renderDocx(templatePath(ctx.cfg, 'tkdb'), r.value.tkdb, tkdbOut);
  ctx.log(`Đã xuất ${tkctOut} và ${tkdbOut}`);

  if (existsSync(join(ws.repoDir, '.git'))) {
    const branch = integrationBranch(req.id);
    await ensureOnBranch(ctx, branch);
    const committed = await ctx.git.commitAll(`docs(devflow): ${req.id} phân tích, bóc tách và thiết kế`);
    const pushed = committed && (await pushIfRemote(ctx, branch));
    ctx.log(committed ? `Đã commit tài liệu lên nhánh ${branch}${pushed ? ' và push lên GitLab' : ' (chưa có remote, không push)'}` : 'Tài liệu không thay đổi, không cần commit');
  } else {
    ctx.log('Workspace chưa có repo git — bỏ qua commit tài liệu', 'warn');
  }
  return { kind: 'next' };
}
