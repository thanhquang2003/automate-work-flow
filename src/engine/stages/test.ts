import { safeRemove } from '../safe-fs.js';
import { extname, join } from 'node:path';
import { TestResultsOut, type SoftwareType, type TestCaseRow } from '../../domain/types.js';
import { writeTestCases } from '../../office/testcase-xlsx.js';
import { templatePath } from '../../office/templates.js';
import { copyEvidence, hasEvidence, safeTcId, validateResults, type TestResult } from '../evidence.js';
import { buildPrompt } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { MAX_SCHEMA_RETRIES, OutputError, readJsonOutput, runClaudeStep } from './claude-json.js';
import {
  artifactName, codebaseMapPath, designFile, fileRef, prepareIntegration, projectGitLab, promptExtras, pushIfRemote, readFlowState, sortedTestCases,
  tcSheetRow, writeFlowState, type FlowState, type ProjectGitLab, type TestRun,
} from './common.js';

const RESULTS_EXAMPLE = {
  results: [
    { tc_id: 'TC-QLDH_DS-01', status: 'P', real_result: 'Hiển thị đúng 2 đơn trạng thái "Mới"', evidence: ['<evidence_dir>/TC-QLDH_DS-01/01-loc-trang-thai.png'], comment: '' },
    { tc_id: 'TC-QLDH_DS-02', status: 'PE', real_result: '', evidence: [], comment: 'thiếu môi trường mobile' },
  ],
};

const TYPE_LABEL: Record<SoftwareType, string> = { web: 'Web', mobile: 'Mobile', api: 'API', background: 'Tiến trình ngầm' };
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export const resultsPath = (ctx: StageContext): string => join(ctx.ws.devflowDir, 'test-results.json');
export const latestRun = (s: FlowState, tcId: string): TestRun | undefined => s.runs[tcId]?.at(-1);

/**
 * Baseline a TC's latest run was made at: the run's own record, else the DB column, else 1 (runs recorded before
 * change requests existed all belong to the first baseline).
 */
export const runBaseline = (tc: Pick<TestCaseRow, 'baseline'>, r: TestRun): number => r.baseline ?? tc.baseline ?? 1;

/** True when the TC has a result at the current baseline (any status). */
export const hasCurrentResult = (tc: Pick<TestCaseRow, 'baseline'>, r: TestRun | undefined, baseline: number): boolean =>
  !!r && runBaseline(tc, r) >= baseline;

/** Test case comment: tester's latest comment, then "Lần N: X" for runs 3+, then the bug link. */
function composeComment(runs: TestRun[], bugLine: string | undefined): string | null {
  const last = runs.at(-1);
  const lines: string[] = [];
  if (last?.comment.trim()) lines.push(last.comment.trim());
  for (const r of runs) if (r.run >= 3) lines.push(`Lần ${r.run}: ${r.status}`);
  if (bugLine) lines.push(bugLine);
  return lines.length ? lines.join('\n') : null;
}

function mobileEnv(): string {
  const h = process.env.ANDROID_HOME?.trim();
  return h
    ? `có (ANDROID_HOME=${h}) — kiểm thử giao diện mobile bằng emulator`
    : 'không có (ANDROID_HOME chưa được đặt) — phần giao diện mobile đánh dấu PE với comment "thiếu môi trường mobile"';
}

