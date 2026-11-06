import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/domain/types.js';
import { buildServer } from '../../src/web/server.js';
import { git, mkUser } from '../projects/helpers.js';
import { enc, formHdr, origin, webEnv } from './v3-helpers.js';

type W = Awaited<ReturnType<typeof webEnv>>;
const withRole = (w: W, name: string, sysRole: 'head' | 'deputy' | 'cto' | 'admin', dept: 'DEV' | 'SGLOBAL' | null): UserRow => {
  const u = mkUser(w.repo, `${name}@x.com`, { dept });
  w.repo.web.setUserSysRole(u.id, sysRole);
  return w.repo.web.getUser(u.id)!;
};

/** DEV project ERP (webEnv) plus SGLOBAL project SGL, one oversight person per role and department. */
async function oenv() {
  const w = await webEnv();
  const pmS = mkUser(w.repo, 'pm-sg@x.com', { dept: 'SGLOBAL', canBePm: true });
  const sg = await w.svc.createProject({ mode: 'new', key: 'SGL', name: 'Sglobal app', path: join(w.root, 'sgl'), createdBy: pmS.id });
  const headDev = withRole(w, 'head-dev', 'head', 'DEV');
  const headSg = withRole(w, 'head-sg', 'head', 'SGLOBAL');
  const deputyDev = withRole(w, 'dep-dev', 'deputy', 'DEV');
  const cto = withRole(w, 'cto', 'cto', null);
  const admin = withRole(w, 'adm', 'admin', null);
  const loner = mkUser(w.repo, 'loner@x.com', { dept: 'SGLOBAL' });
  return { ...w, sg, pmS, headDev, headSg, deputyDev, cto, admin, loner };
}
const newReq = (w: W, code: string) => w.svc.createRequest({ projectId: w.p.id, code, title: code, description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: w.pm.id });

describe('oversight scoping', () => {
  it('head sees only own department projects and users', async () => {
    const w = await oenv();
    const proj = (await w.get(w.headDev.id, '/oversight/projects')).body;
    expect(proj).toContain('ERP');
    expect(proj).not.toContain('SGL');
    const users = (await w.get(w.headDev.id, '/oversight/users')).body;
    expect(users).toContain('dev@x.com');
    expect(users).toContain('head-dev@x.com');
    expect(users).not.toContain('pm-sg@x.com');
    expect(users).not.toContain('loner@x.com');
    const projS = (await w.get(w.headSg.id, '/oversight/projects')).body;
    expect(projS).toContain('SGL');
    expect(projS).not.toContain('ERP');
    expect((await w.get(w.deputyDev.id, '/oversight/projects')).body).not.toContain('SGL');
  });

  it('cto sees both departments', async () => {
    const w = await oenv();
    for (const who of [w.cto, w.admin]) {
      const proj = (await w.get(who.id, '/oversight/projects')).body;
      expect(proj).toContain('ERP');
      expect(proj).toContain('SGL');
      const users = (await w.get(who.id, '/oversight/users')).body;
      expect(users).toContain('dev@x.com');
      expect(users).toContain('pm-sg@x.com');
      expect(users).toContain('loner@x.com');
    }
  });

  it('cross-department project url returns 404 for head', async () => {
    const w = await oenv();
    for (const suffix of ['', '/files', '/files?path=README.md', '/docs', '/logs']) {
      expect((await w.get(w.headDev.id, `/oversight/projects/${w.sg.id}${suffix}`)).statusCode, suffix).toBe(404);
      expect((await w.get(w.headDev.id, `/oversight/projects/${w.p.id}${suffix}`)).statusCode, suffix).toBe(200);
      expect((await w.get(w.cto.id, `/oversight/projects/${w.sg.id}${suffix}`)).statusCode, suffix).toBe(200);
    }
    expect((await w.get(w.headDev.id, '/oversight/projects/99999')).statusCode).toBe(404);
    expect((await w.get(w.headDev.id, '/oversight/projects/abc')).statusCode).toBe(404);
    // a head of another department gets the same answer for an unknown id as for an existing one
    expect((await w.get(w.headSg.id, `/oversight/projects/${w.p.id}`)).body).toBe((await w.get(w.headSg.id, '/oversight/projects/99999')).body);
  });

  it('oversight routes are GET only (POST/PUT/DELETE -> 405 or 404)', async () => {
    const w = await oenv();
    const urls = ['/oversight', '/oversight/projects', '/oversight/users', '/oversight/blockers', `/oversight/projects/${w.p.id}`, `/oversight/projects/${w.p.id}/files`, `/oversight/projects/${w.p.id}/docs`, `/oversight/projects/${w.p.id}/logs`, '/oversight/anything'];
    for (const who of [w.cto, w.admin, w.headDev]) {
      for (const url of urls) {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
          const res = await w.app.inject({ method, url, payload: method === 'POST' ? enc({ a: 'b' }) : '', headers: { ...formHdr, cookie: w.cookie(who.id) } });
          expect([404, 405], `${method} ${url}`).toContain(res.statusCode);
        }
      }
    }
    const oversightRoutes = w.routes.filter(r => r.includes('/oversight'));
    expect(oversightRoutes.length).toBeGreaterThan(5);
    expect(oversightRoutes.filter(r => !r.startsWith('GET ') && !r.startsWith('HEAD '))).toEqual([]);
  });

  it('member and non-oversight roles get 403', async () => {
    const w = await oenv();
    const noDeptHead = withRole(w, 'head-none', 'head', null);
    for (const u of [w.pm, w.ba, w.se, w.dev, w.rev, w.tester, w.loner, noDeptHead]) {
      for (const url of ['/oversight', '/oversight/projects', '/oversight/users', '/oversight/blockers', `/oversight/projects/${w.p.id}`, `/oversight/projects/${w.p.id}/files`, `/oversight/projects/${w.p.id}/logs`]) {
        expect((await w.get(u.id, url)).statusCode, `${u.email} ${url}`).toBe(403);
      }
    }
    expect((await w.app.inject({ method: 'GET', url: '/oversight/projects', headers: { host: 'localhost:3000' } })).statusCode).toBe(302);
  });

  it('menu entry only for oversight roles', async () => {
    const w = await oenv();
    expect((await w.get(w.cto.id, '/projects')).body).toContain('/oversight/projects');
    expect((await w.get(w.headDev.id, '/projects')).body).toContain('/oversight/projects');
    expect((await w.get(w.dev.id, '/projects')).body).not.toContain('/oversight/projects');
  });
});

