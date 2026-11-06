import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { clearMockHandler, setMockHandler } from '../../src/claude/mock.js';
import type { RunOpts, RunResult } from '../../src/claude/runner.js';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import type { ImpactOutT } from '../../src/domain/types.js';
import { clearStages, Pipeline } from '../../src/engine/pipeline.js';
import { registerAllStages } from '../../src/engine/stages/index.js';
import { Worker } from '../../src/engine/worker.js';
import { hashPassword } from '../../src/security/crypto.js';
import { signSession } from '../../src/web/auth.js';
import { buildServer } from '../../src/web/server.js';
import { Workspace } from '../../src/engine/workspace.js';
import { writeProjectInfo } from '../../src/engine/stages/common.js';
import { fakeGitLab } from '../fixtures/fake-gitlab.js';
import { e2eMock } from '../fixtures/mock-claude.js';
import { git, initRepo, outputPaths, roleOf } from '../engine/stage-helpers.js';

const HOST = 'localhost:3700';
const HEADERS = { origin: `http://${HOST}`, host: HOST };

const apps: FastifyInstance[] = [];
const tmpDirs: string[] = [];
const tempDir = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  clearMockHandler();
  clearStages();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const INCR = '## Thay đổi đã chấp nhận';
const NEW_SECTION = (code: string, name: string): string =>
  `\n## ${code} - ${name}\n### Tổng quan\nMới.\n### Đối tượng sử dụng\nNgười dùng.\n### Giao diện\nForm.\n### Luồng dữ liệu\nA.\n### Chi tiết\nB.\n`;

const IMPACT_MD = (id: string): string => `# ${id} — Thay đổi

## Tóm tắt
Thay đổi mẫu.

## Phạm vi thay đổi
Xem impact.json.

## Ảnh hưởng
### Chức năng
- (xem impact.json)

## Nỗ lực dự kiến
Nhỏ.

## Rủi ro
- Không.

## Câu hỏi cho khách hàng
Không.
`;

type Impacts = Record<string, Omit<ImpactOutT, 'cr_id'>>;

/** E2E mock Claude + a change-analyst (impacts by CR id) + incremental BREAKDOWN/PLANNING/DESIGN updates. */
function crMock(impacts: Impacts) {
  const base = e2eMock();
  const handler = (opts: RunOpts): RunResult => {
    const role = roleOf(opts.prompt);
    const dir = join(opts.cwd, 'docs', 'devflow');
    const write = (p: string, body: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };
    const incremental = opts.prompt.includes(INCR);
    if (role === 'change-analyst') {
      base.roles.push(role); base.prompts.push({ role, prompt: opts.prompt });
      for (const p of outputPaths(opts.prompt).filter(x => x.endsWith('impact.json'))) {
        const crId = /(CR-\d+)[\\/]impact\.json$/.exec(p)![1]!;
        write(join(p, '..', 'impact.md'), IMPACT_MD(crId));
        write(p, JSON.stringify({ cr_id: crId, ...impacts[crId]! }));
      }
      return { ok: true, resultText: 'ok' };
    }
    const r = base.handler(opts);
    const readJson = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
    if (role === 'analyst') write(join(dir, 'questions.json'), JSON.stringify({ questions: [] })); // no clarify wait
    if (role === 'architect' && incremental) {
      const f = join(dir, 'design', 'tkct.md');
      writeFileSync(f, readFileSync(f, 'utf8').replace('# PHỤ LỤC', `${NEW_SECTION('THONGBAO', 'Thông báo')}# PHỤ LỤC`));
    }
    if (role === 'analyst-breakdown' && incremental) {
      const j = readJson('features.json');
      j.features.push({ id: 'F-03', code: 'THONGBAO', name: 'Thông báo', description: 'Gửi thông báo email', type_code: 'CN_WEB1', unit_test: false, note: '', kind: 'function' });
      write(join(dir, 'features.json'), JSON.stringify(j));
    }
    if (role === 'planner' && incremental) {
      // The base planner rewrote the E2E fixture: re-apply what earlier change requests added.
      const tasks = readJson('tasks.json'); const tcs = readJson('testcases.json');
      tasks.tasks.push({ id: 'T-03', title: 'Gửi thông báo email', feature_id: 'F-03', depends_on: ['T-01'] });
      tcs.test_cases.push({ id: 'TC-THONGBAO-01', feature_id: 'F-03', purpose: 'Nhận email', data: '', steps: '1. Gửi', expected: 'Có mail' });
      if (opts.prompt.includes('### CR-02')) {
        for (const t of tasks.tasks) if (t.feature_id === 'F-02') t.scope_status = 'cancelled';
        for (const t of tcs.test_cases) if (t.feature_id === 'F-02') t.scope_status = 'cancelled';
        tasks.tasks.push({ id: 'T-04', title: 'Gỡ menu báo cáo', feature_id: 'F-01', depends_on: ['T-01'] });
      }
      write(join(dir, 'tasks.json'), JSON.stringify(tasks));
      write(join(dir, 'testcases.json'), JSON.stringify(tcs));
    }
    return r;
  };
  return { ...base, handler };
}