/** Runs the Tester on the given test cases; returns evidence-validated results. */
async function runTester(ctx: StageContext, branch: string, targets: TestCaseRow[], state: FlowState) {
  const { ws, req } = ctx;
  const out = resultsPath(ctx);
  const runNo = (id: string): number => (state.runs[id]?.length ?? 0) + 1;
  for (const tc of targets) safeRemove(join(ws.evidenceDir, tc.id), undefined, { recursive: true });
  const nums = targets.map(t => runNo(t.id));
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const prompt = buildPrompt('tester', {
    run_label: lo === hi ? String(lo) : `${lo}–${hi}`,
    branch,
    targets: targets.map(t => `- \`${t.id}\` — ${t.purpose} (lần chạy thứ ${runNo(t.id)}; evidence: \`${join(ws.evidenceDir, t.id)}\`)`).join('\n'),
    devflow_dir: ws.devflowDir,
    tkct_file: fileRef(designFile(ws, 'tkct.md'), '(không có)'),
    codebase_map: fileRef(codebaseMapPath(ws), '(không có — dự án mới)'),
    evidence_dir: ws.evidenceDir,
    software_types: req.softwareTypes.length ? req.softwareTypes.map(t => TYPE_LABEL[t] ?? t).join(', ') : '(không ghi)',
    mobile_env: mobileEnv(),
  }, promptExtras(ctx, [{ path: out, description: 'Kết quả kiểm thử của từng test case được giao.', example: RESULTS_EXAMPLE }]));

  let attempt = 0;
  return runClaudeStep(ctx, {
    prompt,
    clean: [out],
    validate: async () => {
      attempt++;
      const { results } = await readJsonOutput(out, TestResultsOut);
      const want = new Set(targets.map(t => t.id));
      const seen = new Set<string>();
      const errs: string[] = [];
      for (const r of results) {
        if (!want.has(r.tc_id)) errs.push(`${r.tc_id}: không thuộc danh sách test case được giao`);
        if (seen.has(r.tc_id)) errs.push(`${r.tc_id}: có nhiều hơn một kết quả`);
        seen.add(r.tc_id);
      }
      for (const id of want) if (!seen.has(id)) errs.push(`${id}: thiếu kết quả`);
      if (errs.length) throw new OutputError(`File ${out} chưa đạt:\n- ${errs.join('\n- ')}`);
      // Ask the Tester to redo P without evidence / PE without reason before DevFlow downgrades them.
      const bad = results.filter(r => (r.status === 'P' && !hasEvidence(ws.evidenceDir, r.tc_id)) || (r.status === 'PE' && !r.comment.trim()));
      if (bad.length && attempt <= MAX_SCHEMA_RETRIES) {
        throw new OutputError([
          'Các test case sau chưa hợp lệ (P bắt buộc có ít nhất một file evidence trong thư mục của nó; PE bắt buộc ghi lý do ở comment):',
          ...bad.map(r => `- ${r.tc_id} (${r.status}): ${r.status === 'P' ? `thư mục ${join(ws.evidenceDir, r.tc_id)} chưa có file nào` : 'comment trống'}`),
          'Hãy chạy lại các test case này và lưu evidence, hoặc ghi đúng trạng thái (F, hoặc PE kèm lý do). Nếu vẫn thiếu, DevFlow sẽ hạ thành F.',
        ].join('\n'));
      }
      return results;
    },
  });
}