describe('oversight data', () => {
  it('blockers list contains awaiting_seat, failed, CR awaiting PM and bug at cap', async () => {
    const w = await oenv();
    const a = await newReq(w, 'REQ-A'); w.repo.updateRequest(a.id, { stage: 'DEVELOP', status: 'awaiting_seat' });
    const b = await newReq(w, 'REQ-B'); w.repo.updateRequest(b.id, { stage: 'ANALYSIS', status: 'failed' });
    const c = await newReq(w, 'REQ-C'); w.repo.updateRequest(c.id, { stage: 'CHANGE', status: 'awaiting_approval' });
    w.repo.createChangeRequest(c.id, { title: 'x', description: 'd', kind: 'add', source: 'staff', status: 'awaiting_decision' });
    const d = await newReq(w, 'REQ-D'); w.repo.updateRequest(d.id, { stage: 'BUGFIX', status: 'running' });
    w.repo.upsertBug(d.id, { tcId: 'TC-77', gitlabIid: null, fixAttempts: 3, status: 'open' });
    const e = await newReq(w, 'REQ-E'); w.repo.updateRequest(e.id, { stage: 'CLARIFY', status: 'awaiting_customer' });
    const f = await newReq(w, 'REQ-F'); w.repo.updateRequest(f.id, { stage: 'DESIGN', status: 'running' });
    w.repo.addApproval({ requestId: f.id, stage: 'DESIGN', userId: w.se.id, decision: 'reject' });
    const ok = await newReq(w, 'REQ-OK'); w.repo.updateRequest(ok.id, { stage: 'ANALYSIS', status: 'running' });
    const body = (await w.get(w.cto.id, '/oversight/blockers')).body;
    for (const [code, label] of [['REQ-A', 'Chờ người phụ trách kết nối Claude'], ['REQ-B', 'Lỗi'], ['REQ-C', 'Thay đổi yêu cầu chờ PM quyết định'], ['REQ-D', 'Bug đã sửa quá số lần cho phép'], ['REQ-E', 'Chờ khách hàng trả lời'], ['REQ-F', 'Bị từ chối, đang chờ sửa']] as const) {
      const row = body.split('<tr>').find(r => r.includes(`<td>${code}</td>`));
      expect(row, code).toBeTruthy();
      expect(row).toContain(label);
    }
    expect(body).toContain('TC-77');
    expect(body).not.toContain('<td>REQ-OK</td>');
    // scoped: head of the other department sees none of them
    expect((await w.get(w.headSg.id, '/oversight/blockers')).body).not.toContain('REQ-A');
    // project page: progress and blockers
    const page = (await w.get(w.headDev.id, `/oversight/projects/${w.p.id}`)).body;
    expect(page).toContain('REQ-OK');
    expect(page).toContain('Chờ người phụ trách kết nối Claude');
  });

  it('shows per-person work: tasks, running jobs, waiting approvals', async () => {
    const w = await oenv();
    const r = await newReq(w, 'REQ-W');
    w.repo.upsertTask(r.id, { id: 'T-01', title: 'Làm form', featureId: null, dependsOn: [], status: 'in_progress', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: 'active', changedByCr: null, assigneeId: w.dev.id });
    w.repo.updateRequest(r.id, { stage: 'ANALYSIS', status: 'awaiting_approval' });
    const body = (await w.get(w.cto.id, '/oversight/users')).body;
    const row = (email: string) => body.split('<tr>').find(x => x.includes(email))!;
    expect(row('dev@x.com')).toContain('Làm form');
    expect(row('ba@x.com')).toMatch(/<td>0<\/td>\s*<td>1<\/td>/); // running 0, waiting approval 1
  });

  it('seat status shown without credentials', async () => {
    const w = await oenv();
    const runner = {
      kind: 'sudo' as const, run: async () => ({ ok: true, resultText: '' }), login: () => { throw new Error('no'); }, logout: async () => {}, sweepProject: async () => {},
      status: async (id: number) => (id === w.dev.id
        ? { state: 'connected' as const, email: 'secret-acct@claude.test', org: 'SecretOrg', token: 'sk-ant-oat01-ZZZZZZZZZZZZZZZZZZZZZZZZ', credentialsPath: '/home/dfu-5/.claude/.credentials.json' }
        : { state: 'disconnected' as const }),
    };
    const app = await buildServer(w.cfg, { repo: w.repo, pipeline: w.pipeline, seatRunner: runner as never, projects: w.svc });
    try {
      const res = await app.inject({ method: 'GET', url: '/oversight/users', headers: { cookie: w.cookie(w.cto.id), host: 'localhost:3000' } });
      const row = (email: string) => res.body.split('<tr>').find(x => x.includes(email))!;
      expect(row('dev@x.com')).toContain('Đã kết nối');
      expect(row('ba@x.com')).toContain('Chưa kết nối');
      expect(res.body).not.toMatch(/secret-acct|SecretOrg|sk-ant|credentials|dfu-5|password_hash|gitlab_token/i);
    } finally { await app.close(); }
  });
});

