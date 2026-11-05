import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { TasksOut, TestCasesOut, type FeatureRow, type TaskRow, type TestCaseRow } from '../../domain/types.js';
import { writeTestCases } from '../../office/testcase-xlsx.js';
import { templatePath } from '../../office/templates.js';
import { buildPrompt } from '../prompt.js';
import type { StageContext, StageOutcome } from '../pipeline.js';
import { OutputError, readJsonOutput, runClaudeStep } from './claude-json.js';
import {
  DOCS_PATHSPEC, artifactName, contextFileVars, crResponsible, designFile, ensureOnBranch, fileRef, integrationBranch, isIncremental, promptExtras,
  pushIfRemote, sortedTestCases, tcSheetRow, updateFlowState,
} from './common.js';

type TaskOut = z.infer<typeof TasksOut>['tasks'][number];
type TestCaseOut = z.infer<typeof TestCasesOut>['test_cases'][number];

const TASKS_EXAMPLE = {
  tasks: [
    { id: 'T-01', title: 'Khởi tạo dự án và migration bảng ORDERS', feature_id: 'F-01', depends_on: [] },
    { id: 'T-02', title: 'API danh sách đơn hàng có lọc và phân trang', feature_id: 'F-01', depends_on: ['T-01'] },
  ],
};
const TESTCASES_EXAMPLE = {
  test_cases: [
    { id: 'TC-QLDH_DS-01', feature_id: 'F-01', purpose: 'Lọc đơn hàng theo trạng thái', data: 'Có 3 đơn: 2 "Mới", 1 "Đã giao"', steps: '1. Đăng nhập bằng tài khoản nhân viên\n2. Mở màn hình Đơn hàng\n3. Chọn trạng thái "Mới"', expected: 'Hiển thị đúng 2 đơn trạng thái "Mới"' },
  ],
};


/** Tasks sorted so that every task comes after its dependencies (ties by id). Throws on unknown deps or cycles. */
export function orderTasks<T extends { id: string; dependsOn: string[] }>(tasks: T[]): T[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const out: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (t: T, path: string[]): void => {
    const st = state.get(t.id);
    if (st === 'done') return;
    if (st === 'visiting') throw new Error(`phụ thuộc vòng: ${[...path, t.id].join(' → ')}`);
    state.set(t.id, 'visiting');
    for (const d of [...t.dependsOn].sort()) {
      const dep = byId.get(d);
      if (!dep) throw new Error(`${t.id} phụ thuộc task không tồn tại ${d}`);
      visit(dep, [...path, t.id]);
    }
    state.set(t.id, 'done');
    out.push(t);
  };
  for (const t of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) visit(t, []);
  return out;
}

/**
 * `fns`: functions every one of which needs an (active) task and test case; `known`: every feature a task/TC may
 * reference (cancelled ones included, for cancelled rows kept after a change request).
 */
function checkPlan(tasks: TaskOut[], tcs: TestCaseOut[], fns: FeatureRow[], known: FeatureRow[] = fns): void {
  const errs: string[] = [];
  const fById = new Map(known.map(f => [f.id, f]));
  const taskIds = new Set<string>();
  if (!tasks.length) errs.push('tasks.json chưa có task nào');
  for (const t of tasks) {
    if (!/^T-\d{2,}$/.test(t.id)) errs.push(`task id "${t.id}" phải có dạng T-01`);
    if (taskIds.has(t.id)) errs.push(`task ${t.id} bị trùng id`);
    taskIds.add(t.id);
    if (!fById.has(t.feature_id)) errs.push(`task ${t.id}: feature_id "${t.feature_id}" không có trong danh sách chức năng`);
  }
  try {
    orderTasks(tasks.map(t => ({ id: t.id, dependsOn: t.depends_on })));
  } catch (e) {
    errs.push(`tasks.json: ${(e as Error).message}`);
  }
  const tcIds = new Set<string>();
  for (const tc of tcs) {
    if (tcIds.has(tc.id)) errs.push(`test case ${tc.id} bị trùng id`);
    tcIds.add(tc.id);
    const f = fById.get(tc.feature_id);
    if (!f) { errs.push(`test case ${tc.id}: feature_id "${tc.feature_id}" không có trong danh sách chức năng`); continue; }
    if (!new RegExp(`^TC-${f.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{2,}$`).test(tc.id)) errs.push(`test case ${tc.id}: id phải có dạng TC-${f.code}-NN`);
  }
  for (const f of fns) {
    if (!tasks.some(t => t.feature_id === f.id && t.scope_status === 'active')) errs.push(`chức năng ${f.id} (${f.code}) chưa có task nào`);
    if (!tcs.some(tc => tc.feature_id === f.id && tc.scope_status === 'active')) errs.push(`chức năng ${f.id} (${f.code}) chưa có test case nào`);
  }
  if (errs.length) throw new OutputError(`Kế hoạch chưa đạt:\n- ${errs.join('\n- ')}`);
}