function issueDescription(ctx: StageContext, gl: ProjectGitLab, tc: TestCaseRow, run: TestRun, evidenceMd: string): string {
  const { req } = ctx;
  const branch = `devflow/${req.id}`;
  const mrs = ctx.repo.listTasks(req.id).filter(t => t.mrIid).map(t => `- ${t.id}: ${gl.webUrl ? `${gl.webUrl}/-/merge_requests/${t.mrIid}` : `!${t.mrIid}`}`);
  return [
    `**Yêu cầu:** ${req.id} — ${req.title}`,
    `**Test case:** ${tc.id} — ${tc.purpose}`,
    `**Lần kiểm thử:** ${run.run}`,
    '',
    '## Bước tái hiện',
    '',
    tc.data.trim() ? `Dữ liệu test: ${tc.data}\n` : '',
    tc.steps,
    '',
    '## Kết quả mong đợi',
    '',
    tc.expected,
    '',
    '## Kết quả thực tế',
    '',
    run.real_result || '(Tester không ghi)',
    run.comment ? `\nGhi chú của Tester: ${run.comment}` : '',
    '',
    '## Evidence',
    '',
    evidenceMd || '(không có)',
    run.evidence.length ? `\nFile evidence trong gói kết quả: ${run.evidence.map(e => `\`${e}\``).join(', ')}` : '',
    '',
    '## Liên kết',
    '',
    `- Nhánh tích hợp: ${gl.webUrl ? `${gl.webUrl}/-/tree/${branch}` : branch}`,
    ...(mrs.length ? ['- MR của các task:', ...mrs] : []),
  ].join('\n');
}

/** Uploads the first evidence image (or the first file) and returns its markdown. */
async function uploadEvidence(ctx: StageContext, gl: ProjectGitLab, run: TestRun): Promise<string> {
  const file = run.evidence.find(e => IMAGE_EXT.has(extname(e).toLowerCase())) ?? run.evidence[0];
  if (!file) return '';
  const up = await gl.client.uploadFile(gl.pid, join(ctx.ws.artifactsDir, ...file.split('/')));
  return up.markdown;
}

/**
 * F → create the bug (GitLab issue when available) or reopen/annotate it. P/PE → close an open bug.
 * The bug row and issue URL are persisted right after the issue is created, so a later failure never duplicates it.
 */
async function syncBug(ctx: StageContext, gl: ProjectGitLab | undefined, tc: TestCaseRow, run: TestRun, state: FlowState): Promise<void> {
  const { repo, req, ws } = ctx;
  const bug = repo.getBug(req.id, tc.id);
  if (run.status === 'F') {
    if (!bug) {
      let iid: number | null = null;
      if (gl) {
        const md = await uploadEvidence(ctx, gl, run);
        const title = `[${req.id}][${tc.id}] ${tc.purpose}`.slice(0, 250);
        const is = await gl.client.createIssue(gl.pid, { title, description: issueDescription(ctx, gl, tc, run, md), labels: ['bug', 'devflow', req.id] });
        iid = is.iid;
        repo.upsertBug(req.id, { tcId: tc.id, gitlabIid: iid, fixAttempts: 0, status: 'open' });
        state.issueUrls[tc.id] = is.web_url;
        writeFlowState(ws, state);
        ctx.log(`Đã tạo issue ${is.web_url} cho ${tc.id}`);
        return;
      }
      repo.upsertBug(req.id, { tcId: tc.id, gitlabIid: iid, fixAttempts: 0, status: 'open' });
      return;
    }
    if (gl && bug.gitlabIid) {
      if (bug.status === 'closed') await gl.client.updateIssue(gl.pid, bug.gitlabIid, { state_event: 'reopen' });
      const md = await uploadEvidence(ctx, gl, run);
      await gl.client.addIssueNote(gl.pid, bug.gitlabIid, [`Kiểm thử lại lần ${run.run}: **F** (Fail)`, '', `Thực tế: ${run.real_result || '(không ghi)'}`, run.comment ? `Ghi chú: ${run.comment}` : '', md].filter(Boolean).join('\n'));
    }
    repo.upsertBug(req.id, { ...bug, status: 'open' });
    return;
  }
  if (bug && bug.status !== 'closed') {
    if (gl && bug.gitlabIid) {
      await gl.client.addIssueNote(gl.pid, bug.gitlabIid, `Kiểm thử lại lần ${run.run}: **${run.status}**${run.status === 'P' ? ' (Pass)' : ` (Pending: ${run.comment})`} — đóng issue.`);
      await gl.client.updateIssue(gl.pid, bug.gitlabIid, { state_event: 'close' });
    }
    repo.upsertBug(req.id, { ...bug, status: 'closed' });
    ctx.log(`Đóng bug ${tc.id} (${run.status})`);
  }
}

function bugLine(ctx: StageContext, tcId: string, state: FlowState): string | undefined {
  const bug = ctx.repo.getBug(ctx.req.id, tcId);
  if (!bug) return undefined;
  const url = state.issueUrls[tcId];
  if (url) return `Bug: ${url}`;
  return `Bug: ghi nhận trong DevFlow (chưa kết nối GitLab), đã sửa ${bug.fixAttempts} lần`;
}

/**
 * Idempotent: brings bugs/issues and the DB rows of ALL test cases in line with the run history in flow-state.
 * Bug sync happens once per run (FlowState.bugSynced); DB rows are rewritten every time.
 */
async function reconcile(ctx: StageContext, gl: ProjectGitLab | undefined, all: TestCaseRow[], state: FlowState): Promise<void> {
  const { repo, req, ws } = ctx;
  for (const tc of all) {
    const runs = state.runs[tc.id];
    const last = runs?.at(-1);
    if (!runs || !last) continue;
    if ((state.bugSynced[tc.id] ?? 0) < last.run) {
      await syncBug(ctx, gl, tc, last, state);
      state.bugSynced[tc.id] = last.run;
      writeFlowState(ws, state);
    }
    repo.updateTestCase(req.id, tc.id, {
      status1: runs[0]!.status, status2: runs.length >= 2 ? last.status : null, realResult: last.real_result || null,
      evidence: last.evidence, comment: composeComment(runs, bugLine(ctx, tc.id, state)),
      ...(last.baseline !== undefined ? { baseline: last.baseline } : {}),
    });
  }
}

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'e2e', 'spec']);
const TEST_FILE_RES = [/\.(test|spec)\.[^/]+$/i, /Test\.java$/, /^test_[^/]*\.py$/, /_test\.(go|py)$/];

/**
 * Paths the Tester may change: docs/devflow/**, anything under a test directory (test/, tests/, __tests__/, e2e/,
 * spec/, src/test/…) and test files by name (*.test.*, *.spec.*, *Test.java, test_*.py, *_test.go, *_test.py).
 */
export function isTesterPath(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (p === 'docs/devflow' || p.startsWith('docs/devflow/')) return true;
  const segs = p.split('/');
  const file = segs.pop() ?? '';
  return segs.some(d => TEST_DIRS.has(d.toLowerCase())) || TEST_FILE_RES.some(re => re.test(file));
}

/**
 * Commits only the Tester's own output (see isTesterPath). Other changes to tracked files are reverted; other new
 * files (not in the pre-run `baseline` of untracked files) are left in place, uncommitted, with a warning.
 */
async function commitTesterOutput(ctx: StageContext, baseline: string[], msg: string): Promise<boolean> {
  const before = new Set(baseline);
  const tracked = await ctx.git.changedTracked();
  const created = (await ctx.git.untracked()).filter(p => !before.has(p));
  const revert = tracked.filter(p => !isTesterPath(p));
  const stray = created.filter(p => !isTesterPath(p));
  const list = (xs: string[]): string => xs.slice(0, 20).join(', ') + (xs.length > 20 ? ` … (+${xs.length - 20})` : '');
  if (revert.length) {
    await ctx.git.restore(revert);
    ctx.log(`Tester đã sửa file ngoài phạm vi kiểm thử; đã hoàn tác: ${list(revert)}`, 'warn');
  }
  if (stray.length) ctx.log(`Tester tạo file ngoài phạm vi kiểm thử; không commit (vẫn để trong workspace): ${list(stray)}`, 'warn');
  return ctx.git.commitPaths([...tracked, ...created].filter(isTesterPath), msg);
}

/**
 * Bugs closed by an accepted CR (note "Đóng do CR-NN", see applyAcceptedChange) have their GitLab issue closed here,
 * once (FlowState.crClosedIssues), with the note as explanation.
 */
async function closeCrIssues(ctx: StageContext, gl: ProjectGitLab | undefined, state: FlowState): Promise<void> {
  if (!gl) return;
  const done = new Set(state.crClosedIssues ?? []);
  for (const b of ctx.repo.listBugs(ctx.req.id)) {
    const key = `${b.tcId}@${b.note ?? ''}`;
    if (b.status !== 'closed' || !b.note || !b.gitlabIid || done.has(key)) continue;
    await gl.client.addIssueNote(gl.pid, b.gitlabIid, `${b.note} (yêu cầu thay đổi đã được chấp nhận) — đóng issue.`);
    await gl.client.updateIssue(gl.pid, b.gitlabIid, { state_event: 'close' });
    done.add(key);
    state.crClosedIssues = [...done];
    writeFlowState(ctx.ws, state);
    ctx.log(`Đóng issue của ${b.tcId}: ${b.note}`);
  }
}

type Plan = { kind: 'test'; targets: TestCaseRow[]; regression: boolean } | { kind: 'bugfix'; failing: string[] } | { kind: 'done' };

/**
 * What TEST does next, from the run history of the ACTIVE test cases (cancelled ones are never tested):
 * - TCs never run or without a result at the current baseline (a CR changed the request since), and F TCs with a
 *   merge after their last run (or whose bug is parked for a human) → test them;
 * - else F TCs without a new fix (e.g. a rerun after a crash) → BUGFIX without re-testing;
 * - else something was merged into the integration branch (bug fix, task or feedback item) after the last run of
 *   some P TC → one regression run of every non-PE TC;
 * - else done.
 */
function plan(ctx: StageContext, all: TestCaseRow[], state: FlowState): Plan {
  const last = (id: string): TestRun | undefined => latestRun(state, id);
  const fixedSince = (r: TestRun): boolean => state.lastFixSeq > r.seq;
  const retest = all.filter(tc => {
    const r = last(tc.id);
    if (!r || !hasCurrentResult(tc, r, ctx.baseline)) return true;
    return r.status === 'F' && (fixedSince(r) || ctx.repo.getBug(ctx.req.id, tc.id)?.status === 'needs_human');
  });
  if (retest.length) return { kind: 'test', targets: retest, regression: false };
  const failing = all.filter(tc => last(tc.id)?.status === 'F').map(tc => tc.id);
  if (failing.length) return { kind: 'bugfix', failing };
  if (all.some(tc => { const r = last(tc.id); return r?.status === 'P' && fixedSince(r); })) {
    return { kind: 'test', targets: all.filter(tc => last(tc.id)?.status !== 'PE'), regression: true };
  }
  return { kind: 'done' };
}

/**
 * TEST on devflow/<REQ>. First reconciles DB rows and bugs from the saved run history (idempotent after a crash),
 * then runs the Tester on the planned TCs (see plan()). Evidence rules are enforced, evidence copied to
 * artifacts/evidence/<TC>/, run 1 → status1, run 2 → status2, run 3+ → status2 overwritten and "Lần N: X" appended
 * to the comment. F → bug/issue, then BUGFIX; a fix merged after a P → full regression run (goto TEST);
 * all P/PE → DONE.
 */
export async function test(ctx: StageContext): Promise<StageOutcome> {
  const { ws, req, repo } = ctx;
  const all = sortedTestCases(repo, req.id);
  const active = all.filter(tc => tc.scopeStatus === 'active');
  if (!active.length) return { kind: 'fail', error: 'Chưa có test case còn hiệu lực — hãy chạy lại giai đoạn PLANNING.' };
  const bad = all.find(tc => !safeTcId(tc.id));
  if (bad) return { kind: 'fail', error: `Mã test case không hợp lệ: ${bad.id}` };
  const branch = await prepareIntegration(ctx);
  const state = readFlowState(ws);
  const gl = projectGitLab(ctx);

  await closeCrIssues(ctx, gl, state);
  await reconcile(ctx, gl, all, state);
  let p = plan(ctx, active, state);

  if (p.kind === 'test') {
    const { targets, regression } = p;
    if (regression) ctx.log(`Đã có thay đổi được merge vào nhánh tích hợp sau lần kiểm thử trước → kiểm thử hồi quy ${targets.length} test case`);
    const baseline = await ctx.git.untracked();
    const r = await runTester(ctx, branch, targets, state);
    if (!r.ok) return { kind: 'fail', error: `Tester: ${r.error}` };
    const results: TestResult[] = validateResults(r.value, ws.evidenceDir);
    for (const res of results) {
      const runs = (state.runs[res.tc_id] ??= []);
      runs.push({
        run: runs.length + 1, seq: ++state.clock, status: res.status, real_result: res.real_result, comment: res.comment,
        evidence: copyEvidence(ws.evidenceDir, ws.artifactsDir, res.tc_id), baseline: ctx.baseline,
      });
    }
    writeFlowState(ws, state); // the results are the checkpoint: a rerun reconciles instead of re-testing
    const counts = (['P', 'F', 'PE'] as const).map(s => `${s}=${results.filter(x => x.status === s).length}`).join(', ');
    ctx.log(`Kết quả kiểm thử${regression ? ' hồi quy' : ''}: ${counts}`);
    await reconcile(ctx, gl, all, state);
    const runLabel = [...new Set(targets.map(t => state.runs[t.id]!.length))].join(',');
    if (await commitTesterOutput(ctx, baseline, `test(devflow): ${req.id} kết quả kiểm thử lần ${runLabel}`)) await pushIfRemote(ctx, branch);
    p = plan(ctx, active, state);
  }
  const tcOut = join(ws.artifactsDir, artifactName('TestCase', ctx.ws.key, ctx.baseline));
  await writeTestCases(templatePath(ctx.cfg, 'testcase'), sortedTestCases(repo, req.id).map(tcSheetRow), tcOut, ws.trustRoot);

  if (p.kind === 'bugfix') {
    ctx.log(`Còn ${p.failing.length} test case F: ${p.failing.join(', ')} → sửa lỗi`, 'warn');
    return { kind: 'goto', stage: 'BUGFIX' };
  }
  if (p.kind === 'test') return { kind: 'goto', stage: 'TEST' }; // regression run as its own job (checkpoint)
  ctx.log('Tất cả test case đã P/PE');
  return { kind: 'goto', stage: 'DONE' };
}
