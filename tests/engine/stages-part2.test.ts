import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ExcelJS from 'exceljs';
import { clearMockHandler } from '../../src/claude/mock.js';
import { clearStages, Pipeline, registerStage, Workspace } from '../../src/engine/pipeline.js';
import { Worker } from '../../src/engine/worker.js';
import { writeProjectInfo } from '../../src/engine/stages/common.js';
import { validateResults } from '../../src/engine/evidence.js';
import { isTesterPath } from '../../src/engine/stages/test.js';
import type { Stage, TestCaseRow } from '../../src/domain/types.js';
import { setup, mkReq } from './helpers.js';
import { calls, git, initRepo, mockClaude, outputPaths, register, resetCalls, startAt, type Call } from './stage-helpers.js';
import { fakeGitLab } from '../fixtures/fake-gitlab.js';

// ---------- fixtures ----------

const FEATURES = [
  { id: 'F-01', code: 'DANGNHAP', name: 'Đăng nhập', description: 'Đăng nhập', typeCode: 'CN_WEB1', unitTest: true, note: '', kind: 'function' as const },
  { id: 'F-02', code: 'BAOCAO', name: 'Báo cáo', description: 'Báo cáo', typeCode: 'BC2', unitTest: false, note: '', kind: 'function' as const },
];

const TASKS = {
  tasks: [
    { id: 'T-01', title: 'Màn hình đăng nhập', feature_id: 'F-01', depends_on: [] },
    { id: 'T-02', title: 'Báo cáo doanh thu', feature_id: 'F-02', depends_on: ['T-01'] },
  ],
};
const TCS = {
  test_cases: [
    { id: 'TC-DANGNHAP-01', feature_id: 'F-01', purpose: 'Đăng nhập đúng mật khẩu', data: 'admin/123', steps: '1. Mở trang\n2. Nhập', expected: 'Vào trang chủ' },
    { id: 'TC-BAOCAO-01', feature_id: 'F-02', purpose: 'Xem báo cáo', data: '', steps: '1. Mở báo cáo', expected: 'Hiện bảng' },
  ],
};

const tcRow = (id: string, featureId: string, purpose = `Mục đích ${id}`): TestCaseRow => ({
  id, featureId, purpose, data: '', steps: '1. Làm', expected: 'Đúng', status1: null, status2: null, realResult: null, evidence: [], comment: null,
});

type Result = { tc_id: string; status: 'P' | 'F' | 'PE'; real_result?: string; comment?: string; evidence?: string[] };

/** Developer fixture: writes one code file per call plus the summary file listed as required output. */
const developer = (_dir: string, call: Call) => {
  const n = calls.filter(c => c.role === 'developer').length;
  const cwd = call.opts.cwd;
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', `code-${n}.txt`), `change ${n}\n`);
  for (const p of outputPaths(call.prompt)) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, `Đã làm lần ${n}\n`); }
};

/** Reviewer fixture: `verdicts[i]` decides call i (last one repeats). */
const reviewer = (verdicts: boolean[]) => (_dir: string, call: Call) => {
  const i = calls.filter(c => c.role === 'reviewer').length - 1;
  const ok = verdicts[Math.min(i, verdicts.length - 1)]!;
  const p = outputPaths(call.prompt)[0]!;
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, JSON.stringify({ approved: ok, comments: ok ? [] : [{ file: 'src/a.ts', line: 3, severity: 'major', body: `Thiếu kiểm tra null (lần ${i + 1})` }] }));
};

/** Tester fixture: `runs[i]` = results of tester call i (last repeats); writes evidence files for listed names. */
const tester = (evidenceDir: string, runs: (Result & { files?: string[] })[][]) => (dir: string) => {
  const i = calls.filter(c => c.role === 'tester').length - 1;
  const rs = runs[Math.min(i, runs.length - 1)]!;
  for (const r of rs) {
    for (const f of r.files ?? []) {
      mkdirSync(join(evidenceDir, r.tc_id), { recursive: true });
      writeFileSync(join(evidenceDir, r.tc_id, f), 'PNGDATA');
    }
  }
  writeFileSync(join(dir, 'test-results.json'), JSON.stringify({
    results: rs.map(r => ({ tc_id: r.tc_id, status: r.status, real_result: r.real_result ?? 'thực tế', comment: r.comment ?? '', evidence: (r.files ?? []).map(f => join(evidenceDir, r.tc_id, f)) })),
  }));
};

// ---------- workspace preparation ----------

interface Prep { gitlab?: boolean; stubs?: Stage[]; tasks?: boolean; testCases?: TestCaseRow[] }