const tcContent = (t: Pick<TestCaseRow, 'featureId' | 'purpose' | 'data' | 'steps' | 'expected'>): string => JSON.stringify([t.featureId, t.purpose, t.data, t.steps, t.expected]);
const taskOut = (t: TaskRow): TaskOut => ({ id: t.id, title: t.title, feature_id: t.featureId ?? '', depends_on: t.dependsOn, scope_status: t.scopeStatus });
const tcOut = (t: TestCaseRow): TestCaseOut => ({ id: t.id, feature_id: t.featureId ?? '', purpose: t.purpose, data: t.data, steps: t.steps, expected: t.expected, scope_status: t.scopeStatus });

/**
 * Incremental PLANNING (after accepted CRs): Claude's lists are merged into the existing rows instead of replacing them.
 * - existing task: status/branch/MR/review rounds kept (a done task stays done unless the CR sent it back to todo);
 * - existing TC: run history (status1/2, result, evidence, comment, baseline) kept; a changed content resets its baseline
 *   so TEST re-runs it;
 * - changed_by_cr kept unless Claude changed scope_status (or a TC's content), then set to the responsible CR; new rows
 *   record the responsible CR; a row cancelled earlier is never reactivated;
 * - rows Claude omitted are kept, never deleted (with a warning).
 */
