import type { TaskRow } from '../../domain/types.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { integrationBranch, prepareIntegration, readFlowState, updateFlowState, workBranch } from './common.js';
import { developAndReview, type WorkItem } from './dev-review.js';
import { orderTasks } from './planning.js';

function taskAssignment(ctx: StageContext, t: TaskRow, all: TaskRow[]): string {
  const f = t.featureId ? ctx.repo.listFeatures(ctx.req.id).find(x => x.id === t.featureId) : undefined;
  const tcs = ctx.repo.listTestCases(ctx.req.id).filter(tc => tc.featureId === t.featureId && tc.scopeStatus === 'active').map(tc => tc.id);
  const others = all.filter(x => x.id !== t.id && x.scopeStatus === 'active');
  return [
    `**Task ${t.id} — ${t.title}**`,
    '',
    `- Chức năng: ${f ? `${f.id} ${f.code} — ${f.name} (phần "${f.code} - ${f.name}" trong THIẾT KẾ CHI TIẾT của TKCT)` : '(không gắn chức năng)'}`,
    `- Phụ thuộc (đã merge vào nhánh tích hợp): ${t.dependsOn.length ? t.dependsOn.join(', ') : 'không'}`,
    `- Test case liên quan (phải qua được khi Tester chạy): ${tcs.length ? tcs.join(', ') : '(không có)'}`,
    '',
    'Chỉ làm phần của task này. Các task khác của yêu cầu (không làm ở đây):',
    '',
    ...(others.length ? others.map(x => `- ${x.id} — ${x.title} [${x.status}]`) : ['(không có)']),
  ].join('\n');
}

function feedbackAssignment(feedback: string): string {
  return [
    '**Xử lý nhận xét của người duyệt sau giai đoạn phát triển**',
    '',
    'Tất cả task đã được merge vào nhánh tích hợp. Người duyệt yêu cầu chỉnh sửa như sau (bắt buộc xử lý hết):',
    '',
    feedback.trim(),
  ].join('\n');
}

/** Every merge into devflow/<REQ> moves the merge clock: a TC passed before it gets a regression run (spec §4.4). */
export function recordMerge(ctx: StageContext): void {
  updateFlowState(ctx.ws, s => { s.lastFixSeq = ++s.clock; });
}

const isOpen = (t: TaskRow): boolean => t.scopeStatus === 'active' && t.status !== 'done';

/**
 * DEVELOP: only active tasks that are not done (cancelled tasks are skipped), one task per job run, in dependency order — task branch devflow/<REQ>/<TASK> from devflow/<REQ>,
 * Developer → Reviewer loop (≤ 3 rounds) → merge; then `goto DEVELOP` until every task is done, then `next` (gate).
 * A gate rejection (feedback) after all tasks are done runs one extra feedback work item.
 */
export async function develop(ctx: StageContext): Promise<StageOutcome> {
  const { repo, req } = ctx;
  const tasks = repo.listTasks(req.id);
  if (!tasks.length) return { kind: 'fail', error: 'Chưa có task phát triển — hãy chạy lại giai đoạn PLANNING.' };
  let ordered: TaskRow[];
  try {
    ordered = orderTasks(tasks);
  } catch (e) {
    return { kind: 'fail', error: `Danh sách task không hợp lệ: ${(e as Error).message}` };
  }
  const base = await prepareIntegration(ctx);
  const task = ordered.find(isOpen);

  if (!task) {
    if (!ctx.feedback) {
      ctx.log('Tất cả task đã hoàn thành');
      return { kind: 'next' };
    }
    const st = readFlowState(ctx.ws);
    const key = `feedback-${(st.feedbackItems ?? 0) + 1}`;
    const branch = workBranch(req.id, key);
    await startBranch(ctx, branch, base);
    const item: WorkItem = {
      key, kind: `chỉnh sửa theo nhận xét (${key})`, branch, base, assignment: feedbackAssignment(ctx.feedback),
      skill: 'test-driven-development', mrTitle: `[${req.id}] Chỉnh sửa theo nhận xét người duyệt (${key})`,
      rounds: st.reviewRounds[key] ?? 0,
      saveRounds: k => updateFlowState(ctx.ws, s => { s.reviewRounds[key] = k; }),
      mrIid: st.mrIids?.[key] ?? null,
      saveMr: iid => updateFlowState(ctx.ws, s => { (s.mrIids ??= {})[key] = iid; }),
    };
    const r = await developAndReview(ctx, item);
    if (r.kind === 'fail') return r;
    if (r.kind === 'needs_human') return { kind: 'needs_human', reason: r.reason };
    updateFlowState(ctx.ws, s => { s.feedbackItems = (s.feedbackItems ?? 0) + 1; });
    recordMerge(ctx);
    return { kind: 'next' };
  }

  // A task sent back to todo by a change request was merged before: redo it on a fresh branch (-v<baseline>) from the
  // current integration branch, with a new MR, instead of the old, already merged one.
  const reopened = task.status === 'todo' && task.branch !== null;
  const branch = reopened || !task.branch ? workBranch(req.id, reopened ? `${task.id}-v${ctx.baseline}` : task.id) : task.branch;
  const key = branch.slice(integrationBranch(req.id).length + 1) || task.id;
  const mrIid = reopened ? null : task.mrIid;
  if (reopened) ctx.log(`Task ${task.id} được làm lại theo thay đổi yêu cầu${task.changedByCr ? ` ${task.changedByCr}` : ''} trên nhánh mới ${branch}`);
  let rounds = task.reviewRounds;
  if (task.status === 'needs_human') {
    // Rerun after a human looked at it: give the task a fresh set of review rounds on the same branch.
    rounds = 0;
    ctx.log(`Task ${task.id} chạy lại sau khi cần can thiệp: đặt lại số vòng review`, 'warn');
  }
  await startBranch(ctx, branch, base);
  repo.updateTask(req.id, task.id, { status: 'in_progress', branch, reviewRounds: rounds, mrIid });
  ctx.log(`Bắt đầu task ${task.id} — ${task.title} trên nhánh ${branch}`);

  const r = await developAndReview(ctx, {
    key, kind: `task ${task.id}`, branch, base, assignment: taskAssignment(ctx, task, ordered),
    skill: 'test-driven-development', mrTitle: `[${req.id}][${task.id}] ${task.title}`,
    rounds, saveRounds: n => repo.updateTask(req.id, task.id, { reviewRounds: n }),
    mrIid, saveMr: iid => repo.updateTask(req.id, task.id, { mrIid: iid }),
  });
  if (r.kind === 'fail') return r;
  if (r.kind === 'needs_human') {
    repo.updateTask(req.id, task.id, { status: 'needs_human' });
    return { kind: 'needs_human', reason: `Task ${task.id}: ${r.reason}` };
  }
  repo.updateTask(req.id, task.id, { status: 'done' });
  recordMerge(ctx);
  const left = ordered.filter(t => t.id !== task.id && isOpen(t)).length;
  ctx.log(`Hoàn thành task ${task.id}${left ? `, còn ${left} task` : ''}`);
  return left ? { kind: 'goto', stage: 'DEVELOP' } : { kind: 'next' };
}

/** Checks out an existing work branch (resume), or creates it from the integration branch. */
async function startBranch(ctx: StageContext, branch: string, base: string): Promise<void> {
  if (await ctx.git.branchExists(branch)) await ctx.git.checkout(branch);
  else await ctx.git.checkout(branch, true, base);
}