describe('oversight content over HTTP', () => {
  it('serves escaped file content, hides secrets, audits every view', async () => {
    const w = await oenv();
    const dir = w.p.path;
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.html'), '<script>alert("xss")</script><b>hi</b>');
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    writeFileSync(join(dir, 'k.pem'), 'PEM');
    writeFileSync(join(dir, 'd.bin'), Buffer.from([0, 1, 2]));
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'files');
    const get = (u: string, who = w.headDev) => w.get(who.id, `/oversight/projects/${w.p.id}/files${u}`);
    const f = await get('?path=src%2Fx.html');
    expect(f.statusCode).toBe(200);
    expect(f.body).toContain('&lt;script&gt;alert(');
    expect(f.body).not.toContain('<script>alert("xss")');
    expect(f.headers['content-type']).toContain('text/html'); // the page; the file is only ever inside an escaped <pre>
    expect(f.headers['x-content-type-options']).toBe('nosniff');
    const root = await get('');
    expect(root.body).toContain('src');
    expect(root.body).not.toContain('.env');
    expect(root.body).not.toContain('k.pem');
    expect((await get('?path=.env')).statusCode).toBe(404);
    expect((await get('?path=k.pem')).statusCode).toBe(404);
    expect((await get('?path=.git%2Fconfig')).statusCode).toBe(404);
    expect((await get('?path=..%2Fx')).statusCode).toBe(400);
    expect((await get('?ref=--output%3D%2Ftmp%2Fx')).statusCode).toBe(400);
    expect((await get('?path=d.bin')).body).toContain('nhị phân');
    const audit = w.repo.web.listAudit({ projectId: w.p.id, limit: 50 });
    expect(audit.filter(a => a.action === 'oversight.content').length).toBe(3);
    expect(audit.filter(a => a.action === 'oversight.content.denied').length).toBe(5);
    expect(audit.filter(a => a.action.startsWith('oversight.')).every(a => a.userId === w.headDev.id)).toBe(true);
  });

  it('serves redacted request logs and a docs index', async () => {
    const w = await oenv();
    await newReq(w, 'REQ-L');
    const logs = join(w.p.path, '.devflow', 'requests', 'REQ-L', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'ANALYSIS-1.log'), 'hello <b>x</b>\nAuthorization: Bearer topsecret\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const idx = await w.get(w.cto.id, `/oversight/projects/${w.p.id}/logs`);
    expect(idx.body).toContain('ANALYSIS-1.log');
    const one = await w.get(w.cto.id, `/oversight/projects/${w.p.id}/logs?code=REQ-L&file=ANALYSIS-1.log`);
    expect(one.body).toContain('hello &lt;b&gt;x&lt;/b&gt;');
    expect(one.body).not.toMatch(/topsecret|ghp_abc/);
    expect((await w.get(w.cto.id, `/oversight/projects/${w.p.id}/logs?code=REQ-L&file=..%2F..%2Fx.log`)).statusCode).toBe(400);
    expect((await w.get(w.cto.id, `/oversight/projects/${w.p.id}/logs?code=NOPE&file=a.log`)).statusCode).toBe(404);
    const docs = await w.get(w.cto.id, `/oversight/projects/${w.p.id}/docs`);
    expect(docs.body).toContain('docs%2Fdevflow%2FREQ-L');
  });
});
void origin;
