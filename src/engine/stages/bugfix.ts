import { join } from 'node:path';
import type { BugRow } from '../../domain/types.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { prepareIntegration, projectGitLab, readFlowState, updateFlowState, workBranch } from './common.js';
import { developAndReview } from './dev-review.js';

/** A bug may be fixed at most this many times; the next attempt goes to a human (spec §3). */
export const MAX_FIX_ATTEMPTS = 3;
export const NEEDS_HUMAN_LABEL = 'needs-human';

function bugAssignment(ctx: StageContext, bug: BugRow, attempt: number): string {
  const { req, repo, ws } = ctx;
  const tc = repo.getTestCase(req.id, bug.tcId);
  const st = readFlowState(ws);
  const last = st.runs[bug.tcId]?.at(-1);
  return [
    `**Sửa lỗi test case ${bug.tcId} (lần sửa ${attempt}/${MAX_FIX_ATTEMPTS})**`,
    '',
    `- Mục đích: ${tc?.purpose ?? ''}`,
    `- Dữ liệu test: ${tc?.data || '(không có)'}`,
    `- Các bước:\n\n${(tc?.steps ?? '').split(/\r?\n/).map(l => `  ${l}`).join('\n')}\n`,
    `- Kết quả mong đợi: ${tc?.expected ?? ''}`,
    `- Kết quả thực tế lần kiểm thử ${last?.run ?? '?'}: ${last?.real_result || '(không ghi)'}`,
    `- Ghi chú của Tester: ${last?.comment || '(không có)'}`,
    `- Evidence: ${last?.evidence.length ? last.evidence.map(e => `\`${join(ws.artifactsDir, ...e.split('/'))}\``).join(', ') : '(không có)'}`,
    st.issueUrls[bug.tcId] ? `- Issue: ${st.issueUrls[bug.tcId]}` : '',
    '',
    attempt > 1 ? `Đây là lần sửa thứ ${attempt}: các lần trước chưa sửa được. Đọc lại lịch sử commit trên nhánh tích hợp, tìm nguyên nhân gốc thật sự.` : '',
    'Nếu lỗi do test case/evidence sai chứ không phải do code (ví dụ thiếu evidence), vẫn kiểm tra kỹ code; nếu code đúng thì bổ sung test tự động chứng minh hành vi đúng và ghi rõ trong file tóm tắt.',
  ].filter(l => l !== '').join('\n');
}

/**
 * BUGFIX: one bug per job run. A bug starting a new attempt gets fix_attempts += 1; any open bug that would exceed
 * MAX_FIX_ATTEMPTS stops the request (label needs-human on its issue, outcome needs_human). The fix goes through
 * Developer (systematic-debugging) → Reviewer → merge on devflow/<REQ>/fix-<TC>; the issue gets "Đã sửa lần N".
 * More bugs → goto BUGFIX; none left → goto TEST.
 */
export async function bugfix(ctx: StageContext): Promise<StageOutcome> {
  const { repo, req, ws } = ctx;
  const gl = projectGitLab(ctx);
  // Bugs of test cases cancelled by a change request are not fixed (normally already closed by the CR).
  const cancelled = new Set(repo.listTestCases(req.id).filter(tc => tc.scopeStatus === 'cancelled').map(tc => tc.id));
  const bugs = repo.listBugs(req.id).filter(b => (b.status === 'open' || b.status === 'fixing') && !cancelled.has(b.tcId));
  if (!bugs.length) {
    ctx.log('Không còn bug cần sửa → kiểm thử lại');
    return { kind: 'goto', stage: 'TEST' };
  }

  const over = bugs.filter(b => b.status === 'open' && b.fixAttempts + 1 > MAX_FIX_ATTEMPTS);
  if (over.length) {
    for (const b of over) {
      if (gl && b.gitlabIid) {
        await gl.client.updateIssue(gl.pid, b.gitlabIid, { add_labels: NEEDS_HUMAN_LABEL });
        await gl.client.addIssueNote(gl.pid, b.gitlabIid, `DevFlow đã sửa ${b.fixAttempts} lần nhưng test case vẫn Fail. Cần người xử lý.`);
      }
      repo.upsertBug(req.id, { ...b, status: 'needs_human' });
    }
    const ids = over.map(b => b.tcId).join(', ');
    return { kind: 'needs_human', reason: `Bug đã sửa quá ${MAX_FIX_ATTEMPTS} lần mà vẫn lỗi: ${ids}. Cần người xử lý${gl ? ` (issue đã gắn label ${NEEDS_HUMAN_LABEL})` : ''}.` };
  }

  const base = await prepareIntegration(ctx);
  let bug = bugs.find(b => b.status === 'fixing') ?? bugs[0]!;
  const branch = workBranch(ctx.ws.key, `fix-${bug.tcId}`);
  if (bug.status === 'open') {
    bug = { ...bug, fixAttempts: bug.fixAttempts + 1, status: 'fixing' };
    repo.upsertBug(req.id, bug);
    await ctx.git.resetBranch(branch, base); // a new attempt starts from the current integration branch
  } else if (await ctx.git.branchExists(branch)) {
    await ctx.git.checkout(branch);
  } else {
    await ctx.git.checkout(branch, true, base);
  }
  const attempt = bug.fixAttempts;
  const key = `fix-${bug.tcId}-a${attempt}`;
  ctx.log(`Sửa lỗi ${bug.tcId} lần ${attempt} trên nhánh ${branch}`);
  const st = readFlowState(ws);

  const r = await developAndReview(ctx, {
    key, kind: `bản sửa lỗi ${bug.tcId} (lần ${attempt})`, branch, base, assignment: bugAssignment(ctx, bug, attempt),
    skill: 'systematic-debugging', mrTitle: `[${req.id}][${bug.tcId}] Sửa lỗi lần ${attempt}`,
    rounds: st.reviewRounds[key] ?? 0, saveRounds: n => updateFlowState(ws, s => { s.reviewRounds[key] = n; }),
    mrIid: st.mrIids?.[key] ?? null, saveMr: iid => updateFlowState(ws, s => { (s.mrIids ??= {})[key] = iid; }),
  });
  if (r.kind === 'fail') return r;
  if (r.kind === 'needs_human') return { kind: 'needs_human', reason: `Bug ${bug.tcId}: ${r.reason}` };

  repo.upsertBug(req.id, { ...bug, status: 'fixed' });
  updateFlowState(ws, s => { s.lastFixSeq = ++s.clock; }); // TEST retests this TC, and regression-tests earlier passes
  if (gl && bug.gitlabIid) await gl.client.addIssueNote(gl.pid, bug.gitlabIid, `Đã sửa lần ${attempt}${r.mrUrl ? ` (MR ${r.mrUrl})` : ''}. Chờ kiểm thử lại.`);
  const left = repo.listBugs(req.id).filter(b => b.status === 'open' || b.status === 'fixing').length;
  return left ? { kind: 'goto', stage: 'BUGFIX' } : { kind: 'goto', stage: 'TEST' };
}
