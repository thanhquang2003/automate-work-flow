import { existsSync, mkdirSync } from 'node:fs';
import { safeWriteFile } from '../safe-fs.js';
import { join } from 'node:path';
import type { z } from 'zod';
import { ReviewOut } from '../../domain/types.js';
import type { Git } from '../../gitlab/git.js';
import { buildPrompt } from '../prompt.js';
import type { StageContext } from '../pipeline.js';
import { OutputError, readJsonOutput, readTextOutput, runClaudeStep } from './claude-json.js';
import {
  codebaseMapPath, designFile, fileRef, projectGitLab, promptExtras, pushIfRemote, scratchDir, type ProjectGitLab,
} from './common.js';

export const MAX_REVIEW_ROUNDS = 3;

export type Review = z.infer<typeof ReviewOut>;
const BLOCKING = new Set(['critical', 'major', 'blocker']);

/** A review only counts as approved when it says so and has no blocking (critical/major) comment. */
export const isApproved = (r: Review): boolean => r.approved && !r.comments.some(c => BLOCKING.has(c.severity.trim().toLowerCase()));

const REVIEW_EXAMPLE = {
  approved: false,
  comments: [{ file: 'src/orders/service.ts', line: 42, severity: 'major', body: 'Chưa kiểm tra quyền truy cập đơn hàng của người dùng khác; thêm kiểm tra owner trước khi trả dữ liệu.' }],
};