const impact = (over: Partial<ImpactOutT>): Omit<ImpactOutT, 'cr_id'> => ({
  summary: 'Tóm tắt', scope: { add: [], modify: [], remove: [] }, affected: { features: [], tasks: [], test_cases: [] }, questions: [], effort_delta_mh: 8, risks: ['Không'], reenter: 'BREAKDOWN', ...over,
});

const multipart = (fields: string[][]) => {
  const b = '----devflowcr';
  return { payload: fields.map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${b}--\r\n`, headers: { ...HEADERS, 'content-type': `multipart/form-data; boundary=${b}` } };
};

async function boot(impacts: Impacts, server = false) {
  const cfg: Config = {
    ...loadConfig({ DEVFLOW_MODE: 'local', CLAUDE_MOCK: '1' }), dataDir: tempDir('devflow-cr-'),
    ...(server ? { mode: 'server' as const, secretKey: 'test-secret', host: '0.0.0.0' } : {}),
  };
  const root = tempDir('devflow-cr-remote-');
  const bare = join(root, 'app.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(root, 'seed');
  initRepo(seed, 'main');
  writeFileSync(join(seed, 'README.md'), '# app\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'readme');
  git(seed, 'push', '-q', bare, 'main');
  const gl = fakeGitLab(bare);
  const repo = new Repo(openDb(':memory:'));
  const pipeline = new Pipeline(cfg, repo, { makeGitLab: () => gl.client, allowLocalSeatsInServerMode: true });
  clearStages();
  registerAllStages();
  const worker = new Worker(cfg, repo, pipeline);
  const mock = crMock(impacts);
  setMockHandler(mock.handler);
  const app = await buildServer(cfg, { repo, pipeline });
  apps.push(app);
  const post = (url: string, payload: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { ...HEADERS, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(payload).toString() });

  /** Runs one job at a time until `pred` holds (or the request stops in a failure state). */
  const until = async (id: string, pred: () => boolean) => {
    for (let i = 0; i < 300; i++) {
      if (pred()) return;
      const r = repo.getRequest(id)!;
      if (['failed', 'needs_human', 'cancelled'].includes(r.status)) throw new Error(`Request ${id} ${r.status} at ${r.stage}: ${repo.listEvents(id).slice(-3).map(e => e.message).join(' | ')}`);
      await worker.tick();
      await worker.idle();
    }
    throw new Error('Timed out');
  };
  const waitStatus = async (id: string, status: string, stage?: string) => {
    await until(id, () => { const r = repo.getRequest(id)!; return r.status === status && (!stage || r.stage === stage); });
    return repo.getRequest(id)!;
  };
  const submitCr = (id: string, title: string, kind: string) =>
    app.inject({ method: 'POST', url: `/requests/${id}/changes`, ...multipart([['title', title], ['description', `Mô tả ${title}`], ['kind', kind]]) });
  return { cfg, repo, app, bare, gl, mock, post, until, waitStatus, submitCr, worker };
}

const docxXml = async (p: string): Promise<string> => (await JSZip.loadAsync(readFileSync(p))).file('word/document.xml')!.async('string');
/** Task ids the developer was assigned (bug-fix runs have no task header). */
const taskHeads = (prompts: { role: string; prompt: string }[]): string[] =>
  prompts.filter(p => p.role === 'developer').flatMap(p => /\*\*Task (T-\d+)/.exec(p.prompt)?.[1] ?? []);

describe('change requests end-to-end', () => {
  it('add (auto-accepted mid-DEVELOP) → remove (gated, new iteration) → reject on done', async () => {
    const t = await boot({
      'CR-01': impact({ summary: 'Thêm thông báo', scope: { add: [{ name: 'Thông báo', description: 'Gửi email' }], modify: [], remove: [] } }),
      'CR-02': impact({ summary: 'Bỏ báo cáo', scope: { add: [], modify: [], remove: ['F-02'] }, affected: { features: ['F-02'], tasks: ['T-02'], test_cases: ['TC-BAOCAO-01'] }, effort_delta_mh: -10, reenter: 'BREAKDOWN' }),
      'CR-03': impact({ summary: 'Đổi ý', scope: { add: [], modify: [{ feature_id: 'F-01', change: 'x' }], remove: [] }, affected: { features: ['F-01'], tasks: [], test_cases: [] }, effort_delta_mh: 100, reenter: 'DESIGN' }),
    });
    const created = await t.app.inject({
      method: 'POST', url: '/requests',
      ...multipart([['title', 'Bán hàng'], ['description', 'Đăng nhập và báo cáo'], ['project_kind', 'existing'], ['gitlab_project', 'grp/app'], ['run_mode', 'auto'], ['software_types', 'web']]),
    });
    const id = created.headers.location!.split('/').pop()!;
    const art = join(t.cfg.dataDir, 'workspaces', id, 'artifacts');

    // ---- (a) CR add, submitted after the first task merged ----
    await t.until(id, () => t.repo.getRequest(id)!.stage === 'DEVELOP' && t.repo.listTasks(id).some(x => x.status === 'done'));
    expect(t.repo.listTasks(id).filter(x => x.status === 'done').map(x => x.id)).toEqual(['T-01']);
    const devBefore = t.mock.prompts.length;
    const res = await t.submitCr(id, 'Thêm thông báo email', 'add');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('ok=');
    expect(t.repo.getChangeRequest(id, 'CR-01')!.status).toBe('pending');

    await t.waitStatus(id, 'done');
    expect(t.repo.getChangeRequest(id, 'CR-01')).toMatchObject({ status: 'applied', baselineFrom: 1, baselineTo: 2 });
    expect(t.repo.getRequest(id)).toMatchObject({ stage: 'DONE', baselineVersion: 2, iteration: 1 });
    expect(t.repo.listFeatures(id).map(f => f.id)).toContain('F-03');
    expect(t.repo.listTasks(id).map(x => [x.id, x.status])).toEqual([['T-01', 'done'], ['T-02', 'done'], ['T-03', 'done']]);
    expect(t.repo.listTestCases(id).map(x => x.id)).toContain('TC-THONGBAO-01');
    // T-01 (done before the CR) is never redone; T-02 was not yet developed.
    expect(taskHeads(t.mock.prompts.slice(devBefore))).toEqual(['T-02', 'T-03']);
    expect(t.mock.roles).toContain('change-analyst');
    for (const f of [`TKCT_${id}_v1.docx`, `TKCT_${id}_v2.docx`, `TKDB_${id}_v2.docx`, `ULNL_${id}_v1.xlsx`, `ULNL_${id}_v2.xlsx`, `TestCase_${id}_v1.xlsx`, `TestCase_${id}_v2.xlsx`]) expect(existsSync(join(art, f)), f).toBe(true);
    const xml = await docxXml(join(art, `TKCT_${id}_v2.docx`));
    expect(xml).toContain('Lịch sử thay đổi');
    expect(xml).toContain('CR-01');

    // ---- (b) CR remove on the done request: waits even in auto mode ----
    const devAfterA = t.mock.prompts.length;
    await t.submitCr(id, 'Bỏ báo cáo', 'remove');
    await t.waitStatus(id, 'awaiting_approval', 'CHANGE');
    expect(t.repo.getChangeRequest(id, 'CR-02')!.status).toBe('awaiting_decision');
    expect(t.mock.roles.slice(devAfterA)).toEqual(['change-analyst']);
    const dec = await t.post(`/requests/${id}/changes/CR-02/decide`, { decision: 'accept', note: 'ok' });
    expect(dec.statusCode).toBe(302);
    expect(t.repo.getChangeRequest(id, 'CR-02')).toMatchObject({ status: 'accepted', baselineFrom: 2, baselineTo: 3 });
    await t.waitStatus(id, 'done');
    expect(t.repo.getRequest(id)).toMatchObject({ stage: 'DONE', baselineVersion: 3, iteration: 2 });
    expect(t.repo.listFeatures(id).find(f => f.id === 'F-02')).toMatchObject({ scopeStatus: 'cancelled', changedByCr: 'CR-02' });
    expect(t.repo.listTasks(id).find(x => x.id === 'T-02')).toMatchObject({ scopeStatus: 'cancelled', changedByCr: 'CR-02' });
    expect(t.repo.getTestCase(id, 'TC-BAOCAO-01')).toMatchObject({ scopeStatus: 'cancelled', changedByCr: 'CR-02' });
    expect(t.repo.listTasks(id).find(x => x.id === 'T-04')).toMatchObject({ status: 'done', scopeStatus: 'active' });
    expect(taskHeads(t.mock.prompts.slice(devAfterA))).toEqual(['T-04']);
    expect(existsSync(join(art, `TKCT_${id}_v3.docx`))).toBe(true);
    const xlsxText = async (f: string): Promise<string> => {
      const zip = await JSZip.loadAsync(readFileSync(join(art, f)));
      return (await Promise.all(Object.keys(zip.files).filter(n => /comments|sharedStrings/.test(n)).map(n => zip.file(n)!.async('string')))).join('');
    };
    expect(existsSync(join(art, `ULNL_${id}_v3.xlsx`))).toBe(true);
    expect(await xlsxText(`ULNL_${id}_v3.xlsx`)).toContain('Hủy theo CR-02');
    expect(await xlsxText(`TestCase_${id}_v3.xlsx`)).toContain('Hủy theo CR-02');
    // One final MR for the whole life, noted for the second iteration.
    const finals = [...t.gl.mrs.values()].filter(m => m.target === 'main');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.state).toBe('opened');
    expect(finals[0]!.notes.length).toBeGreaterThan(0);

    // ---- (c) reject on the done request: back to done, nothing re-runs ----
    await t.submitCr(id, 'Đổi ý lớn', 'modify');
    await t.waitStatus(id, 'awaiting_approval', 'CHANGE');
    const rolesAt = t.mock.roles.length;
    const rej = await t.post(`/requests/${id}/changes/CR-03/decide`, { decision: 'reject', note: 'Không làm' });
    expect(rej.statusCode).toBe(302);
    expect(t.repo.getRequest(id)).toMatchObject({ stage: 'DONE', status: 'done', baselineVersion: 3, iteration: 2 });
    await t.worker.drain();
    expect(t.mock.roles.length).toBe(rolesAt);
    expect(t.repo.getChangeRequest(id, 'CR-03')!.status).toBe('rejected');
    expect(t.repo.listJobs(id).filter(j => j.status === 'queued')).toEqual([]);
    expect([...t.gl.mrs.values()].filter(m => m.target === 'main')).toHaveLength(1);
  }, 55_000);

  it('customer proposal via the public survey → staff accepts → CHANGE auto-accepts → request continues', async () => {
    const t = await boot({ 'CR-01': impact({ summary: 'Đề xuất nhỏ', reenter: 'ANALYSIS' }) }, true);
    const r = t.repo.createRequest({
      title: 'Kho', description: 'Quản lý kho', perfReq: '', nonfuncReq: '', projectKind: 'new', gitlabProject: null, softwareTypes: ['web'], runMode: 'auto', createdBy: null,
    });
    const ws = Workspace.for(t.cfg, r.id).ensure();
    initRepo(ws.repoDir, `devflow/${r.id}`);
    writeProjectInfo(ws, { gitlab: false, branch: `devflow/${r.id}` });
    t.repo.updateRequest(r.id, { stage: 'CLARIFY', status: 'awaiting_customer' });
    t.repo.web.createSurveyLink({ token: 'tokcr', requestId: r.id, round: 1, expiresAt: Date.now() + 86_400_000 });
    const origin = new URL(t.cfg.publicBaseUrl).host;
    const sres = await t.app.inject({
      method: 'POST', url: '/s/tokcr', headers: { origin: t.cfg.publicBaseUrl, host: origin, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ action: 'draft', proposal: 'Xin thêm xuất báo cáo Excel' }).toString(),
    });
    expect(sres.statusCode).toBe(200);
    expect(t.repo.getChangeRequest(r.id, 'CR-01')).toMatchObject({ status: 'proposed', source: 'customer', description: 'Xin thêm xuất báo cáo Excel' });
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CLARIFY', status: 'awaiting_customer' });

    const u = t.repo.web.createUser({ username: 'staff', passwordHash: hashPassword('password1'), role: 'admin' });
    const acc = await t.app.inject({
      method: 'POST', url: `/requests/${r.id}/changes/CR-01/accept-proposal`,
      headers: { origin: t.cfg.publicBaseUrl, host: origin, cookie: `devflow_sid=${signSession(t.cfg.secretKey, u.id)}`, 'content-type': 'application/x-www-form-urlencoded' }, payload: '',
    });
    expect(acc.statusCode).toBe(302);
    await t.until(r.id, () => t.repo.getChangeRequest(r.id, 'CR-01')!.status === 'accepted' && t.repo.getRequest(r.id)!.stage !== 'CHANGE');
    expect(t.repo.getChangeRequest(r.id, 'CR-01')).toMatchObject({ baselineFrom: 1, baselineTo: 2, decisionNote: 'Tự động chấp nhận' });
    expect(t.repo.getRequest(r.id)).toMatchObject({ baselineVersion: 2 });
    expect(t.mock.roles).toContain('change-analyst');
  }, 30_000);
});
