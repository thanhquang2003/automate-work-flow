import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { clearMockHandler } from '../../src/claude/mock.js';
import { clearStages, Pipeline, Workspace } from '../../src/engine/pipeline.js';
import { Worker } from '../../src/engine/worker.js';
import { applyAcceptedChange, impactJsonPath } from '../../src/engine/changes.js';
import {
  artifactName, latestArtifact, readFlowState, writeFlowState, writeJson, writeProjectInfo, type TestRun,
} from '../../src/engine/stages/common.js';
import { changeHistoryMarkdown } from '../../src/engine/stages/design.js';
import type { FeatureRow, ImpactOutT, Question, Stage, TaskRow, TestCaseRow } from '../../src/domain/types.js';
import type { Repo } from '../../src/db/repo.js';
import { setup, mkReq } from './helpers.js';
import { calls, git, initRepo, mockClaude, outputPaths, register, resetCalls, startAt, type Call } from './stage-helpers.js';
import { fakeGitLab } from '../fixtures/fake-gitlab.js';
import { ANALYSIS_MD, TKCT_MD, TKDB_MD } from '../fixtures/mock-claude.js';

// ---------- fixtures ----------

const feature = (id: string, code: string, o: Partial<FeatureRow> = {}): FeatureRow => ({
  id, code, name: `Tên ${code}`, description: `Mô tả ${code}`, typeCode: code === 'PM' ? 'PM' : 'CN_WEB1', unitTest: false, note: '',
  kind: code === 'PM' ? 'nonfunction' : 'function', scopeStatus: 'active', changedByCr: null, ...o,
});
const FEATURES: FeatureRow[] = [feature('F-01', 'DANGNHAP'), feature('F-02', 'BAOCAO'), feature('NF-01', 'PM')];

const task = (id: string, featureId: string, o: Partial<TaskRow> = {}): TaskRow => ({
  id, title: `Task ${id}`, featureId, dependsOn: [], status: 'todo', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: 'active', changedByCr: null, ...o,
});
const tcRow = (id: string, featureId: string, o: Partial<TestCaseRow> = {}): TestCaseRow => ({
  id, featureId, purpose: `Mục đích ${id}`, data: '', steps: '1. Làm', expected: 'Đúng', status1: null, status2: null, realResult: null,
  evidence: [], comment: null, scopeStatus: 'active', changedByCr: null, baseline: null, ...o,
});
const passRun = (seq: number, baseline = 1): TestRun => ({ run: 1, seq, status: 'P', real_result: 'ok', comment: '', evidence: [], baseline });

type Result = { tc_id: string; status: 'P' | 'F' | 'PE'; files?: string[] };
const tester = (evidenceDir: string, runs: Result[][]) => (dir: string) => {
  const i = calls.filter(c => c.role === 'tester').length - 1;
  const rs = runs[Math.min(i, runs.length - 1)]!;
  for (const r of rs) for (const f of r.files ?? []) { mkdirSync(join(evidenceDir, r.tc_id), { recursive: true }); writeFileSync(join(evidenceDir, r.tc_id, f), 'PNG'); }
  writeFileSync(join(dir, 'test-results.json'), JSON.stringify({
    results: rs.map(r => ({ tc_id: r.tc_id, status: r.status, real_result: 'thực tế', comment: r.status === 'PE' ? 'thiếu' : '', evidence: [] })),
  }));
};
const developer = (_dir: string, call: Call) => {
  const n = calls.filter(c => c.role === 'developer').length;
  mkdirSync(join(call.opts.cwd, 'src'), { recursive: true });
  writeFileSync(join(call.opts.cwd, 'src', `code-${n}.txt`), `change ${n}\n`);
  for (const p of outputPaths(call.prompt)) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, `Đã làm xong phần việc lần ${n}\n`); }
};
const reviewer = (_dir: string, call: Call) => {
  const p = outputPaths(call.prompt)[0]!;
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify({ approved: true, comments: [] }));
};

interface Prep { gitlab?: boolean; stubs?: Stage[]; features?: FeatureRow[]; tasks?: TaskRow[]; testCases?: TestCaseRow[] }