export function mergePlan(ctx: StageContext, tasks: TaskOut[], tcs: TestCaseOut[]): { tasks: TaskRow[]; tcs: TestCaseRow[]; cancelledTcs: string[] } {
  const { repo, req } = ctx;
  const prevT = new Map(repo.listTasks(req.id).map(t => [t.id, t]));
  const prevC = new Map(repo.listTestCases(req.id).map(t => [t.id, t]));
  const keepCancelled = (id: string, old: { scopeStatus: string; changedByCr: string | null }, wanted: string): boolean => {
    if (old.scopeStatus !== 'cancelled') return false;
    if (wanted !== 'cancelled') ctx.log(`${id} đã bị hủy${old.changedByCr ? ` theo ${old.changedByCr}` : ''}, giữ trạng thái hủy (phần việc làm lại phải dùng id mới)`, 'warn');
    return true;
  };
  // Rows of a cancelled feature are cancelled with it, whatever Claude wrote.
  const cancelledFeature = new Map(repo.listFeatures(req.id).filter(f => f.scopeStatus === 'cancelled').map(f => [f.id, f]));
  const forced = <S extends string>(featureId: string | null, id: string, scope: S): S | 'cancelled' => {
    const f = featureId ? cancelledFeature.get(featureId) : undefined;
    if (!f) return scope;
    if (scope !== 'cancelled') ctx.log(`${id} thuộc chức năng ${f.id} đã hủy${f.changedByCr ? ` theo ${f.changedByCr}` : ''}: ép trạng thái hủy`, 'warn');
    return 'cancelled';
  };
  const taskRows: TaskRow[] = tasks.map(t => {
    const old = prevT.get(t.id);
    const sc = forced(t.feature_id, t.id, t.scope_status);
    const cr = (): string | null => (sc !== t.scope_status ? cancelledFeature.get(t.feature_id ?? '')?.changedByCr : undefined) ?? crResponsible(ctx, 'task', t.id) ?? null;
    const base = { id: t.id, title: t.title, featureId: t.feature_id, dependsOn: t.depends_on, scopeStatus: sc };
    if (!old) return { ...base, status: 'todo', reviewRounds: 0, branch: null, mrIid: null, changedByCr: cr() };
    if (keepCancelled(t.id, old, sc)) return { ...old, ...base, scopeStatus: 'cancelled' };
    const changedByCr = sc !== old.scopeStatus ? (cr() ?? old.changedByCr) : old.changedByCr;
    return { ...old, ...base, changedByCr };
  });
  const cancelledTcs: string[] = [];
  const tcRows: TestCaseRow[] = tcs.map(t => {
    const old = prevC.get(t.id);
    const sc = forced(t.feature_id, t.id, t.scope_status);
    const cr = (): string | null => (sc !== t.scope_status ? cancelledFeature.get(t.feature_id ?? '')?.changedByCr : undefined) ?? crResponsible(ctx, 'test_case', t.id) ?? null;
    const base = { id: t.id, featureId: t.feature_id, purpose: t.purpose, data: t.data, steps: t.steps, expected: t.expected, scopeStatus: sc };
    if (!old) {
      return { ...base, status1: null, status2: null, realResult: null, evidence: [], comment: null, baseline: null, changedByCr: cr() };
    }
    if (keepCancelled(t.id, old, sc)) return { ...old, ...base, scopeStatus: 'cancelled' };
    const scopeChanged = sc !== old.scopeStatus;
    if (scopeChanged && sc === 'cancelled') cancelledTcs.push(t.id);
    const contentChanged = tcContent(base) !== tcContent(old);
    const changedByCr = scopeChanged || contentChanged ? (cr() ?? old.changedByCr) : old.changedByCr;
    return { ...old, ...base, changedByCr, baseline: contentChanged ? null : old.baseline };
  });
  const seenT = new Set(tasks.map(t => t.id));
  const seenC = new Set(tcs.map(t => t.id));
  const omitted = [...[...prevT.keys()].filter(id => !seenT.has(id)), ...[...prevC.keys()].filter(id => !seenC.has(id))];
  if (omitted.length) ctx.log(`Kế hoạch mới thiếu ${omitted.join(', ')} — giữ nguyên các mục này (không xóa khi cập nhật theo thay đổi)`, 'warn');
  return {
    tasks: [...taskRows, ...[...prevT.values()].filter(t => !seenT.has(t.id))],
    tcs: [...tcRows, ...[...prevC.values()].filter(t => !seenC.has(t.id))],
    cancelledTcs,
  };
}