function prep(o: Prep = {}) {
  register(o.stubs ?? []);
  const s = setup();
  const r = mkReq(s.repo, { projectKind: o.gitlab ? 'existing' : 'new', gitlabProject: o.gitlab ? 'grp/app' : null });
  const ws = Workspace.for(s.cfg, r.id).ensure();
  const branch = `devflow/${r.id}`;
  let bare = '';
  let gl: ReturnType<typeof fakeGitLab> | undefined;
  if (o.gitlab) {
    const root = mkdtempSync(join(tmpdir(), 'devflow-remote-'));
    bare = join(root, 'app.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    const seed = join(root, 'seed');
    initRepo(seed, 'main');
    writeFileSync(join(seed, 'README.md'), '# app\n');
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'readme');
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
  s.repo.replaceFeatures(r.id, FEATURES);
  if (o.tasks) {
    for (const t of TASKS.tasks) s.repo.upsertTask(r.id, { id: t.id, title: t.title, featureId: t.feature_id, dependsOn: t.depends_on, status: 'todo', reviewRounds: 0, branch: null, mrIid: null });
  }
  for (const tc of o.testCases ?? []) s.repo.upsertTestCase(r.id, tc);
  // No makeGit: exercises the real Git construction (protectedBranch from project info).
  const pipeline = new Pipeline(s.cfg, s.repo, gl ? { makeGitLab: () => gl!.client } : { makeGitLab: () => undefined });
  const worker = new Worker(s.cfg, s.repo, pipeline);
  return { ...s, pipeline, worker, r, ws, branch, bare, gl };
}

async function readSheet(path: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sh = wb.getWorksheet('2. FUNCTIONAL TESTCASE')!;
  const text = (v: ExcelJS.CellValue): string => (v && typeof v === 'object' && 'text' in v ? String(v.text) : v == null ? '' : String(v));
  const row = (n: number) => ({
    id: text(sh.getCell(`A${n}`).value), s1: text(sh.getCell(`I${n}`).value), s2: text(sh.getCell(`J${n}`).value),
    evidence: text(sh.getCell(`M${n}`).value), comment: text(sh.getCell(`N${n}`).value),
  });
  return { row };
}

beforeEach(() => { resetCalls(); });
afterEach(() => { clearMockHandler(); clearStages(); delete process.env.ANDROID_HOME; });

// ---------- tests ----------

describe('pipeline git safety', () => {
  it('constructs Git with protectedBranch = project default branch', async () => {
    const p = prep({ gitlab: true });
    let err = '';
    registerStage('PLANNING', async ctx => {
      try { await ctx.git.push('main'); } catch (e) { err = (e as Error).message; }
      return { kind: 'needs_human', reason: 'stop' };
    }, { gate: false });
    startAt(p.pipeline, p.r.id, 'PLANNING');
    await p.worker.drain();
    expect(err).toMatch(/protected branch/);
    expect(git(p.bare, 'log', '--oneline', 'main')).toMatch(/readme/);
  });
});

describe('validateResults', () => {
  it('downgrades P without evidence and PE without reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-ev-'));
    mkdirSync(join(dir, 'TC-A-01'), { recursive: true });
    writeFileSync(join(dir, 'TC-A-01', 'a.png'), 'x');
    mkdirSync(join(dir, 'TC-A-02'), { recursive: true }); // empty dir
    const out = validateResults([
      { tc_id: 'TC-A-01', status: 'P', real_result: 'ok', evidence: [], comment: '' },
      { tc_id: 'TC-A-02', status: 'P', real_result: 'ok', evidence: [], comment: 'đã chạy' },
      { tc_id: 'TC-A-03', status: 'PE', real_result: '', evidence: [], comment: '  ' },
      { tc_id: 'TC-A-04', status: 'PE', real_result: '', evidence: [], comment: 'thiếu môi trường mobile' },
      { tc_id: '../x', status: 'P', real_result: '', evidence: [], comment: '' },
    ], dir);
    expect(out.map(r => r.status)).toEqual(['P', 'F', 'F', 'PE', 'F']);
    expect(out[1]!.comment).toContain('thiếu evidence');
    expect(out[1]!.comment).toContain('đã chạy');
    expect(out[2]!.comment).toContain('thiếu lý do PE');
  });
});