function prep(o: Prep = {}) {
  register(o.stubs ?? []);
  const s = setup();
  const r = mkReq(s.repo, { projectKind: o.gitlab ? 'existing' : 'new', gitlabProject: o.gitlab ? 'grp/app' : null, title: 'Bán hàng' });
  const ws = Workspace.for(s.cfg, r.id).ensure();
  const branch = `devflow/${r.id}`;
  let gl: ReturnType<typeof fakeGitLab> | undefined;
  if (o.gitlab) {
    const root = mkdtempSync(join(tmpdir(), 'devflow-remote-'));
    const bare = join(root, 'app.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    const seed = join(root, 'seed');
    initRepo(seed, 'main');
    git(seed, 'push', '-q', bare, 'main');
    git(bare, 'branch', branch, 'main');
    git(root, 'clone', '-q', bare, ws.repoDir);
    git(ws.repoDir, 'checkout', '-q', branch);
    writeProjectInfo(ws, { gitlab: true, projectId: 7, pathWithNamespace: 'grp/app', defaultBranch: 'main', webUrl: 'http://gl/grp/app', branch });
    gl = fakeGitLab(bare);
  } else {
    initRepo(ws.repoDir, branch);
    writeProjectInfo(ws, { gitlab: false, branch });
  }
  s.repo.upsertFeatures(r.id, o.features ?? FEATURES);
  for (const t of o.tasks ?? []) s.repo.upsertTask(r.id, t);
  for (const tc of o.testCases ?? []) s.repo.upsertTestCase(r.id, tc);
  const pipeline = new Pipeline(s.cfg, s.repo, { makeGitLab: () => gl?.client });
  const worker = new Worker(s.cfg, s.repo, pipeline);
  return { ...s, pipeline, worker, r, ws, branch, gl };
}

const EMPTY_IMPACT = {
  summary: 'Tóm tắt tác động', scope: { add: [], modify: [], remove: [] }, affected: { features: [], tasks: [], test_cases: [] },
  questions: [], effort_delta_mh: 8, risks: [], reenter: 'BREAKDOWN' as const,
};

/** Simulates an accepted, finalized CR (as finishChangeDecision does): impact.json, scope applied, baseline bumped. */
function acceptCr(repo: Repo, ws: Workspace, reqId: string, impact: Partial<Omit<ImpactOutT, 'cr_id'>>, title = 'Thêm xuất Excel'): string {
  const cr = repo.createChangeRequest(reqId, { title, description: 'Khách muốn đổi', kind: 'modify', source: 'staff', status: 'accepted' });
  const full: ImpactOutT = { cr_id: cr.id, ...EMPTY_IMPACT, ...impact };
  writeJson(impactJsonPath(ws, cr.id), full);
  mkdirSync(join(ws.devflowDir, 'changes', cr.id), { recursive: true });
  writeFileSync(join(ws.devflowDir, 'changes', cr.id, 'impact.md'), '# Tác động\n');
  const req = repo.getRequest(reqId)!;
  applyAcceptedChange(repo, req, cr, full);
  repo.updateChangeRequest(reqId, cr.id, {
    baselineFrom: req.baselineVersion, baselineTo: req.baselineVersion + 1, decidedAt: Date.UTC(2026, 10, 5, 3), impactSummary: full.summary,
  });
  repo.updateRequest(reqId, { baselineVersion: req.baselineVersion + 1, clarifyRound: 0 });
  return cr.id;
}

async function sheetText(path: string, sheet?: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out: string[] = [];
  for (const ws of wb.worksheets) {
    if (sheet && ws.name !== sheet) continue;
    ws.eachRow(row => row.eachCell(c => { out.push(String((c.value as { result?: unknown })?.result ?? c.text ?? '')); }));
  }
  return out.join('\n');
}

beforeEach(() => { resetCalls(); });
afterEach(() => { clearMockHandler(); clearStages(); });

// ---------- tests ----------

describe('versioned artifacts', () => {
  it('artifactName and latestArtifact (unsuffixed name counts as v1)', () => {
    const p = prep();
    expect(artifactName('TKCT', 'REQ-001', 2)).toBe('TKCT_REQ-001_v2.docx');
    expect(artifactName('TestCase', 'REQ-001', 1)).toBe('TestCase_REQ-001_v1.xlsx');
    expect(latestArtifact(p.ws, 'ULNL', p.r.id)).toBeUndefined();
    writeFileSync(join(p.ws.artifactsDir, `ULNL_${p.r.id}.xlsx`), 'x');
    expect(latestArtifact(p.ws, 'ULNL', p.r.id)).toBe(join(p.ws.artifactsDir, `ULNL_${p.r.id}.xlsx`));
    writeFileSync(join(p.ws.artifactsDir, `ULNL_${p.r.id}_v2.xlsx`), 'x');
    writeFileSync(join(p.ws.artifactsDir, `ULNL_${p.r.id}_v10.xlsx`), 'x');
    writeFileSync(join(p.ws.artifactsDir, `ULNL_${p.r.id}_v3.docx`), 'x');
    writeFileSync(join(p.ws.artifactsDir, `ULNL_REQ-0012_v99.xlsx`), 'x');
    expect(latestArtifact(p.ws, 'ULNL', p.r.id)).toBe(join(p.ws.artifactsDir, `ULNL_${p.r.id}_v10.xlsx`));
  });
});

describe('incremental stages after accepted CRs', () => {
  it('prompt includes the changes section (and role block) only when changes exist', async () => {
    const p = prep({ stubs: ['DESIGN'] });
    const FJ = { features: [
      { id: 'F-01', code: 'DANGNHAP', name: 'Đăng nhập', description: 'd', type_code: 'CN_WEB1', unit_test: true, note: '', kind: 'function' },
      { id: 'F-02', code: 'BAOCAO', name: 'Báo cáo', description: 'd', type_code: 'BC2', unit_test: false, note: '', kind: 'function' },
      { id: 'NF-01', code: 'PM', name: 'PM', description: 'PM', type_code: 'PM', unit_test: false, note: '', kind: 'nonfunction' },
    ] };
    mockClaude({ 'analyst-breakdown': dir => writeFileSync(join(dir, 'features.json'), JSON.stringify(FJ)) });
    startAt(p.pipeline, p.r.id, 'BREAKDOWN');
    await p.worker.drain();
    expect(calls[0]!.prompt).not.toContain('Thay đổi đã chấp nhận');
    expect(calls[0]!.prompt).not.toContain('khi-co-thay-doi');
    expect(existsSync(join(p.ws.artifactsDir, `ULNL_${p.r.id}_v1.xlsx`))).toBe(true);

    const cr = acceptCr(p.repo, p.ws, p.r.id, { scope: { add: [{ name: 'Xuất Excel', description: 'Xuất báo cáo ra Excel' }], modify: [], remove: [] } });
    startAt(p.pipeline, p.r.id, 'BREAKDOWN');
    await p.worker.drain();
    const pr = calls[1]!.prompt;
    expect(pr).toContain('## Thay đổi đã chấp nhận');
    expect(pr).toContain(`### ${cr} — Thêm xuất Excel`);
    expect(pr).toContain('Xuất Excel — Xuất báo cáo ra Excel');
    expect(pr).toContain(join(p.ws.devflowDir, 'changes', cr, 'impact.md'));
    expect(pr).toContain('"scope_status": "cancelled"');
    expect(pr).toContain('Cập nhật theo thay đổi đã chấp nhận');
    expect(pr).not.toContain('khi-co-thay-doi');
    expect(pr.indexOf('## Thay đổi đã chấp nhận')).toBeLessThan(pr.indexOf('## Đầu ra bắt buộc'));
    expect(existsSync(join(p.ws.artifactsDir, `ULNL_${p.r.id}_v2.xlsx`))).toBe(true);
    expect(existsSync(join(p.ws.artifactsDir, `ULNL_${p.r.id}_v1.xlsx`))).toBe(true);
  });

  it('breakdown keeps ids and marks cancelled; ULNL v2 excludes cancelled effort with note', async () => {
    const p = prep({ stubs: ['DESIGN'] });
    const cr = acceptCr(p.repo, p.ws, p.r.id, { scope: { add: [{ name: 'Xuất Excel', description: 'x' }], modify: [], remove: ['F-02'] } });
    expect(p.repo.listFeatures(p.r.id).find(f => f.id === 'F-02')!.scopeStatus).toBe('cancelled');
    mockClaude({
      'analyst-breakdown': dir => writeFileSync(join(dir, 'features.json'), JSON.stringify({ features: [
        { id: 'F-01', code: 'DANGNHAP', name: 'Đăng nhập', description: 'd', type_code: 'CN_WEB1', unit_test: true, note: '', kind: 'function' },
        { id: 'F-02', code: 'BAOCAO', name: 'Báo cáo', description: 'd', type_code: 'BC2', unit_test: false, note: 'cũ', kind: 'function', scope_status: 'cancelled' },
        { id: 'F-03', code: 'XUATEXCEL', name: 'Xuất Excel', description: 'd', type_code: 'BC2', unit_test: false, note: '', kind: 'function' },
        // NF-01 omitted: must be kept
      ] })),
    });
    startAt(p.pipeline, p.r.id, 'BREAKDOWN');
    await p.worker.drain();
    const fs = p.repo.listFeatures(p.r.id);
    expect(fs.map(f => [f.id, f.scopeStatus, f.changedByCr])).toEqual([
      ['F-01', 'active', null], ['F-02', 'cancelled', cr], ['F-03', 'active', cr], ['NF-01', 'active', null],
    ]);
    expect(p.repo.listEvents(p.r.id).some(e => e.level === 'warn' && e.message.includes('NF-01'))).toBe(true);
    const out = join(p.ws.artifactsDir, `ULNL_${p.r.id}_v2.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    const sh = wb.getWorksheet('EFFORT_FUNCTION')!;
    const rowOf = (code: string) => { for (let r = 9; r < 30; r++) if (sh.getCell(`B${r}`).value === code) return r; return -1; };
    const rb = rowOf('BAOCAO');
    expect(rb).toBeGreaterThan(0);
    expect(String(sh.getCell(`X${rb}`).value)).toContain(`Hủy theo ${cr}`);
    expect(sh.getCell(`I${rb}`).value).toBe(0);
    expect(rowOf('XUATEXCEL')).toBeGreaterThan(0);
    expect(wb.getWorksheet('EFFORT NON-FUNCTION')!.getCell('B10').value).toBe('PM');
  });

  it('a feature cancelled by a CR stays cancelled even when Claude forgets scope_status', async () => {
    const p = prep({ stubs: ['DESIGN'] });
    const cr = acceptCr(p.repo, p.ws, p.r.id, { scope: { add: [], modify: [], remove: ['F-02'] } });
    mockClaude({
      'analyst-breakdown': dir => writeFileSync(join(dir, 'features.json'), JSON.stringify({ features: [
        { id: 'F-01', code: 'DANGNHAP', name: 'Đăng nhập', description: 'd', type_code: 'CN_WEB1', unit_test: true, note: '', kind: 'function' },
        { id: 'F-02', code: 'BAOCAO', name: 'Báo cáo', description: 'd', type_code: 'BC2', unit_test: false, note: '', kind: 'function' },
        { id: 'NF-01', code: 'PM', name: 'PM', description: 'PM', type_code: 'PM', unit_test: false, note: '', kind: 'nonfunction' },
      ] })),
    });
    startAt(p.pipeline, p.r.id, 'BREAKDOWN');
    await p.worker.drain();
    expect(p.repo.listFeatures(p.r.id).find(f => f.id === 'F-02')).toMatchObject({ scopeStatus: 'cancelled', changedByCr: cr });
  });

  it('TKCT v2 has the change history table from DB (accepted/applied CRs only); old version kept', async () => {
    const p = prep({ stubs: ['PLANNING'] });
    const old = join(p.ws.artifactsDir, `TKCT_${p.r.id}.docx`);
    writeFileSync(old, 'v1');
    const cr = acceptCr(p.repo, p.ws, p.r.id, { scope: { add: [], modify: [{ feature_id: 'F-02', change: 'Thêm cột' }], remove: [] } }, 'Sửa báo cáo');
    // A rejected CR carries baselineFrom too: it must not be listed.
    const rej = p.repo.createChangeRequest(p.r.id, { title: 'Bị từ chối', description: 'x', kind: 'add', source: 'staff', status: 'rejected' });
    p.repo.updateChangeRequest(p.r.id, rej.id, { baselineFrom: 2 });
    const md = changeHistoryMarkdown(p.repo, p.r.id);
    expect(md).toContain('## Lịch sử thay đổi');
    expect(md).toContain('| Phiên bản | CR | Ngày | Nội dung | Người duyệt |');
    expect(md).toContain(`| v2 | ${cr} | 05/11/2026 |`);
    expect(md).toContain('Sửa báo cáo');
    expect(md).not.toContain('Bị từ chối');
    mockClaude({
      architect: dir => {
        const d = join(dir, 'design');
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'tech-stack.md'), '# Công nghệ\n\nNode.js\n');
        writeFileSync(join(d, 'tkct.md'), TKCT_MD + '## Lịch sử thay đổi\n\nClaude tự viết — phải bị thay.\n');
        writeFileSync(join(d, 'tkdb.md'), TKDB_MD);
        writeFileSync(join(d, 'a.mmd'), 'graph TD; A-->B\n');
      },
    });
    startAt(p.pipeline, p.r.id, 'DESIGN');
    await p.worker.drain();
    expect(calls).toHaveLength(1);
    const out = join(p.ws.artifactsDir, `TKCT_${p.r.id}_v2.docx`);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(p.ws.artifactsDir, `TKDB_${p.r.id}_v2.docx`))).toBe(true);
    expect(readFileSync(old, 'utf8')).toBe('v1');
    const xml = await (await JSZip.loadAsync(readFileSync(out))).file('word/document.xml')!.async('string');
    expect(xml).toContain('Lịch sử thay đổi');
    expect(xml).toContain(cr);
    expect(xml).not.toContain('Claude tự viết');
    expect(xml.indexOf('Lịch sử thay đổi')).toBeGreaterThan(xml.indexOf('PHỤ LỤC'));
  });

  it('planning keeps done tasks not affected, test history of unaffected TCs and never deletes omitted rows', async () => {
    const p = prep({
      stubs: ['DEVELOP'],
      tasks: [
        task('T-01', 'F-01', { status: 'done', branch: 'devflow/x-T-01', mrIid: 5, reviewRounds: 2 }),
        task('T-02', 'F-02', { status: 'done', branch: 'devflow/x-T-02', mrIid: 6, reviewRounds: 1, dependsOn: ['T-01'] }),
      ],
      testCases: [
        tcRow('TC-DANGNHAP-01', 'F-01', { status1: 'P', baseline: 1, evidence: ['evidence/TC-DANGNHAP-01/a.png'] }),
        tcRow('TC-BAOCAO-01', 'F-02', { status1: 'P', baseline: 1 }),
      ],
    });
    writeFlowState(p.ws, { ...readFlowState(p.ws), runs: { 'TC-DANGNHAP-01': [passRun(1)], 'TC-BAOCAO-01': [passRun(2)] }, clock: 2 });
    const cr = acceptCr(p.repo, p.ws, p.r.id, {
      scope: { add: [], modify: [{ feature_id: 'F-02', change: 'Thêm cột' }], remove: [] },
      affected: { features: ['F-02'], tasks: ['T-02'], test_cases: ['TC-BAOCAO-01'] },
    });
    mockClaude({
      planner: dir => {
        writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ tasks: [
          { id: 'T-01', title: 'Task T-01', feature_id: 'F-01', depends_on: [] },
          { id: 'T-02', title: 'Task T-02 (sửa cột)', feature_id: 'F-02', depends_on: ['T-01'] },
          { id: 'T-03', title: 'Thêm cột tổng', feature_id: 'F-02', depends_on: ['T-01'] },
        ] }));
        writeFileSync(join(dir, 'testcases.json'), JSON.stringify({ test_cases: [
          // TC-DANGNHAP-01 omitted: must be kept with its history
          { id: 'TC-BAOCAO-01', feature_id: 'F-02', purpose: 'Mục đích TC-BAOCAO-01', data: '', steps: '1. Làm', expected: 'Có cột tổng' },
          { id: 'TC-BAOCAO-02', feature_id: 'F-02', purpose: 'Cột tổng', data: '', steps: '1. Xem', expected: 'Đúng tổng' },
        ] }));
      },
    });
    startAt(p.pipeline, p.r.id, 'PLANNING');
    await p.worker.drain();
    expect(calls).toHaveLength(1);
    const ts = p.repo.listTasks(p.r.id);
    expect(ts.map(t => [t.id, t.status, t.changedByCr])).toEqual([['T-01', 'done', null], ['T-02', 'todo', cr], ['T-03', 'todo', cr]]);
    expect(ts[0]).toMatchObject({ branch: 'devflow/x-T-01', mrIid: 5, reviewRounds: 2 });
    const tcs = new Map(p.repo.listTestCases(p.r.id).map(t => [t.id, t]));
    expect(tcs.get('TC-DANGNHAP-01')).toMatchObject({ status1: 'P', baseline: 1, evidence: ['evidence/TC-DANGNHAP-01/a.png'], changedByCr: null });
    expect(tcs.get('TC-BAOCAO-01')).toMatchObject({ status1: 'P', baseline: null, changedByCr: cr, expected: 'Có cột tổng' });
    expect(tcs.get('TC-BAOCAO-02')).toMatchObject({ status1: null, changedByCr: cr, scopeStatus: 'active' });
    expect(readFlowState(p.ws).runs['TC-DANGNHAP-01']).toHaveLength(1);
    expect(existsSync(join(p.ws.artifactsDir, `TestCase_${p.r.id}_v2.xlsx`))).toBe(true);
    expect(p.repo.listEvents(p.r.id).some(e => e.level === 'warn' && e.message.includes('TC-DANGNHAP-01'))).toBe(true);
  });

  it('develop skips cancelled tasks and redoes a reopened task on a fresh branch', async () => {
    const p = prep({
      stubs: ['TEST'],
      features: [...FEATURES, feature('F-03', 'XOA')],
      tasks: [
        task('T-01', 'F-01', { status: 'done', branch: 'devflow/REQ-001-T-01', mrIid: null, reviewRounds: 1 }),
        task('T-02', 'F-03', { dependsOn: ['T-01'] }),
        task('T-03', 'F-02', { dependsOn: ['T-01'] }),
      ],
    });
    const cr = acceptCr(p.repo, p.ws, p.r.id, { scope: { add: [], modify: [], remove: ['F-03'] }, affected: { features: [], tasks: ['T-01'], test_cases: [] } });
    expect(p.repo.getTask(p.r.id, 'T-02')!.scopeStatus).toBe('cancelled');
    mockClaude({ developer, reviewer });
    startAt(p.pipeline, p.r.id, 'DEVELOP');
    await p.worker.drain();
    expect(calls.map(c => c.role)).toEqual(['developer', 'reviewer', 'developer', 'reviewer']);
    expect(calls[0]!.prompt).toContain('Task T-01');
    expect(calls[2]!.prompt).toContain('Task T-03');
    expect(calls.some(c => c.prompt.includes('**Task T-02'))).toBe(false);
    const ts = new Map(p.repo.listTasks(p.r.id).map(t => [t.id, t]));
    expect(ts.get('T-01')).toMatchObject({ status: 'done', branch: `${p.branch}-T-01-v2` });
    expect(ts.get('T-02')).toMatchObject({ status: 'todo', scopeStatus: 'cancelled', changedByCr: cr });
    expect(ts.get('T-03')!.status).toBe('done');
    // Every task merge counts for the regression rule.
    expect(readFlowState(p.ws).lastFixSeq).toBeGreaterThan(0);
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('TEST');
  });

  it('test re-runs TCs modified by a CR, skips cancelled ones and records the baseline', async () => {
    const p = prep({
      stubs: ['DONE'],
      features: [...FEATURES, feature('F-03', 'XOA')],
      testCases: [
        tcRow('TC-DANGNHAP-01', 'F-01', { status1: 'P', baseline: 1 }),
        tcRow('TC-BAOCAO-01', 'F-02', { status1: 'P', baseline: 1 }),
        tcRow('TC-XOA-01', 'F-03', { status1: 'P', baseline: 1 }),
      ],
    });
    writeFlowState(p.ws, { ...readFlowState(p.ws), runs: { 'TC-DANGNHAP-01': [passRun(1)], 'TC-BAOCAO-01': [passRun(2)], 'TC-XOA-01': [passRun(3)] }, clock: 3 });
    const cr = acceptCr(p.repo, p.ws, p.r.id, {
      scope: { add: [], modify: [{ feature_id: 'F-02', change: 'x' }], remove: ['F-03'] },
      affected: { features: ['F-02'], tasks: [], test_cases: ['TC-BAOCAO-01'] },
    });
    mockClaude({ tester: tester(p.ws.evidenceDir, [[{ tc_id: 'TC-DANGNHAP-01', status: 'P', files: ['a.png'] }, { tc_id: 'TC-BAOCAO-01', status: 'P', files: ['b.png'] }]]) });
    startAt(p.pipeline, p.r.id, 'TEST');
    await p.worker.drain();
    expect(calls.map(c => c.role)).toEqual(['tester']);
    expect(calls[0]!.prompt).toContain('`TC-BAOCAO-01`');
    expect(calls[0]!.prompt).toContain('`TC-DANGNHAP-01`');
    expect(calls[0]!.prompt).not.toContain('`TC-XOA-01`');
    const tcs = new Map(p.repo.listTestCases(p.r.id).map(t => [t.id, t]));
    expect(tcs.get('TC-BAOCAO-01')).toMatchObject({ baseline: 2, status1: 'P', status2: 'P' });
    expect(tcs.get('TC-XOA-01')).toMatchObject({ scopeStatus: 'cancelled', baseline: 1 });
    expect(readFlowState(p.ws).runs['TC-BAOCAO-01']!.at(-1)!.baseline).toBe(2);
    const book = join(p.ws.artifactsDir, `TestCase_${p.r.id}_v2.xlsx`);
    expect(existsSync(book)).toBe(true);
    expect(await sheetText(book, '2. FUNCTIONAL TESTCASE')).toContain(`Hủy theo ${cr}`);
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('DONE');
  });

  it('a task merge after the last P triggers the regression run (not only bug fixes)', async () => {
    const p = prep({
      stubs: ['DONE'],
      tasks: [task('T-01', 'F-01', { status: 'done' }), task('T-02', 'F-02')],
      testCases: [tcRow('TC-DANGNHAP-01', 'F-01', { status1: 'P', baseline: 1 }), tcRow('TC-BAOCAO-01', 'F-02', { status1: 'P', baseline: 1 })],
    });
    writeFlowState(p.ws, { ...readFlowState(p.ws), runs: { 'TC-DANGNHAP-01': [passRun(1)], 'TC-BAOCAO-01': [passRun(2)] }, clock: 2 });
    mockClaude({
      developer, reviewer,
      tester: tester(p.ws.evidenceDir, [[{ tc_id: 'TC-DANGNHAP-01', status: 'P', files: ['a.png'] }, { tc_id: 'TC-BAOCAO-01', status: 'P', files: ['b.png'] }]]),
    });
    startAt(p.pipeline, p.r.id, 'DEVELOP');
    await p.worker.drain();
    expect(calls.map(c => c.role)).toEqual(['developer', 'reviewer', 'tester']);
    expect(calls[2]!.prompt).toContain('`TC-DANGNHAP-01`');
    expect(calls[2]!.prompt).toContain('`TC-BAOCAO-01`');
  });

  it('done guard fails when an active TC has no result at the current baseline; cancelled TCs do not block', async () => {
    const p = prep({
      features: [...FEATURES, feature('F-03', 'XOA')],
      testCases: [tcRow('TC-DANGNHAP-01', 'F-01', { status1: 'P', baseline: 2 }), tcRow('TC-BAOCAO-01', 'F-02'), tcRow('TC-XOA-01', 'F-03')],
    });
    acceptCr(p.repo, p.ws, p.r.id, { scope: { add: [], modify: [], remove: ['F-03'] } });
    writeFlowState(p.ws, { ...readFlowState(p.ws), runs: { 'TC-DANGNHAP-01': [passRun(1, 2)] }, clock: 1 });
    mockClaude({});
    startAt(p.pipeline, p.r.id, 'DONE');
    await p.worker.drain();
    let req = p.repo.getRequest(p.r.id)!;
    expect(req.status).toBe('failed');
    const msg = p.repo.listStageRuns(p.r.id).at(-1)!.error ?? '';
    expect(msg).toContain('TC-BAOCAO-01');
    expect(msg).not.toContain('TC-XOA-01');

    writeFlowState(p.ws, { ...readFlowState(p.ws), runs: { 'TC-DANGNHAP-01': [passRun(1, 2)], 'TC-BAOCAO-01': [passRun(2, 2)] }, clock: 2 });
    startAt(p.pipeline, p.r.id, 'DONE');
    await p.worker.drain();
    req = p.repo.getRequest(p.r.id)!;
    expect([req.stage, req.status]).toEqual(['DONE', 'done']);
  });

  it('done: report lists the changes of this iteration and the open final MR gets a note instead of a new MR', async () => {
    const p = prep({ gitlab: true, testCases: [tcRow('TC-DANGNHAP-01', 'F-01'), tcRow('TC-BAOCAO-01', 'F-02')] });
    const mr = await p.gl!.client.createMR(7, { source: p.branch, target: 'main', title: `[${p.r.id}] Bán hàng`, description: 'v1' });
    const cr = acceptCr(p.repo, p.ws, p.r.id, { summary: 'Thêm cột tổng vào báo cáo' }, 'Sửa báo cáo');
    writeFlowState(p.ws, { ...readFlowState(p.ws), runs: { 'TC-DANGNHAP-01': [passRun(1, 2)], 'TC-BAOCAO-01': [passRun(2, 2)] }, clock: 2 });
    mockClaude({});
    startAt(p.pipeline, p.r.id, 'DONE');
    await p.worker.drain();
    expect(p.repo.getRequest(p.r.id)!.status).toBe('done');
    expect(p.gl!.mrs.size).toBe(1);
    const notes = p.gl!.mrs.get(mr.iid)!.notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(cr);
    expect(notes[0]).toContain('v2');
    const report = readFileSync(join(p.ws.artifactsDir, 'report.md'), 'utf8');
    expect(report).toContain('## Các thay đổi trong vòng này');
    expect(report).toContain(`${cr} — Sửa báo cáo`);
    expect(report).toContain('Thêm cột tổng vào báo cáo');
    expect(p.repo.getChangeRequest(p.r.id, cr)!.status).toBe('applied');
    // DONE again (same baseline): no duplicate note.
    startAt(p.pipeline, p.r.id, 'DONE');
    await p.worker.drain();
    expect(p.gl!.mrs.get(mr.iid)!.notes).toHaveLength(1);
  });

  it('after an accepted CR, ANALYSIS/CLARIFY keep and export every open question incl. [CR-NN] ones', async () => {
    const p = prep({ stubs: ['BREAKDOWN'] });
    const q = (id: string, priority: 'must' | 'should', why = 'vì cần'): Question => ({
      id, category: 'Chức năng', question: `Câu hỏi ${id}?`, why, type: 'single', options: ['Có', 'Không'], suggested_answer: 'Có', priority,
    });
    p.repo.upsertQuestions(p.r.id, 1, [q('Q-01', 'must')]);
    p.repo.saveAnswer(p.r.id, 'Q-01', 'Có', 'web');
    p.repo.upsertQuestions(p.r.id, 2, [q('Q-02', 'should')]);
    p.repo.updateRequest(p.r.id, { clarifyRound: 2 });
    const cr = acceptCr(p.repo, p.ws, p.r.id, { reenter: 'ANALYSIS' });
    p.repo.upsertQuestions(p.r.id, 3, [q('Q-03', 'must', `[${cr}] Cần xác nhận định dạng`)]);
    expect(p.repo.getRequest(p.r.id)!.clarifyRound).toBe(0);
    mockClaude({
      analyst: dir => {
        writeFileSync(join(dir, 'analysis.md'), `${ANALYSIS_MD}\n# Thay đổi theo ${cr}\n\nCập nhật.\n`);
        writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions: [q('Q-04', 'should')] }));
      },
    });
    startAt(p.pipeline, p.r.id, 'ANALYSIS');
    await p.worker.drain();
    expect(calls[0]!.prompt).toMatch(/Q-03 .*CHƯA TRẢ LỜI/);
    const req = p.repo.getRequest(p.r.id)!;
    expect([req.stage, req.status]).toEqual(['CLARIFY', 'awaiting_customer']);
    const file = join(p.ws.artifactsDir, 'questions', `Questions_${p.r.id}_v2_round1.xlsx`);
    expect(existsSync(file)).toBe(true);
    const text = await sheetText(file);
    for (const id of ['Q-02', 'Q-03', 'Q-04']) expect(text).toContain(id);
    // The survey of this round (round 1) must show all of them.
    const open = p.repo.listQuestions(p.r.id).filter(x => x.id !== 'Q-01');
    expect(open.map(x => [x.id, x.round])).toEqual([['Q-02', 1], ['Q-03', 1], ['Q-04', 1]]);
  });

  it('analysis after a CR requires a "Thay đổi theo CR-NN" section', async () => {
    const p = prep({ stubs: ['CLARIFY', 'BREAKDOWN'] });
    const cr = acceptCr(p.repo, p.ws, p.r.id, { reenter: 'ANALYSIS' });
    let n = 0;
    mockClaude({
      analyst: dir => {
        n++;
        writeFileSync(join(dir, 'analysis.md'), n === 1 ? ANALYSIS_MD : `${ANALYSIS_MD}\n# Thay đổi theo ${cr}\n\nCập nhật.\n`);
        writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions: [] }));
      },
    });
    startAt(p.pipeline, p.r.id, 'ANALYSIS');
    await p.worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain(`Thay đổi theo ${cr}`);
  });
});