export async function planning(ctx: StageContext): Promise<StageOutcome> {
  const { ws, req, repo } = ctx;
  const incremental = isIncremental(ctx);
  const allFns = repo.listFeatures(req.id).filter(f => f.kind === 'function');
  const fns = allFns.filter(f => f.scopeStatus === 'active');
  if (!fns.length) return { kind: 'fail', error: 'Chưa có danh sách chức năng — hãy chạy lại giai đoạn BREAKDOWN.' };
  const cancelledFns = allFns.filter(f => f.scopeStatus === 'cancelled');
  const files = { tasks: join(ws.devflowDir, 'tasks.json'), tcs: join(ws.devflowDir, 'testcases.json') };

  const prompt = buildPrompt('planner', {
    ...contextFileVars(ctx),
    feature_list: [
      ...fns.map(f => `- ${f.id} — ${f.code} — ${f.name}`),
      ...cancelledFns.map(f => `- ${f.id} — ${f.code} — ${f.name} (ĐÃ HỦY${f.changedByCr ? ` theo ${f.changedByCr}` : ''}: task/test case của chức năng này đánh dấu "scope_status": "cancelled")`),
    ].join('\n'),
    tkct_file: fileRef(designFile(ctx.ws, 'tkct.md'), '(chưa có TKCT)'),
    tkdb_file: fileRef(designFile(ctx.ws, 'tkdb.md'), '(chưa có TKDB)'),
  }, promptExtras(ctx, [
    { path: files.tasks, description: 'Danh sách task phát triển có phụ thuộc.', example: TASKS_EXAMPLE },
    { path: files.tcs, description: 'Danh sách test case (trạng thái để trống).', example: TESTCASES_EXAMPLE },
  ]));

  const r = await runClaudeStep(ctx, {
    prompt,
    // After accepted CRs Claude updates the existing plan files in place.
    clean: ctx.feedback || incremental ? [] : Object.values(files),
    validate: async () => {
      const { tasks } = await readJsonOutput(files.tasks, TasksOut);
      const { test_cases } = await readJsonOutput(files.tcs, TestCasesOut);
      if (incremental) {
        // Rows Claude omits are kept, so the plan is checked as it will be stored.
        const seenT = new Set(tasks.map(t => t.id));
        const seenC = new Set(test_cases.map(t => t.id));
        const keptT = repo.listTasks(req.id).filter(t => !seenT.has(t.id)).map(taskOut);
        const keptC = repo.listTestCases(req.id).filter(t => !seenC.has(t.id)).map(tcOut);
        checkPlan([...tasks, ...keptT], [...test_cases, ...keptC], fns, allFns);
      } else {
        checkPlan(tasks, test_cases, fns);
      }
      return { tasks, test_cases };
    },
  });
  if (!r.ok) return { kind: 'fail', error: r.error };

  if (incremental) {
    const m = mergePlan(ctx, r.value.tasks, r.value.test_cases);
    repo.tx(() => {
      for (const t of m.tasks) repo.upsertTask(req.id, t);
      for (const t of m.tcs) repo.upsertTestCase(req.id, t);
      for (const id of m.cancelledTcs) {
        const bug = repo.getBug(req.id, id);
        const cr = repo.getTestCase(req.id, id)?.changedByCr;
        if (bug && bug.status !== 'closed') repo.upsertBug(req.id, { ...bug, fixAttempts: 0, status: 'closed', note: `Đóng do ${cr ?? 'thay đổi yêu cầu'}` });
      }
    });
    const out = join(ws.artifactsDir, artifactName('TestCase', req.id, ctx.baseline));
    await writeTestCases(templatePath(ctx.cfg, 'testcase'), sortedTestCases(repo, req.id).map(tcSheetRow), out);
    const active = <T extends { scopeStatus: string }>(xs: T[]): number => xs.filter(x => x.scopeStatus === 'active').length;
    ctx.log(`Đã cập nhật kế hoạch: ${active(m.tasks)} task, ${active(m.tcs)} test case còn hiệu lực (giữ lịch sử kiểm thử); xuất ${out}`);
    await commitPlan(ctx);
    return { kind: 'next' };
  }

  const taskRows: TaskRow[] = r.value.tasks.map(t => ({
    id: t.id, title: t.title, featureId: t.feature_id, dependsOn: t.depends_on, status: 'todo', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: t.scope_status, changedByCr: null,
  }));
  const tcRows: TestCaseRow[] = r.value.test_cases.map(t => ({
    id: t.id, featureId: t.feature_id, purpose: t.purpose, data: t.data, steps: t.steps, expected: t.expected,
    status1: null, status2: null, realResult: null, evidence: [], comment: null,
    scopeStatus: t.scope_status, changedByCr: null, baseline: null,
  }));
  repo.replaceTasks(req.id, taskRows);
  repo.replaceTestCases(req.id, tcRows);
  // New test cases: earlier test history, issue links and bugs no longer apply.
  repo.clearBugs(req.id);
  updateFlowState(ws, s => { s.runs = {}; s.issueUrls = {}; s.bugSynced = {}; s.lastFixSeq = 0; });

  const out = join(ws.artifactsDir, artifactName('TestCase', req.id, ctx.baseline));
  await writeTestCases(templatePath(ctx.cfg, 'testcase'), sortedTestCases(repo, req.id).map(tcSheetRow), out);
  ctx.log(`Đã lập ${taskRows.length} task, ${tcRows.length} test case; xuất ${out}`);
  await commitPlan(ctx);
  return { kind: 'next' };
}

async function commitPlan(ctx: StageContext): Promise<void> {
  const { ws, req } = ctx;
  if (existsSync(join(ws.repoDir, '.git'))) {
    const branch = integrationBranch(req.id);
    await ensureOnBranch(ctx, branch);
    const committed = await ctx.git.commitPaths([DOCS_PATHSPEC], `docs(devflow): ${req.id} kế hoạch task và test case`);
    if (committed) await pushIfRemote(ctx, branch);
  }
}
