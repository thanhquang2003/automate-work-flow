import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { clearMockHandler, setMockHandler } from '../../src/claude/mock.js';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { clearStages, Pipeline } from '../../src/engine/pipeline.js';
import { registerAllStages } from '../../src/engine/stages/index.js';
import { Worker } from '../../src/engine/worker.js';
import { buildServer } from '../../src/web/server.js';
import { fakeGitLab } from '../fixtures/fake-gitlab.js';
import { e2eMock, FAILS_FIRST } from '../fixtures/mock-claude.js';
import { git, initRepo } from '../engine/stage-helpers.js';

const HOST = 'localhost:3700';
const HEADERS = { origin: `http://${HOST}`, host: HOST };

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); clearMockHandler(); clearStages(); });

/** The whole app (real Pipeline + Worker + web server), fake GitLab over a local bare remote, mock Claude. */
async function boot(withGitLab: boolean) {
  const cfg: Config = { ...loadConfig({ DEVFLOW_MODE: 'local', CLAUDE_MOCK: '1' }), dataDir: mkdtempSync(join(tmpdir(), 'devflow-e2e-')) };
  const root = mkdtempSync(join(tmpdir(), 'devflow-e2e-remote-'));
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
  const pipeline = new Pipeline(cfg, repo, { makeGitLab: () => (withGitLab ? gl.client : undefined) });
  clearStages();
  registerAllStages();
  const worker = new Worker(cfg, repo, pipeline);
  const mock = e2eMock();
  setMockHandler(mock.handler);
  const app = await buildServer(cfg, { repo, pipeline });
  apps.push(app);

  const post = (url: string) => app.inject({ method: 'POST', url, headers: HEADERS });
  /** Runs queued jobs until the request reaches `status` (the worker is driven by hand instead of polling). */
  const waitFor = async (id: string, status: string, stage?: string) => {
    for (let i = 0; i < 200; i++) {
      await worker.drain();
      const r = repo.getRequest(id)!;
      if (r.status === status && (!stage || r.stage === stage)) return r;
      if (['failed', 'needs_human', 'cancelled'].includes(r.status)) throw new Error(`Request ${id} ${r.status} at ${r.stage}: ${repo.listEvents(id).slice(-3).map(e => e.message).join(' | ')}`);
    }
    throw new Error(`Timed out waiting for ${status}`);
  };
  return { cfg, repo, app, bare, gl, mock, post, waitFor };
}

function multipart(fields: [string, string][], file?: { name: string; filename: string; content: Buffer }) {
  const b = '----devflowe2e';
  const parts: Buffer[] = [];
  for (const [k, v] of fields) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), file.content, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { ...HEADERS, 'content-type': `multipart/form-data; boundary=${b}` } };
}

const text = (v: ExcelJS.CellValue): string => (v && typeof v === 'object' && 'text' in v ? String(v.text) : v == null ? '' : String(v));

