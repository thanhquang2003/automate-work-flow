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
  DOCS_PATHSPEC, contextFileVars, designFile, ensureOnBranch, fileRef, integrationBranch, promptExtras, pushIfRemote, sortedTestCases, tcSheetRow, updateFlowState,
  testCaseXlsxName,
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

function checkPlan(tasks: TaskOut[], tcs: TestCaseOut[], fns: FeatureRow[]): void {
  const errs: string[] = [];
  const fById = new Map(fns.map(f => [f.id, f]));
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
    if (!tasks.some(t => t.feature_id === f.id)) errs.push(`chức năng ${f.id} (${f.code}) chưa có task nào`);
    if (!tcs.some(tc => tc.feature_id === f.id)) errs.push(`chức năng ${f.id} (${f.code}) chưa có test case nào`);
  }
  if (errs.length) throw new OutputError(`Kế hoạch chưa đạt:\n- ${errs.join('\n- ')}`);
}

export async function planning(ctx: StageContext): Promise<StageOutcome> {
  const { ws, req, repo } = ctx;
  const fns = repo.listFeatures(req.id).filter(f => f.kind === 'function');
  if (!fns.length) return { kind: 'fail', error: 'Chưa có danh sách chức năng — hãy chạy lại giai đoạn BREAKDOWN.' };
  const files = { tasks: join(ws.devflowDir, 'tasks.json'), tcs: join(ws.devflowDir, 'testcases.json') };

  const prompt = buildPrompt('planner', {
    ...contextFileVars(ctx),
    feature_list: fns.map(f => `- ${f.id} — ${f.code} — ${f.name}`).join('\n'),
    tkct_file: fileRef(designFile(ctx.ws, 'tkct.md'), '(chưa có TKCT)'),
    tkdb_file: fileRef(designFile(ctx.ws, 'tkdb.md'), '(chưa có TKDB)'),
  }, promptExtras(ctx, [
    { path: files.tasks, description: 'Danh sách task phát triển có phụ thuộc.', example: TASKS_EXAMPLE },
    { path: files.tcs, description: 'Danh sách test case (trạng thái để trống).', example: TESTCASES_EXAMPLE },
  ]));

  const r = await runClaudeStep(ctx, {
    prompt,
    clean: ctx.feedback ? [] : Object.values(files),
    validate: async () => {
      const { tasks } = await readJsonOutput(files.tasks, TasksOut);
      const { test_cases } = await readJsonOutput(files.tcs, TestCasesOut);
      checkPlan(tasks, test_cases, fns);
      return { tasks, test_cases };
    },
  });
  if (!r.ok) return { kind: 'fail', error: r.error };

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

  const out = join(ws.artifactsDir, testCaseXlsxName(req.id));
  await writeTestCases(templatePath(ctx.cfg, 'testcase'), sortedTestCases(repo, req.id).map(tcSheetRow), out);
  ctx.log(`Đã lập ${taskRows.length} task, ${tcRows.length} test case; xuất ${out}`);

  if (existsSync(join(ws.repoDir, '.git'))) {
    const branch = integrationBranch(req.id);
    await ensureOnBranch(ctx, branch);
    const committed = await ctx.git.commitPaths([DOCS_PATHSPEC], `docs(devflow): ${req.id} kế hoạch task và test case`);
    if (committed) await pushIfRemote(ctx, branch);
  }
  return { kind: 'next' };
}