describe('stages part 2', () => {
  it('planning writes test case xlsx', async () => {
    const p = prep({ stubs: ['DEVELOP'] });
    mockClaude({
      planner: dir => {
        writeFileSync(join(dir, 'tasks.json'), JSON.stringify(TASKS));
        writeFileSync(join(dir, 'testcases.json'), JSON.stringify(TCS));
      },
    });
    startAt(p.pipeline, p.r.id, 'PLANNING');
    await p.worker.drain();
    expect(calls.map(c => c.role)).toEqual(['planner']);
    expect(calls[0]!.prompt).toContain('DANGNHAP');
    expect(p.repo.listTasks(p.r.id).map(t => [t.id, t.dependsOn, t.status])).toEqual([['T-01', [], 'todo'], ['T-02', ['T-01'], 'todo']]);
    expect(p.repo.listTestCases(p.r.id).map(t => t.id)).toEqual(['TC-BAOCAO-01', 'TC-DANGNHAP-01']);
    const xlsx = join(p.ws.artifactsDir, `TestCase_${p.r.id}_v1.xlsx`);
    expect(existsSync(xlsx)).toBe(true);
    const sh = await readSheet(xlsx);
    expect([sh.row(12).id, sh.row(13).id]).toEqual(['TC-DANGNHAP-01', 'TC-BAOCAO-01']);
    expect(sh.row(12).s1).toBe('');
    expect(git(p.ws.repoDir, 'ls-files')).toContain('docs/devflow/tasks.json');
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('DEVELOP');
  });

  it('planning rejects unknown feature ids, dependency cycles and features without test cases, then retries', async () => {
    const p = prep({ stubs: ['DEVELOP'] });
    let n = 0;
    mockClaude({
      planner: dir => {
        n++;
        const bad = { tasks: [{ id: 'T-01', title: 'a', feature_id: 'F-99', depends_on: ['T-02'] }, { id: 'T-02', title: 'b', feature_id: 'F-01', depends_on: ['T-01'] }] };
        writeFileSync(join(dir, 'tasks.json'), JSON.stringify(n === 1 ? bad : TASKS));
        writeFileSync(join(dir, 'testcases.json'), JSON.stringify(n === 1 ? { test_cases: [TCS.test_cases[0]] } : TCS));
      },
    });
    startAt(p.pipeline, p.r.id, 'PLANNING');
    await p.worker.drain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('F-99');
    expect(calls[1]!.prompt).toMatch(/vòng|phụ thuộc vòng/);
    expect(calls[1]!.prompt).toContain('BAOCAO');
    expect(p.repo.listTasks(p.r.id)).toHaveLength(2);
  });

  it('develop runs review loop and merges MR', async () => {
    const p = prep({ gitlab: true, tasks: true, stubs: ['TEST'] });
    mockClaude({ developer, reviewer: reviewer([false, true, true]) });
    startAt(p.pipeline, p.r.id, 'DEVELOP');
    await p.worker.drain();
    expect(calls.map(c => c.role)).toEqual(['developer', 'reviewer', 'developer', 'reviewer', 'developer', 'reviewer']);
    // Developer prompt: TDD skill; second round carries the reviewer's comments.
    expect(calls[0]!.prompt).toContain('test-driven-development');
    expect(calls[2]!.prompt).toContain('Thiếu kiểm tra null (lần 1)');
    expect(calls[1]!.prompt).toMatch(/tkct|TKCT/);
    const mrs = [...p.gl!.mrs.values()];
    expect(mrs.map(m => [m.source, m.target, m.state])).toEqual([
      [`${p.branch}-T-01`, p.branch, 'merged'],
      [`${p.branch}-T-02`, p.branch, 'merged'],
    ]);
    expect(mrs[0]!.notes).toHaveLength(2);
    expect(mrs[0]!.notes[0]).toContain('Thiếu kiểm tra null (lần 1)');
    expect(p.repo.listTasks(p.r.id).map(t => [t.id, t.status, t.reviewRounds])).toEqual([['T-01', 'done', 2], ['T-02', 'done', 1]]);
    // Code reached the integration branch on the remote; default branch untouched.
    const files = git(p.bare, 'ls-tree', '-r', '--name-only', p.branch);
    expect(files).toContain('src/code-1.txt');
    expect(files).toContain('src/code-3.txt');
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('.devflow-tmp');
    expect(git(p.bare, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('src/code-1.txt');
    // One job per task: DEVELOP ran twice, then moved on (auto mode).
    expect(p.repo.listStageRuns(p.r.id).filter(s => s.stage === 'DEVELOP')).toHaveLength(2);
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('TEST');
  }, 30_000);

  it('develop without GitLab merges locally with --no-ff and records reviews in docs/devflow/reviews', async () => {
    const p = prep({ tasks: true, stubs: ['TEST'] });
    mkdirSync(join(p.ws.repoDir, 'dist'), { recursive: true });
    writeFileSync(join(p.ws.repoDir, 'dist', 'build.js'), 'x'); // pre-existing untracked output must not be committed
    mockClaude({ developer, reviewer: reviewer([false, true]) });
    startAt(p.pipeline, p.r.id, 'DEVELOP');
    await p.worker.drain();
    expect(git(p.ws.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(p.branch);
    const files = git(p.ws.repoDir, 'ls-tree', '-r', '--name-only', p.branch);
    expect(files).toContain('src/code-1.txt');
    expect(files).toContain('docs/devflow/reviews/T-01-r1.md');
    expect(files).toContain('docs/devflow/reviews/T-01-r2.md');
    expect(files).not.toContain('dist/build.js');
    expect(readFileSync(join(p.ws.repoDir, '.gitignore'), 'utf8')).toContain('.devflow-tmp/');
    expect(readFileSync(join(p.ws.repoDir, 'docs/devflow/reviews/T-01-r1.md'), 'utf8')).toContain('Thiếu kiểm tra null');
    const merges = git(p.ws.repoDir, 'log', '--merges', '--format=%s', p.branch);
    expect(merges).toContain('T-01');
    expect(merges).toContain('T-02');
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('TEST');
  });

  it('review rejected 3 times → needs_human', async () => {
    const p = prep({ tasks: true, stubs: ['TEST'] });
    mockClaude({ developer, reviewer: reviewer([false]) });
    startAt(p.pipeline, p.r.id, 'DEVELOP');
    await p.worker.drain();
    expect(calls.map(c => c.role)).toEqual(['developer', 'reviewer', 'developer', 'reviewer', 'developer', 'reviewer']);
    const req = p.repo.getRequest(p.r.id)!;
    expect(req.status).toBe('needs_human');
    expect(req.stage).toBe('DEVELOP');
    const t = p.repo.getTask(p.r.id, 'T-01')!;
    expect([t.status, t.reviewRounds]).toEqual(['needs_human', 3]);
    expect(p.repo.listStageRuns(p.r.id).at(-1)!.error).toContain('T-01');
    // Nothing merged into the integration branch.
    expect(git(p.ws.repoDir, 'ls-tree', '-r', '--name-only', p.branch)).not.toContain('src/code-1.txt');
  });

  it('test downgrades P without evidence', async () => {
    const tcs = [tcRow('TC-DANGNHAP-01', 'F-01'), tcRow('TC-DANGNHAP-02', 'F-01'), tcRow('TC-BAOCAO-01', 'F-02')];
    const p = prep({ testCases: tcs, stubs: ['BUGFIX'] });
    mockClaude({
      tester: tester(p.ws.evidenceDir, [[
        { tc_id: 'TC-DANGNHAP-01', status: 'P', files: ['shot.png'] },
        { tc_id: 'TC-DANGNHAP-02', status: 'PE', comment: '' },
        { tc_id: 'TC-BAOCAO-01', status: 'P' },
      ]]),
    });
    startAt(p.pipeline, p.r.id, 'TEST');
    await p.worker.drain();
    // The tester is asked to re-run (schema retries) before DevFlow downgrades.
    expect(calls.map(c => c.role)).toEqual(['tester', 'tester', 'tester']);
    expect(calls[1]!.prompt).toContain('TC-BAOCAO-01');
    expect(calls[0]!.prompt).toContain(join(p.ws.evidenceDir, 'TC-BAOCAO-01'));
    const get = (id: string) => p.repo.getTestCase(p.r.id, id)!;
    expect(get('TC-DANGNHAP-01').status1).toBe('P');
    expect(get('TC-DANGNHAP-01').evidence).toEqual(['evidence/TC-DANGNHAP-01/shot.png']);
    expect(existsSync(join(p.ws.artifactsDir, 'evidence', 'TC-DANGNHAP-01', 'shot.png'))).toBe(true);
    expect(get('TC-BAOCAO-01').status1).toBe('F');
    expect(get('TC-BAOCAO-01').comment).toContain('thiếu evidence');
    expect(get('TC-DANGNHAP-02').status1).toBe('F');
    expect(get('TC-DANGNHAP-02').comment).toContain('thiếu lý do PE');
    // Offline: bugs only in DB.
    expect(p.repo.listBugs(p.r.id).map(b => [b.tcId, b.status, b.gitlabIid])).toEqual([['TC-BAOCAO-01', 'open', null], ['TC-DANGNHAP-02', 'open', null]]);
    const sh = await readSheet(join(p.ws.artifactsDir, `TestCase_${p.r.id}_v1.xlsx`));
    const row = [12, 13, 14].map(n => sh.row(n)).find(x => x.id === 'TC-DANGNHAP-01')!;
    expect(row.s1).toBe('P');
    expect(row.evidence).toBe('evidence/TC-DANGNHAP-01/shot.png');
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('BUGFIX');
  });

  it('test failure creates gitlab issue and goes to BUGFIX', async () => {
    const p = prep({ gitlab: true, testCases: [tcRow('TC-DANGNHAP-01', 'F-01'), tcRow('TC-BAOCAO-01', 'F-02', 'Xem báo cáo')], stubs: ['BUGFIX'] });
    mockClaude({
      tester: tester(p.ws.evidenceDir, [[
        { tc_id: 'TC-DANGNHAP-01', status: 'P', files: ['ok.png'] },
        { tc_id: 'TC-BAOCAO-01', status: 'F', real_result: 'Lỗi 500', files: ['loi.png', 'response.json'] },
      ]]),
    });
    startAt(p.pipeline, p.r.id, 'TEST');
    await p.worker.drain();
    const issues = [...p.gl!.issues.entries()];
    expect(issues).toHaveLength(1);
    const [iid, is] = issues[0]!;
    expect(is.title).toBe(`[${p.r.id}][TC-BAOCAO-01] Xem báo cáo`);
    expect(is.labels).toEqual(expect.arrayContaining(['bug', 'devflow', p.r.id]));
    expect(is.description).toContain('Lỗi 500');
    expect(is.description).toContain('/uploads/abc/loi.png');
    expect(p.gl!.uploads.map(u => basename(u))).toEqual(['loi.png']);
    expect(p.repo.getBug(p.r.id, 'TC-BAOCAO-01')).toMatchObject({ gitlabIid: iid, fixAttempts: 0, status: 'open' });
    expect(p.repo.getTestCase(p.r.id, 'TC-BAOCAO-01')!.comment).toContain(`http://gl/grp/app/-/issues/${iid}`);
    // test-results.json committed and pushed to the integration branch.
    expect(git(p.bare, 'ls-tree', '-r', '--name-only', p.branch)).toContain('docs/devflow/test-results.json');
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('BUGFIX');
  });

  it('test commits only docs/devflow and test files; other tracked edits reverted, other new files left uncommitted', async () => {
    const p = prep({ testCases: [tcRow('TC-DANGNHAP-01', 'F-01')], stubs: ['DONE'] });
    mkdirSync(join(p.ws.repoDir, 'src'), { recursive: true });
    writeFileSync(join(p.ws.repoDir, 'src', 'app.ts'), 'original\n');
    writeFileSync(join(p.ws.repoDir, 'src', 'old.ts'), 'keep me\n');
    git(p.ws.repoDir, 'add', '-A');
    git(p.ws.repoDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app');
    const base = tester(p.ws.evidenceDir, [[{ tc_id: 'TC-DANGNHAP-01', status: 'P', files: ['ok.png'] }]]);
    mockClaude({
      tester: (dir, call) => {
        const repo = call.opts.cwd;
        writeFileSync(join(repo, 'src', 'app.ts'), 'tester changed app code\n');
        rmSync(join(repo, 'src', 'old.ts'));
        for (const f of ['tests/e2e/login.spec.ts', 'src/test/java/LoginTest.java', 'src/login.test.ts', 'tools/test_login.py', 'scratch.txt', 'src/helper.ts']) {
          mkdirSync(join(repo, f, '..'), { recursive: true });
          writeFileSync(join(repo, f), `// ${f}\n`);
        }
        return base(dir);
      },
    });
    startAt(p.pipeline, p.r.id, 'TEST');
    await p.worker.drain();
    const files = git(p.ws.repoDir, 'ls-tree', '-r', '--name-only', p.branch).split('\n');
    expect(files).toEqual(expect.arrayContaining([
      'docs/devflow/test-results.json', 'tests/e2e/login.spec.ts', 'src/test/java/LoginTest.java', 'src/login.test.ts', 'tools/test_login.py', 'src/app.ts', 'src/old.ts',
    ]));
    expect(files).not.toContain('scratch.txt');
    expect(files).not.toContain('src/helper.ts');
    // Tracked code changes are reverted, the deleted file restored; stray new files stay, uncommitted.
    expect(readFileSync(join(p.ws.repoDir, 'src', 'app.ts'), 'utf8').trim()).toBe('original'); // (autocrlf may add \r)
    expect(readFileSync(join(p.ws.repoDir, 'src', 'old.ts'), 'utf8').trim()).toBe('keep me');
    expect(existsSync(join(p.ws.repoDir, 'scratch.txt'))).toBe(true);
    expect(git(p.ws.repoDir, 'show', `${p.branch}:src/app.ts`)).toBe('original');
    const warns = p.repo.listEvents(p.r.id).filter(e => e.level === 'warn').map(e => e.message).join('\n');
    expect(warns).toMatch(/hoàn tác: .*src\/app\.ts/);
    expect(warns).toMatch(/không commit.*scratch\.txt/);
    expect(warns).toContain('src/helper.ts');
    expect(isTesterPath('docs/devflow/x.md')).toBe(true);
    expect(isTesterPath('src/__tests__/a.ts')).toBe(true);
    expect(isTesterPath('pkg/a_test.go')).toBe(true);
    expect(isTesterPath('src/contest/a.ts')).toBe(false);
    expect(isTesterPath('docs/other.md')).toBe(false);
  });

  it('bugfix >3 attempts → needs_human with label', async () => {
    const tc = { ...tcRow('TC-BAOCAO-01', 'F-02'), status1: 'F' as const, status2: 'F' as const };
    const p = prep({ gitlab: true, testCases: [tc] });
    p.gl!.seedIssue(5);
    p.repo.upsertBug(p.r.id, { tcId: 'TC-BAOCAO-01', gitlabIid: 5, fixAttempts: 3, status: 'open' });
    mockClaude({ developer, reviewer: reviewer([true]) });
    startAt(p.pipeline, p.r.id, 'BUGFIX');
    await p.worker.drain();
    expect(calls).toHaveLength(0);
    expect(p.gl!.issues.get(5)!.addLabels).toEqual(['needs-human']);
    const req = p.repo.getRequest(p.r.id)!;
    expect(req.status).toBe('needs_human');
    expect(p.repo.listStageRuns(p.r.id).at(-1)!.error).toContain('TC-BAOCAO-01');
    expect(p.repo.getBug(p.r.id, 'TC-BAOCAO-01')!.status).toBe('needs_human');
  });

  it('full offline cycle: TEST F → BUGFIX → TEST F → BUGFIX → TEST P → regression → DONE, with run columns and report', async () => {
    const p = prep({ testCases: [tcRow('TC-DANGNHAP-01', 'F-01'), tcRow('TC-BAOCAO-01', 'F-02')] });
    mockClaude({
      developer, reviewer: reviewer([true]),
      tester: tester(p.ws.evidenceDir, [
        [{ tc_id: 'TC-DANGNHAP-01', status: 'P', files: ['a.png'] }, { tc_id: 'TC-BAOCAO-01', status: 'F', files: ['b.png'] }],
        [{ tc_id: 'TC-BAOCAO-01', status: 'F', files: ['b2.png'] }],
        [{ tc_id: 'TC-BAOCAO-01', status: 'P', files: ['b3.png'] }],
        [{ tc_id: 'TC-DANGNHAP-01', status: 'P', files: ['a4.png'] }, { tc_id: 'TC-BAOCAO-01', status: 'P', files: ['b4.png'] }],
      ]),
    });
    startAt(p.pipeline, p.r.id, 'TEST');
    await p.worker.drain();
    // The last tester call is the regression run of all (non-PE) TCs after the fixes.
    expect(calls.map(c => c.role)).toEqual(['tester', 'developer', 'reviewer', 'tester', 'developer', 'reviewer', 'tester', 'tester']);
    expect(calls[7]!.prompt).toContain('`TC-DANGNHAP-01`');
    expect(calls[7]!.prompt).toContain('`TC-BAOCAO-01`');
    expect(calls[1]!.prompt).toContain('systematic-debugging');
    expect(calls[3]!.prompt).toContain('TC-BAOCAO-01');
    expect(calls[3]!.prompt).not.toContain('`TC-DANGNHAP-01`');
    const b = p.repo.getTestCase(p.r.id, 'TC-BAOCAO-01')!;
    expect([b.status1, b.status2]).toEqual(['F', 'P']);
    expect(b.comment).toContain('Lần 3: P');
    expect(b.comment).toContain('Lần 4: P');
    expect(b.evidence).toEqual(['evidence/TC-BAOCAO-01/b4.png']);
    const a = p.repo.getTestCase(p.r.id, 'TC-DANGNHAP-01')!;
    expect([a.status1, a.status2]).toEqual(['P', 'P']);
    expect(p.repo.getBug(p.r.id, 'TC-BAOCAO-01')).toMatchObject({ fixAttempts: 2, status: 'closed' });
    expect(git(p.ws.repoDir, 'log', '--merges', '--format=%s', p.branch)).toContain('fix-TC-BAOCAO-01');
    const req = p.repo.getRequest(p.r.id)!;
    expect([req.stage, req.status]).toEqual(['DONE', 'done']);
    const report = readFileSync(join(p.ws.artifactsDir, 'report.md'), 'utf8');
    expect(report).toContain(p.r.id);
    expect(report).toMatch(/P\s*\|\s*2/);
    expect(report).toContain(`TestCase_${p.r.id}_v1.xlsx`);
    expect(report).toMatch(/không có GitLab|chưa kết nối GitLab/i);
  });

  it('all pass → DONE opens final MR not merged', async () => {
    const p = prep({ gitlab: true, testCases: [tcRow('TC-DANGNHAP-01', 'F-01'), tcRow('TC-BAOCAO-01', 'F-02')] });
    p.gl!.seedIssue(9);
    p.repo.upsertBug(p.r.id, { tcId: 'TC-BAOCAO-01', gitlabIid: 9, fixAttempts: 1, status: 'fixed' });
    mockClaude({
      tester: tester(p.ws.evidenceDir, [[
        { tc_id: 'TC-DANGNHAP-01', status: 'P', files: ['a.png'] },
        { tc_id: 'TC-BAOCAO-01', status: 'P', files: ['b.png'] },
      ]]),
    });
    startAt(p.pipeline, p.r.id, 'TEST');
    await p.worker.drain();
    const mrs = [...p.gl!.mrs.values()];
    expect(mrs.map(m => [m.source, m.target, m.state])).toEqual([[p.branch, 'main', 'opened']]);
    expect(p.gl!.issues.get(9)!.state).toBe('closed');
    expect(p.gl!.issues.get(9)!.notes.join('\n')).toMatch(/Pass|P/);
    expect(p.repo.getBug(p.r.id, 'TC-BAOCAO-01')!.status).toBe('closed');
    expect(git(p.bare, 'log', '--oneline', 'main')).not.toMatch(/Merge/);
    const req = p.repo.getRequest(p.r.id)!;
    expect([req.stage, req.status]).toEqual(['DONE', 'done']);
    const report = readFileSync(join(p.ws.artifactsDir, 'report.md'), 'utf8');
    expect(report).toContain('http://gl/grp/app/-/merge_requests/1');
  });

  it('tester prompt marks mobile PE when ANDROID_HOME is missing', async () => {
    const p = prep({ testCases: [tcRow('TC-DANGNHAP-01', 'F-01')], stubs: ['DONE'] });
    p.repo.updateRequest(p.r.id, { softwareTypes: ['mobile', 'api'] });
    mockClaude({ tester: tester(p.ws.evidenceDir, [[{ tc_id: 'TC-DANGNHAP-01', status: 'PE', comment: 'thiếu môi trường mobile' }]]) });
    startAt(p.pipeline, p.r.id, 'TEST');
    await p.worker.drain();
    expect(calls[0]!.prompt).toContain('thiếu môi trường mobile');
    expect(calls[0]!.prompt).toMatch(/ANDROID_HOME.*(không|chưa)/);
    expect(p.repo.getTestCase(p.r.id, 'TC-DANGNHAP-01')!.status1).toBe('PE');
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('DONE');
  });

  it('develop in review mode gates only after the last task; a rejection runs a feedback work item', async () => {
    const p = prep({ tasks: true });
    p.repo.updateRequest(p.r.id, { runMode: 'review' });
    mockClaude({ developer, reviewer: reviewer([true]) });
    startAt(p.pipeline, p.r.id, 'DEVELOP');
    await p.worker.drain();
    let req = p.repo.getRequest(p.r.id)!;
    expect([req.stage, req.status]).toEqual(['DEVELOP', 'awaiting_approval']);
    expect(calls.map(c => c.role)).toEqual(['developer', 'reviewer', 'developer', 'reviewer']);
    p.pipeline.reject(p.r.id, 'Nút Đăng nhập phải màu xanh');
    await p.worker.drain();
    req = p.repo.getRequest(p.r.id)!;
    expect([req.stage, req.status]).toEqual(['DEVELOP', 'awaiting_approval']);
    expect(calls).toHaveLength(6);
    expect(calls[4]!.prompt).toContain('Nút Đăng nhập phải màu xanh');
    expect(git(p.ws.repoDir, 'log', '--merges', '--format=%s', p.branch)).toContain(`${p.branch}-feedback-1`);
  });

  it('bugfix on GitLab: fix branch → MR → merge, issue note "Đã sửa lần 1", then TEST', async () => {
    const tc = { ...tcRow('TC-BAOCAO-01', 'F-02'), status1: 'F' as const };
    const p = prep({ gitlab: true, testCases: [tc], stubs: ['TEST'] });
    p.gl!.seedIssue(4);
    p.repo.upsertBug(p.r.id, { tcId: 'TC-BAOCAO-01', gitlabIid: 4, fixAttempts: 0, status: 'open' });
    mockClaude({ developer, reviewer: reviewer([true]) });
    startAt(p.pipeline, p.r.id, 'BUGFIX');
    await p.worker.drain();
    expect(calls.map(c => c.role)).toEqual(['developer', 'reviewer']);
    expect(calls[0]!.prompt).toContain('systematic-debugging');
    expect(calls[0]!.prompt).toContain('TC-BAOCAO-01');
    const mrs = [...p.gl!.mrs.values()];
    expect(mrs.map(m => [m.source, m.target, m.state])).toEqual([[`${p.branch}-fix-TC-BAOCAO-01`, p.branch, 'merged']]);
    expect(p.gl!.issues.get(4)!.notes.join('\n')).toContain('Đã sửa lần 1');
    expect(p.repo.getBug(p.r.id, 'TC-BAOCAO-01')).toMatchObject({ fixAttempts: 1, status: 'fixed' });
    expect(git(p.bare, 'ls-tree', '-r', '--name-only', p.branch)).toContain('src/code-1.txt');
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('TEST');
  });

  it('TEST is idempotent: a GitLab error after results are saved → rerun reconciles without re-testing', async () => {
    const p = prep({ gitlab: true, testCases: [tcRow('TC-DANGNHAP-01', 'F-01'), tcRow('TC-BAOCAO-01', 'F-02')], stubs: ['BUGFIX'] });
    p.gl!.fail.createIssue = 1;
    mockClaude({
      tester: tester(p.ws.evidenceDir, [[
        { tc_id: 'TC-DANGNHAP-01', status: 'F', files: ['f.png'] },
        { tc_id: 'TC-BAOCAO-01', status: 'P', files: ['ok.png'] },
      ]]),
    });
    startAt(p.pipeline, p.r.id, 'TEST');
    await p.worker.drain(); // run 1 throws on createIssue; the engine retries the stage once
    expect(p.repo.listStageRuns(p.r.id).filter(s => s.stage === 'TEST').map(s => s.status)).toEqual(['failed', 'done']);
    expect(calls.map(c => c.role)).toEqual(['tester']);
    expect(p.gl!.issues.size).toBe(1);
    const a = p.repo.getTestCase(p.r.id, 'TC-DANGNHAP-01')!;
    const b = p.repo.getTestCase(p.r.id, 'TC-BAOCAO-01')!;
    expect([a.status1, a.status2]).toEqual(['F', null]);
    expect(a.comment).toContain('http://gl/grp/app/-/issues/1');
    expect([b.status1, b.status2]).toEqual(['P', null]);
    expect(b.evidence).toEqual(['evidence/TC-BAOCAO-01/ok.png']);
    const sh = await readSheet(join(p.ws.artifactsDir, `TestCase_${p.r.id}_v1.xlsx`));
    expect([sh.row(12).id, sh.row(12).s1, sh.row(13).id, sh.row(13).s1]).toEqual(['TC-DANGNHAP-01', 'F', 'TC-BAOCAO-01', 'P']);
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('BUGFIX');
  });

  it('develop skips merging an MR that GitLab already merged (crash after merge)', async () => {
    const p = prep({ gitlab: true, tasks: true, stubs: ['TEST'] });
    // T-01: review approved and MR merged before the crash; DB still says in_progress.
    const mr = await p.gl!.client.createMR(7, { source: `${p.branch}-T-01`, target: p.branch, title: 't', description: '' });
    p.gl!.mrs.get(mr.iid)!.state = 'merged';
    p.repo.updateTask(p.r.id, 'T-01', { status: 'in_progress', reviewRounds: 1, mrIid: mr.iid, branch: `${p.branch}-T-01` });
    mkdirSync(join(p.ws.repoDir, '.devflow-tmp'), { recursive: true });
    writeFileSync(join(p.ws.repoDir, '.devflow-tmp', 'review-T-01-r1.json'), JSON.stringify({ approved: true, comments: [] }));
    mockClaude({ developer, reviewer: reviewer([true]) });
    startAt(p.pipeline, p.r.id, 'DEVELOP');
    await p.worker.drain();
    expect(calls.map(c => c.role)).toEqual(['developer', 'reviewer']); // T-02 only
    expect(p.repo.listTasks(p.r.id).map(t => t.status)).toEqual(['done', 'done']);
    expect(p.repo.getRequest(p.r.id)!.stage).toBe('TEST');
  });

  it('planning rerun clears test history and bugs', async () => {
    const p = prep({ stubs: ['DEVELOP'] });
    p.repo.upsertBug(p.r.id, { tcId: 'TC-OLD-01', gitlabIid: null, fixAttempts: 2, status: 'open' });
    writeFileSync(join(p.ws.root, 'flow-state.json'), JSON.stringify({ runs: { 'TC-OLD-01': [{ run: 1, seq: 1, status: 'F', real_result: '', comment: '', evidence: [] }] }, issueUrls: { 'TC-OLD-01': 'u' }, reviewRounds: { keep: 1 } }));
    mockClaude({ planner: dir => { writeFileSync(join(dir, 'tasks.json'), JSON.stringify(TASKS)); writeFileSync(join(dir, 'testcases.json'), JSON.stringify(TCS)); } });
    startAt(p.pipeline, p.r.id, 'PLANNING');
    await p.worker.drain();
    expect(p.repo.listBugs(p.r.id)).toEqual([]);
    const st = JSON.parse(readFileSync(join(p.ws.root, 'flow-state.json'), 'utf8'));
    expect(st.runs).toEqual({});
    expect(st.issueUrls).toEqual({});
    expect(st.reviewRounds).toEqual({ keep: 1 });
  });

  it('DONE refuses to finish while a test case is F or a bug is open', async () => {
    const p = prep({ testCases: [{ ...tcRow('TC-BAOCAO-01', 'F-02'), status1: 'F' }] });
    p.repo.upsertBug(p.r.id, { tcId: 'TC-BAOCAO-01', gitlabIid: null, fixAttempts: 1, status: 'open' });
    startAt(p.pipeline, p.r.id, 'DONE');
    await p.worker.drain();
    const req = p.repo.getRequest(p.r.id)!;
    expect([req.stage, req.status]).toEqual(['DONE', 'failed']);
    expect(p.repo.listStageRuns(p.r.id).at(-1)!.error).toContain('TC-BAOCAO-01');
    expect(existsSync(join(p.ws.artifactsDir, 'report.md'))).toBe(false);
  });
});
