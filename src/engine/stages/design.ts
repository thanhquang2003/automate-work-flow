import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderDocx } from '../../office/docx.js';
import { templatePath } from '../../office/templates.js';
import { buildPrompt } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { OutputError, readTextOutput, runClaudeStep } from './claude-json.js';
import {
  DOCS_PATHSPEC, contextFileVars, ensureOnBranch, headingHasCode, headings, integrationBranch, missingHeadings, promptExtras, pushIfRemote,
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

  // A fresh run starts from empty outputs; a rejected run (feedback) lets Claude revise the existing ones.
  const clean = ctx.feedback ? [] : [...Object.values(files), ...readdirSync(dir).filter(n => n.endsWith('.mmd')).map(n => join(dir, n))];
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

  const tkctOut = join(ws.artifactsDir, `TKCT_${req.id}.docx`);
  const tkdbOut = join(ws.artifactsDir, `TKDB_${req.id}.docx`);
  await renderDocx(templatePath(ctx.cfg, 'tkct'), r.value.tkct, tkctOut);
  await renderDocx(templatePath(ctx.cfg, 'tkdb'), r.value.tkdb, tkdbOut);
  ctx.log(`Đã xuất ${tkctOut} và ${tkdbOut}`);

  if (existsSync(join(ws.repoDir, '.git'))) {
    const branch = integrationBranch(req.id);
    await ensureOnBranch(ctx, branch);
    // Only docs/devflow is committed: build outputs left by the scan must not land on the branch.
    const committed = await ctx.git.commitPaths([DOCS_PATHSPEC], `docs(devflow): ${req.id} phân tích, bóc tách và thiết kế`);
    const pushed = committed && (await pushIfRemote(ctx, branch));
    ctx.log(committed ? `Đã commit tài liệu lên nhánh ${branch}${pushed ? ' và push lên GitLab' : ' (chưa có remote, không push)'}` : 'Tài liệu không thay đổi, không cần commit');
  } else {
    ctx.log('Workspace chưa có repo git — bỏ qua commit tài liệu', 'warn');
  }
  return { kind: 'next' };
}