/** One unit of code work (a task or a bug fix) taken through Developer → push/MR → Reviewer → merge. */
export interface WorkItem {
  /** File-safe key: scratch files, review files (T-01, fix-TC-X-01-a2). */
  key: string;
  /** Prompt wording: "task T-01" / "bản sửa lỗi TC-X-01". */
  kind: string;
  branch: string;
  base: string;
  /** Markdown description of what to do. */
  assignment: string;
  skill: 'test-driven-development' | 'systematic-debugging';
  mrTitle: string;
  /** Review rounds already done (persisted by the caller). */
  rounds: number;
  saveRounds(n: number): void;
  mrIid: number | null;
  saveMr(iid: number): void;
  /**
   * v3 task worktrees: the integration branch is checked out in the request worktree, so the merge runs there
   * (this git), serialized per request by `serializeMerge`.
   */
  mergeGit?: Git;
  serializeMerge?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type LoopResult =
  | { kind: 'merged'; mrIid?: number; mrUrl?: string }
  | { kind: 'needs_human'; reason: string }
  | { kind: 'fail'; error: string };

const SKILL_NOTE: Record<WorkItem['skill'], string> = {
  'test-driven-development': 'Viết test thất bại trước (RED), xác nhận nó fail đúng lý do, rồi mới viết code tối thiểu cho test qua (GREEN), sau đó refactor. Mỗi hành vi trong thiết kế/test case có test tương ứng.',
  'systematic-debugging': 'Tìm nguyên nhân gốc trước khi sửa: tái hiện lỗi theo test case, đọc evidence, khoanh vùng, đặt giả thuyết và kiểm chứng. Viết test tái hiện lỗi (fail) trước, sửa nguyên nhân gốc (không vá triệu chứng), rồi chạy lại toàn bộ test.',
};

export function formatReview(w: Pick<WorkItem, 'kind'>, round: number, r: Review): string {
  const ok = isApproved(r);
  const lines = [`### Review ${w.kind} — vòng ${round}/${MAX_REVIEW_ROUNDS}: ${ok ? 'ĐẠT' : 'CHƯA ĐẠT'}`, ''];
  if (!r.comments.length) lines.push('Không có nhận xét.');
  else {
    lines.push('| Mức độ | File | Dòng | Nhận xét |', '|---|---|---|---|');
    const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    for (const c of r.comments) lines.push(`| ${cell(c.severity)} | ${cell(c.file)} | ${c.line ?? ''} | ${cell(c.body)} |`);
  }
  return lines.join('\n') + '\n';
}

function feedbackSection(prev: Review | undefined, round: number): string {
  if (!prev) return '';
  return [
    `## Nhận xét của Reviewer ở vòng ${round - 1} (BẮT BUỘC xử lý hết trước khi kết thúc)`,
    '',
    ...prev.comments.map(c => `- [${c.severity}] \`${c.file}${c.line ? `:${c.line}` : ''}\` — ${c.body}`),
    '',
    'Sửa từng điểm trên nhánh hiện tại; điểm nào không đồng ý thì giải thích lý do trong file tóm tắt.',
  ].join('\n');
}

async function readReview(path: string): Promise<Review | undefined> {
  if (!existsSync(path)) return undefined;
  try { return await readJsonOutput(path, ReviewOut); } catch { return undefined; }
}

async function ensureMr(ctx: StageContext, gl: ProjectGitLab, w: WorkItem, description: string): Promise<{ iid: number; web_url: string }> {
  await pushIfRemote(ctx, w.branch);
  const found = await gl.client.findOpenMR(gl.pid, w.branch, w.base);
  const mr = found ?? (await gl.client.createMR(gl.pid, { source: w.branch, target: w.base, title: w.mrTitle, description }));
  if (!found) ctx.log(`Đã mở MR ${mr.web_url}`);
  w.mrIid = mr.iid;
  w.saveMr(mr.iid);
  return mr;
}

/**
 * Developer implements on `w.branch` (DevFlow commits the rest, excluding pre-existing untracked files), pushes and
 * opens an MR into `w.base` (GitLab), then the Reviewer reviews. Comments go to the MR (GitLab) or to
 * docs/devflow/reviews/<key>-r<N>.md (local). Not approved → Developer again with the comments, at most
 * MAX_REVIEW_ROUNDS rounds, then needs_human. Approved → merge (GitLab MR merge, or local `merge --no-ff`).
 * Leaves the repo on `w.base`. Resumable: rounds are persisted via `saveRounds`, reviews kept in the scratch dir.
 */
export async function developAndReview(ctx: StageContext, w: WorkItem): Promise<LoopResult> {
  const { ws } = ctx;
  const scratch = scratchDir(ws);
  mkdirSync(scratch, { recursive: true });
  const gl = projectGitLab(ctx);
  const reviewFile = (n: number): string => join(scratch, `review-${w.key}-r${n}.json`);
  const summaryFile = join(scratch, `dev-${w.key}.md`);
  const common = {
    work_kind: w.kind, branch: w.branch, base_branch: w.base, assignment: w.assignment,
    tkct_file: fileRef(designFile(ws, 'tkct.md'), '(không có)'), tkdb_file: fileRef(designFile(ws, 'tkdb.md'), '(không có)'),
    devflow_dir: ws.devflowDir, codebase_map: fileRef(codebaseMapPath(ws), '(không có — dự án mới)'),
  };

  let rounds = w.rounds;
  let last = rounds > 0 ? await readReview(reviewFile(rounds)) : undefined;
  let summary = existsSync(summaryFile) ? await readTextOutput(summaryFile).catch(() => '') : '';

  while (!(last && isApproved(last))) {
    if (rounds >= MAX_REVIEW_ROUNDS) {
      return { kind: 'needs_human', reason: `${w.kind} chưa đạt review sau ${MAX_REVIEW_ROUNDS} vòng (nhánh ${w.branch}). Cần người xem lại nhận xét và xử lý.` };
    }
    const round = rounds + 1;
    if ((await ctx.git.currentBranch()) !== w.branch) await ctx.git.checkout(w.branch);

    // ---- Developer ----
    const baseline = await ctx.git.untracked();
    const devPrompt = buildPrompt('developer', {
      ...common, skill: w.skill, skill_note: SKILL_NOTE[w.skill], scratch_dir: scratch, review_feedback: feedbackSection(last, round),
    }, promptExtras(ctx, [{ path: summaryFile, description: 'Tóm tắt thay đổi (markdown) cho mô tả MR và Reviewer.' }]));
    const dev = await runClaudeStep(ctx, {
      prompt: devPrompt,
      clean: [summaryFile],
      validate: async () => {
        const text = await readTextOutput(summaryFile, 10);
        await ctx.git.commitAll(`${w.mrTitle} (vòng ${round})`, baseline);
        if ((await ctx.git.currentBranch()) !== w.branch) throw new OutputError(`Repo phải ở nhánh ${w.branch}, đừng đổi nhánh.`);
        if ((await ctx.git.aheadCount(w.base, w.branch)) === 0) throw new OutputError(`Nhánh ${w.branch} chưa có thay đổi code nào so với ${w.base}.`);
        return text;
      },
    });
    if (!dev.ok) return { kind: 'fail', error: `Developer (${w.kind}): ${dev.error}` };
    summary = dev.value;

    // ---- push + MR ----
    const mr = gl ? await ensureMr(ctx, gl, w, summary) : undefined;

    // ---- Reviewer ----
    const out = reviewFile(round);
    const prev = last ? `## Nhận xét vòng trước (kiểm tra đã được xử lý)\n\n${formatReview(w, round - 1, last)}` : '';
    const revPrompt = buildPrompt('reviewer', {
      ...common, round: String(round), max_rounds: String(MAX_REVIEW_ROUNDS), dev_summary: `\`${summaryFile}\``, previous_review: prev,
    }, promptExtras(ctx, [{ path: out, description: 'Kết quả review: approved và danh sách nhận xét.', example: REVIEW_EXAMPLE }]));
    // The review runs on the REVIEWER seat of the request (spec v3 §5.4).
    const rev = await runClaudeStep(ctx, { prompt: revPrompt, clean: [out], validate: () => readJsonOutput(out, ReviewOut), seatRole: 'REVIEWER' });
    if (!rev.ok) return { kind: 'fail', error: `Reviewer (${w.kind}): ${rev.error}` };
    if ((await ctx.git.currentBranch()) !== w.branch) await ctx.git.checkout(w.branch);
    last = rev.value;
    rounds = round;
    w.saveRounds(round);

    // ---- publish review ----
    const md = formatReview(w, round, last);
    if (gl && mr) {
      await gl.client.addMRNote(gl.pid, mr.iid, md);
    } else {
      const rel = `${ctx.ws.docsRel}/reviews/${w.key}-r${round}.md`;
      safeWriteFile(join(ws.repoDir, ...rel.split('/')), `# Review ${w.kind}\n\n${md}`);
      await ctx.git.commitPaths([rel], `docs(devflow): review ${w.key} vòng ${round}`);
    }
    ctx.log(`Review ${w.kind} vòng ${round}: ${isApproved(last) ? 'đạt' : `chưa đạt (${last.comments.length} nhận xét)`}`);
  }

  // ---- merge ----
  const target = w.mergeGit ?? ctx.git;
  const onBase = async (): Promise<void> => {
    if (!w.mergeGit) await ctx.git.checkout(w.base);
    else if ((await target.currentBranch()) !== w.base) await target.checkout(w.base);
  };
  const merge = async (): Promise<LoopResult> => {
    if (gl) {
      const mr = w.mrIid ? await gl.client.getMR(gl.pid, w.mrIid) : { ...(await ensureMr(ctx, gl, w, summary)), state: 'opened' };
      // After a crash between mergeMR and the caller's bookkeeping the MR is already merged: do not merge again.
      if (mr.state === 'merged') ctx.log(`MR !${mr.iid} đã được merge trước đó`);
      else await gl.client.mergeMR(gl.pid, mr.iid);
      await onBase();
      await target.pull(w.base);
      ctx.log(`Đã merge MR !${mr.iid} (${w.branch} → ${w.base})`);
      return { kind: 'merged', mrIid: mr.iid, mrUrl: gl.webUrl ? `${gl.webUrl}/-/merge_requests/${mr.iid}` : mr.web_url || undefined };
    }
    await onBase();
    await target.merge(w.branch, `Merge ${w.branch} vào ${w.base}: ${w.mrTitle}`);
    ctx.log(`Đã merge cục bộ ${w.branch} → ${w.base} (không có GitLab)`);
    return { kind: 'merged' };
  };
  return w.serializeMerge ? w.serializeMerge(merge) : merge();
}