describe('end-to-end pipeline over HTTP', () => {
  it('auto mode: request → clarify via Excel → develop → test F/P → bugfix → regression → done', async () => {
    const t = await boot(true);
    const created = await t.app.inject({
      method: 'POST', url: '/requests',
      ...multipart([['title', 'Hệ thống bán hàng'], ['description', 'Đăng nhập và báo cáo doanh thu'], ['project_kind', 'existing'], ['gitlab_project', 'grp/app'], ['run_mode', 'auto'], ['software_types', 'web']]),
    });
    expect(created.statusCode).toBe(302);
    const id = created.headers.location!.split('/').pop()!;
    expect(id).toBe('REQ-001');
    const branch = `devflow/${id}`;

    // ---- wait for the clarify questions ----
    await t.waitFor(id, 'awaiting_customer', 'CLARIFY');
    expect(t.mock.roles).toEqual(['explorer', 'analyst']);

    // ---- download the questions workbook, answer, import ----
    const dl = await t.app.inject({ method: 'GET', url: `/requests/${id}/questions.xlsx`, headers: HEADERS });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain(`Questions_${id}_round1.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.rawPayload as unknown as ArrayBuffer);
    let answered = 0;
    wb.worksheets[0]!.eachRow(row => { if (text(row.getCell(1).value) === 'Q-01') { row.getCell(7).value = 'Nhân viên'; answered++; } });
    expect(answered).toBe(1);
    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const imp = await t.app.inject({ method: 'POST', url: `/requests/${id}/answers/import`, ...multipart([], { name: 'file', filename: 'answers.xlsx', content: out }) });
    expect(imp.statusCode).toBe(302);
    expect(decodeURIComponent(imp.headers.location!)).toContain('Đã nhập 1 câu trả lời');
    expect(t.repo.latestAnswers(id).get('Q-01')).toBe('Nhân viên');

    // ---- continue → runs to the end ----
    const cont = await t.post(`/requests/${id}/continue`);
    expect(cont.statusCode).toBe(302);
    const done = await t.waitFor(id, 'done');
    expect(done.stage).toBe('DONE');

    // Roles: scan, analyst x2, breakdown, architect, planner, 2 tasks (dev+review), test, bugfix, test, regression.
    expect(t.mock.roles).toEqual([
      'explorer', 'analyst', 'analyst',
      'analyst-breakdown', 'architect', 'planner',
      'developer', 'reviewer', 'developer', 'reviewer',
      'tester', 'developer', 'reviewer', 'tester', 'tester',
    ]);
    expect(t.repo.listStageRuns(id).map(s => s.stage).filter((s, i, a) => a[i - 1] !== s)).toEqual([
      'INTAKE', 'CODEBASE_SCAN', 'ANALYSIS', 'CLARIFY', 'ANALYSIS', 'BREAKDOWN', 'DESIGN', 'PLANNING', 'DEVELOP', 'TEST', 'BUGFIX', 'TEST', 'DONE',
    ]);

    // ---- fake GitLab: one issue, created then closed; task + fix MRs merged; final MR opened, not merged ----
    expect([...t.gl.issues.values()].map(i => [i.title.includes(FAILS_FIRST), i.labels, i.state])).toEqual([[true, ['bug', 'devflow', id], 'closed']]);
    expect([...t.gl.mrs.values()].map(m => [m.source, m.target, m.state])).toEqual([
      [`${branch}-T-01`, branch, 'merged'],
      [`${branch}-T-02`, branch, 'merged'],
      [`${branch}-fix-${FAILS_FIRST}`, branch, 'merged'],
      [branch, 'main', 'opened'],
    ]);
    // Default branch untouched; work reached the integration branch on the remote.
    expect(git(t.bare, 'log', '--format=%s', 'main')).toEqual('readme\ninit');
    expect(git(t.bare, 'ls-tree', '-r', '--name-only', branch)).toContain('src/code-1.txt');

    // ---- regression: the third Tester run covers every test case ----
    const testerPrompts = t.mock.prompts.filter(p => p.role === 'tester').map(p => p.prompt);
    expect(testerPrompts[1]).toContain(`\`${FAILS_FIRST}\``);
    expect(testerPrompts[1]).not.toContain('`TC-BAOCAO-01`');
    expect(testerPrompts[2]).toContain(`\`${FAILS_FIRST}\``);
    expect(testerPrompts[2]).toContain('`TC-BAOCAO-01`');

    // ---- artifacts ----
    const art = join(t.cfg.dataDir, 'workspaces', id, 'artifacts');
    for (const f of [`TKCT_${id}.docx`, `TKDB_${id}.docx`, `ULNL_${id}.xlsx`, `TestCase_${id}.xlsx`, 'report.md']) expect(existsSync(join(art, f)), f).toBe(true);
    const tc = new ExcelJS.Workbook();
    await tc.xlsx.readFile(join(art, `TestCase_${id}.xlsx`));
    const sh = tc.getWorksheet('2. FUNCTIONAL TESTCASE')!;
    let row = 0;
    sh.eachRow((r, n) => { if (text(r.getCell('A').value) === FAILS_FIRST) row = n; });
    expect(row).toBeGreaterThan(0);
    expect(text(sh.getCell(`I${row}`).value)).toBe('F');
    expect(text(sh.getCell(`J${row}`).value)).toBe('P');
    expect(text(sh.getCell(`M${row}`).value)).toContain(`evidence/${FAILS_FIRST}/`);
    const report = readFileSync(join(art, 'report.md'), 'utf8');
    expect(report).toContain('http://gl/grp/app/-/merge_requests/4');
    expect(report).toMatch(/P\s*\|\s*2/);

    // ---- the UI renders the finished request and serves its files ----
    for (const tab of ['overview', 'tasks', 'tests', 'bugs', 'docs']) {
      const page = await t.app.inject({ method: 'GET', url: `/requests/${id}?tab=${tab}`, headers: HEADERS });
      expect(page.statusCode, tab).toBe(200);
    }
    const tests = await t.app.inject({ method: 'GET', url: `/requests/${id}?tab=tests`, headers: HEADERS });
    expect(tests.body).toContain(FAILS_FIRST);
    const file = await t.app.inject({ method: 'GET', url: `/requests/${id}/files/report.md`, headers: HEADERS });
    expect(file.statusCode).toBe(200);
    const bundle = await t.app.inject({ method: 'GET', url: `/requests/${id}/bundle.zip`, headers: HEADERS });
    expect(bundle.statusCode).toBe(200);
  }, 55_000);

  it('review mode stops at the ANALYSIS gate; approve continues', async () => {
    const t = await boot(false);
    const created = await t.app.inject({
      method: 'POST', url: '/requests',
      ...multipart([['title', 'Quản lý kho'], ['description', 'Nhập xuất kho'], ['project_kind', 'new'], ['run_mode', 'review'], ['software_types', 'web']]),
    });
    expect(created.statusCode).toBe(302);
    const id = created.headers.location!.split('/').pop()!;

    const gate = await t.waitFor(id, 'awaiting_approval');
    expect(gate.stage).toBe('ANALYSIS');
    expect(t.mock.roles).toEqual(['analyst']);
    const page = await t.app.inject({ method: 'GET', url: `/requests/${id}`, headers: HEADERS });
    expect(page.body).toContain('/approve');

    const ok = await t.post(`/requests/${id}/approve`);
    expect(ok.statusCode).toBe(302);
    const next = await t.waitFor(id, 'awaiting_customer');
    expect(next.stage).toBe('CLARIFY');
    expect(t.mock.roles).toEqual(['analyst']); // nothing more to run until the customer answers
    expect(t.gl.mrs.size).toBe(0);
  }, 30_000);
});
