import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { LoginSession } from '../../src/claude/seat-login.js';
import type { RunOpts, RunResult } from '../../src/claude/runner.js';
import type { SeatRunner, SeatState } from '../../src/claude/seat-runner.js';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { clearStages, Pipeline } from '../../src/engine/pipeline.js';
import { registerAllStages } from '../../src/engine/stages/index.js';
import { Worker } from '../../src/engine/worker.js';
import { wireProjects } from '../../src/projects/wire.js';
import { COOKIE } from '../../src/web/auth.js';
import type { OidcClaims, OidcClient } from '../../src/web/oidc.js';
import { buildServer } from '../../src/web/server.js';
import { fakeGitLab } from '../fixtures/fake-gitlab.js';
import { E2E_TASKS, e2eMock } from '../fixtures/mock-claude.js';
import { git, initRepo, outputPaths, roleOf } from '../engine/stage-helpers.js';
import { FakeLogin } from '../web/v3-helpers.js';

// Whole v3 flow in server mode: Google SSO (fake issuer), real Pipeline + Worker + web, a fake SeatRunner that
// records which user ran every Claude call, a fake GitLab over a bare remote. Deterministic: explicit promise gates.

const HOST = 'localhost:3000';
const BASE = `http://${HOST}`;
const T = 180_000;

interface Deferred<V = void> { promise: Promise<V>; resolve(v: V): void }
const deferred = <V = void>(): Deferred<V> => { let resolve!: (v: V) => void; const promise = new Promise<V>(r => { resolve = r; }); return { promise, resolve }; };

interface CallRec { userId: number | null; cwd: string; wt: string; role: string; prompt: string; outcome: 'ok' | 'aborted' | 'seatError'; }
interface Hold { match: (c: { wt: string; role: string; userId: number | null }) => boolean; started: Deferred; release: Deferred; used: boolean }

const enc = (o: Record<string, string | string[]>): string =>
  Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`)).join('&');

function multipart(fields: [string, string][]) {
  const b = '----devflowv3';
  const body = fields.map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${b}--\r\n`;
  return { payload: Buffer.from(body), headers: { origin: BASE, host: HOST, 'content-type': `multipart/form-data; boundary=${b}` } };
}

const dirs: string[] = [];
const tmp = (p: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };

type W = Awaited<ReturnType<typeof boot>>;

async function boot() {
  const base = tmp('devflow-v3e2e-');
  const root = join(base, 'roots');
  mkdirSync(root);
  const cfg: Config = {
    ...loadConfig({
      DEVFLOW_MODE: 'server', CLAUDE_MOCK: '1', SECRET_KEY: 'e2e-secret', PUBLIC_BASE_URL: BASE,
      GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', ALLOWED_EMAIL_DOMAINS: 'corp.com',
      ADMIN_EMAILS: 'root@corp.com', CTO_EMAILS: 'cto@corp.com',
      HEAD_EMAILS: 'DEV:head@corp.com;SGLOBAL:sghead@corp.com',
    }),
    dataDir: join(base, 'data'), projectRoots: [root], maxConcurrentJobs: 4, seatConcurrency: 1,
  };

  // Bare remote with a seed commit that also carries secret files the oversight viewer must hide.
  const bare = join(base, 'app.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = join(base, 'seed');
  initRepo(seed, 'main');
  writeFileSync(join(seed, 'README.md'), '# app\n');
  writeFileSync(join(seed, '.env'), 'TOPSECRET=hunter2-planted\n');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'readme');
  git(seed, 'push', '-q', bare, 'main');
  const gl = fakeGitLab(bare);

  const repo = new Repo(openDb(':memory:'));
  const timeline: string[] = [];

  // ---- fake SeatRunner: records user + cwd per call, delegates output to the fixture mock ----
  const mock = e2eMock();
  const calls: CallRec[] = [];
  const seatState = new Map<number, SeatState>();
  const holds: Hold[] = [];
  const logins: FakeLogin[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runner: SeatRunner = {
    kind: 'sudo',
    async run(userId, opts: RunOpts): Promise<RunResult> {
      const wt = basename(opts.cwd);
      const role = roleOf(opts.prompt);
      const rec: CallRec = { userId, cwd: opts.cwd, wt, role, prompt: opts.prompt, outcome: 'ok' };
      calls.push(rec);
      const st = userId === null ? undefined : seatState.get(userId);
      if (st === 'expired' || st === 'disconnected') { rec.outcome = 'seatError'; return { ok: false, resultText: '', error: 'Claude login expired', seatError: st }; }
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const hold = holds.find(h => !h.used && h.match({ wt, role, userId }));
        if (hold) {
          hold.used = true;
          hold.started.resolve();
          const aborted = new Promise<'abort'>(res => {
            if (opts.signal?.aborted) res('abort');
            opts.signal?.addEventListener('abort', () => res('abort'), { once: true });
          });
          const r = await Promise.race([hold.release.promise.then(() => 'go' as const), aborted]);
          if (r === 'abort') { rec.outcome = 'aborted'; timeline.push(`abort:${userId}:${wt}`); return { ok: false, aborted: true, resultText: '', error: 'aborted' }; }
        }
        if (opts.signal?.aborted) { rec.outcome = 'aborted'; return { ok: false, aborted: true, resultText: '', error: 'aborted' }; }
        return v3Output(mock.handler, opts);
      } finally { inFlight--; }
    },
    login(): LoginSession { const l = new FakeLogin(); logins.push(l); return l; },
    async status(userId) { return { state: seatState.get(userId) ?? 'connected' }; },
    async logout() { /* nothing */ },
    async sweepProject(projectId, worktree) { timeline.push(`sweep:${projectId}:${basename(worktree)}`); },
  };

  const pipeline = new Pipeline(cfg, repo, { seatRunner: runner, makeGitLab: () => gl.client });
  clearStages();
  registerAllStages();
  const worker = new Worker(cfg, repo, pipeline);
  const systemOps = {
    groups: [] as [number, string][], members: [] as [number, number[]][], provisioned: [] as number[],
    ensureProjectGroup: async (id: number, path: string) => { systemOps.groups.push([id, path]); },
    setMembers: async (id: number, users: number[]) => { timeline.push(`setMembers:${users.join(',')}`); systemOps.members.push([id, users]); },
    provisionUser: async (id: number) => { systemOps.provisioned.push(id); },
  };
  const svc = wireProjects({ cfg, repo, pipeline, systemOps });

  // ---- fake OIDC issuer ----
  const current: { claims: OidcClaims } = { claims: { sub: '', email: '', emailVerified: true, name: '' } };
  const seen: { state?: string; nonce?: string } = {};
  const oidc: OidcClient = {
    async authUrl(p) { seen.state = p.state; seen.nonce = p.nonce; return `https://accounts.example/auth?state=${p.state}`; },
    async exchange(p) { if (p.nonce !== seen.nonce) throw new Error('nonce'); return current.claims; },
  };
  const app: FastifyInstance = await buildServer(cfg, { repo, pipeline, oidc, seatRunner: runner, projects: svc, systemOps });

  const cookies = new Map<string, string>();
  /** A real Google round trip (state/nonce/PKCE cookie); returns the session cookie. */
  const login = async (email: string): Promise<string> => {
    current.claims = { sub: `sub-${email}`, email, emailVerified: true, name: email.split('@')[0]! };
    const start = await app.inject({ method: 'GET', url: '/auth/google', headers: { host: HOST } });
    const ck = String(start.headers['set-cookie']).split(';')[0]!;
    const cb = await app.inject({ method: 'GET', url: `/auth/google/callback?code=abc&state=${seen.state}`, headers: { host: HOST, cookie: ck } });
    const sc = ([] as string[]).concat(cb.headers['set-cookie'] as string[] | string ?? []).find(x => x.startsWith(`${COOKIE}=`));
    if (!sc) throw new Error(`login of ${email} failed: ${cb.statusCode}`);
    const c = sc.split(';')[0]!;
    cookies.set(email, c);
    return c;
  };
  const uid = (email: string): number => repo.web.getUserByEmail(email)!.id;
  const cookieOf = (email: string): string => cookies.get(email) ?? '';
  const get = (email: string, url: string) => app.inject({ method: 'GET', url, headers: { host: HOST, cookie: cookies.get(email) ?? '' } });
  const post = (email: string, url: string, body: Record<string, string | string[]> = {}) =>
    app.inject({ method: 'POST', url, payload: enc(body), headers: { origin: BASE, host: HOST, 'content-type': 'application/x-www-form-urlencoded', cookie: cookies.get(email) ?? '' } });

  /** Runs jobs until `pred` holds. Only for phases without held calls (drain waits for every running job). */
  const settle = async (pred: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      await worker.drain();
      if (pred()) return;
      const bad = repo.listRequests().filter(r => ['failed', 'needs_human', 'cancelled'].includes(r.status));
      if (bad.length) throw new Error(`${what}: ${bad.map(r => `${r.id} ${r.status}@${r.stage}: ${repo.listEvents(r.id).slice(-3).map(e => e.message).join(' | ')}`).join(' ; ')}`);
            if (!repo.listRequests().some(r => r.status === 'running')) throw new Error(`${what}: nothing left to run but the condition is false: ${JSON.stringify(repo.listRequests().map(r => [r.code, r.stage, r.status]))} jobs=${JSON.stringify(repo.listJobs().filter(j => j.status !== 'done').map(j => [j.requestId, j.kind, j.status, j.payload]))} runs=${JSON.stringify(repo.listStageRuns('REQ-001').map(r => [r.stage, r.attempt, r.status]))} events=${JSON.stringify(repo.listEvents('REQ-001').slice(-14).map(e => e.message))}`);
    }
    throw new Error(`timed out: ${what}`);
  };
  const within = <V,>(p: Promise<V>, what: string, ms = 30_000): Promise<V> => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms).unref())]);
  /** Ticks the worker (jobs may chain: CLARIFY then BREAKDOWN) until `p` resolves; yields to I/O instead of sleeping. */
  const pumpUntil = async (p: Promise<unknown>, what: string): Promise<void> => {
    let done = false;
    void p.then(() => { done = true; });
    await within((async () => { while (!done) { await worker.tick(); await new Promise(r => setImmediate(r)); } })(), what);
  };
  const hold = (match: Hold['match']): Hold => { const h: Hold = { match, started: deferred(), release: deferred(), used: false }; holds.push(h); return h; };
  const gate = (id: string): string => pipeline.gateToken(repo.getRequest(id)!);

  return { pumpUntil, within, cookieOf, cfg, repo, app, bare, gl, mock, calls, seatState, logins, timeline, systemOps, worker, pipeline, login, uid, get, post, settle, hold, gate, maxInFlight: () => maxInFlight, base, root };
}

/**
 * The fixture mock writes to <cwd>/docs/devflow; v3 keeps a request's docs in <worktree>/docs/devflow/<code>.
 * Run it in a scratch folder and copy its docs over; developer/reviewer write src files and absolute outputs.
 * The planner gets two independent tasks so both Devs can work at the same time.
 */
const analystRuns = new Map<string, number>();
function v3Output(handler: (o: RunOpts) => RunResult, opts: RunOpts): RunResult {
  const role = roleOf(opts.prompt);
  if (role === 'developer' || role === 'reviewer') return handler(opts);
  const scratch = tmp('devflow-v3e2e-scratch-');
  const r = handler({ ...opts, cwd: scratch });
  const src = join(scratch, 'docs', 'devflow');
  const dst = join(opts.cwd, 'docs', 'devflow', basename(opts.cwd));
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
  if (role === 'analyst') {
    // The fixture asks its question on the first analyst call of the whole run; ask it once per request instead.
    const n = (analystRuns.get(basename(opts.cwd)) ?? 0) + 1;
    analystRuns.set(basename(opts.cwd), n);
    const q = { id: 'Q-01', category: 'Chức năng', question: 'Ai được đăng nhập?', why: 'Phân quyền', type: 'single', options: ['Nhân viên', 'Khách hàng'], suggested_answer: 'Nhân viên', priority: 'must' };
    writeFileSync(join(dst, 'questions.json'), JSON.stringify({ questions: n === 1 ? [q] : [] }));
  }
  if (role === 'planner') {
    const tasks = E2E_TASKS.tasks.map(t => ({ ...t, depends_on: [] as string[] }));
    writeFileSync(join(dst, 'tasks.json'), JSON.stringify({ tasks }));
  }
  return r;
}

describe('v3 multi-user end to end', () => {
  let w: W;
  beforeAll(async () => { w = await boot(); }, T);
  afterAll(async () => {
    await w?.app.close();
    clearStages();
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const EMAILS = { head: 'head@corp.com', pm: 'pm@corp.com', ba1: 'ba1@corp.com', ba2: 'ba2@corp.com', se: 'se@corp.com', dev1: 'dev1@corp.com', dev2: 'dev2@corp.com', rev: 'rev@corp.com', tester: 'tester@corp.com', outsider: 'outsider@corp.com', cto: 'cto@corp.com', sghead: 'sghead@corp.com' };
  const E = EMAILS;
  const A = 'ALPHA-1';
  const B = 'BETA-2';
  let projectId = 0;
  let projectPath = '';
  const id = (k: keyof typeof EMAILS): number => w.uid(E[k]);
  const status = (code: string) => w.repo.listRequests().find(r => r.code === code)!;
  const rid = (code: string): string => status(code).id;
  const at = (code: string, stage: string, st = 'awaiting_approval') => () => { const r = status(code); return r.stage === stage && r.status === st; };
  const approve = (email: string, code: string, extra: Record<string, string> = {}) =>
    w.post(email, `/requests/${rid(code)}/approve`, { expect: w.gate(rid(code)), ...extra });
  const approvalCount = (code: string): number => w.repo.listApprovals(rid(code)).length;
  /** Wrong people get 403 and nothing changes (status, stage, approvals, queued jobs). */
  const expectDenied = async (code: string, emails: string[]) => {
    for (const e of emails) {
      const before = JSON.stringify([status(code).stage, status(code).status, approvalCount(code), w.repo.listJobs?.(rid(code))?.length]);
      const res = await approve(e, code);
      expect(res.statusCode, `${e} approving ${code} at ${status(code).stage}/${status(code).status} ${res.headers.location} ${JSON.stringify(w.repo.listApprovals(rid(code)).slice(-2))}`).toBe(403);
      const rej = await w.post(e, `/requests/${rid(code)}/reject`, { expect: w.gate(rid(code)), feedback: 'không' });
      expect(rej.statusCode, `${e} rejecting ${code}`).toBe(403);
      expect(JSON.stringify([status(code).stage, status(code).status, approvalCount(code), w.repo.listJobs?.(rid(code))?.length])).toBe(before);
    }
  };

  it('onboarding: head enables a PM, the PM creates the project, members and two requests', async () => {
    for (const e of Object.values(E)) await w.login(e);
    expect(w.repo.web.getUserByEmail(E.head)!.sysRole).toBe('head');
    expect(w.repo.web.getUserByEmail(E.sghead)!.departmentId).toBe(w.repo.web.getDepartmentByCode('SGLOBAL')!.id);
    expect(w.repo.web.getUserByEmail(E.cto)!.sysRole).toBe('cto');
    // Seat provisioning happened at first login.
    expect(w.systemOps.provisioned).toContain(id('pm'));

    // Nobody can create a project yet; the head brings people into DEV and marks the PM.
    expect((await w.post(E.pm, '/projects', { key: 'ERP', name: 'ERP', mode: 'existing', path: join(w.root, 'erp') })).statusCode).toBe(403);
    for (const k of ['pm', 'ba1', 'ba2', 'se', 'dev1', 'dev2', 'rev', 'tester', 'outsider'] as const) {
      expect((await w.post(E.head, `/dept/pm/${id(k)}/assign`)).statusCode, k).toBe(302);
    }
    expect((await w.post(E.pm, `/dept/pm/${id('ba1')}/can-pm`, { value: '1' })).statusCode).toBe(403); // a PM is not a head
    expect((await w.post(E.sghead, `/dept/pm/${id('pm')}/can-pm`, { value: '1' })).statusCode).toBe(403); // other department
    expect((await w.post(E.head, `/dept/pm/${id('pm')}/can-pm`, { value: '1' })).statusCode).toBe(302);
    expect(w.repo.web.getUserByEmail(E.pm)!.canBePm).toBe(true);

    // The project is an existing clone of the bare remote (no hard links), linked to the fake GitLab project.
    projectPath = join(w.root, 'erp');
    git(w.base, 'clone', '-q', '--no-local', w.bare, projectPath);
    const created = await w.post(E.pm, '/projects', { key: 'ERP', name: 'ERP', mode: 'existing', path: projectPath, gitlab_project: 'grp/app' });
    expect(created.statusCode).toBe(302);
    projectId = Number(created.headers.location!.split('/').pop());
    expect(w.systemOps.groups).toEqual([[projectId, projectPath]]);

    // Members: two BAs, SE, two DEVs, REVIEWER, TESTER; the other-department head and an outsider cannot touch it.
    const roles: Record<string, string[]> = {
      [`r_${id('pm')}`]: ['PM'], [`r_${id('ba1')}`]: ['BA'], [`r_${id('ba2')}`]: ['BA'], [`r_${id('se')}`]: ['SE'],
      [`r_${id('dev1')}`]: ['DEV'], [`r_${id('dev2')}`]: ['DEV'], [`r_${id('rev')}`]: ['REVIEWER'], [`r_${id('tester')}`]: ['TESTER'],
    };
    expect((await w.post(E.outsider, `/projects/${projectId}/members`, roles)).statusCode).toBe(403);
    expect((await w.post(E.sghead, `/projects/${projectId}/members`, roles)).statusCode).toBe(403);
    expect((await w.post(E.pm, `/projects/${projectId}/members`, roles)).statusCode).toBe(302);
    expect(w.repo.listProjectMembers(projectId).map(m => m.userId).sort()).toEqual(Object.keys(roles).map(k => Number(k.slice(2))).sort());
    expect(w.systemOps.members.at(-1)![1]).toHaveLength(8);

    // Two requests with custom codes (ALPHA-1 / BETA-2). B has two BAs, ba2 first.
    const req = (code: string, ba: number[], runnerBa: number) => w.app.inject({
      method: 'POST', url: `/projects/${projectId}/requests`,
      ...multipart([
        ['code', code], ['title', `Yêu cầu ${code}`], ['description', 'Đăng nhập và báo cáo'], ['run_mode', 'review'], ['software_types', 'web'],
        ['a_PM', String(id('pm'))], ...ba.map(b => ['a_BA', String(b)] as [string, string]), ['runner_BA', String(runnerBa)],
        ['a_SE', String(id('se'))], ['a_DEV', String(id('dev1'))], ['a_DEV', String(id('dev2'))], ['runner_DEV', String(id('dev1'))],
        ['a_REVIEWER', String(id('rev'))], ['a_TESTER', String(id('tester'))],
      ]),
      headers: { ...multipart([]).headers, cookie: w.cookieOf(E.pm) },
    });
    // The picked code must not collide with an existing branch / other request code.
    expect((await req('ERP/1', [id('ba1')], id('ba1'))).statusCode).toBe(400);
    expect((await req(A, [id('ba1')], id('ba1'))).statusCode).toBe(302);
    expect((await req(B, [id('ba2'), id('ba1')], id('ba2'))).statusCode).toBe(302);
    expect((await req('ALPHA-1', [id('ba1')], id('ba1'))).statusCode).toBe(400); // duplicate
    expect((await req('ALPHA-1-X', [id('ba1')], id('ba1'))).statusCode).toBe(400); // prefix collision with ALPHA-1
    expect(w.repo.listRequestsByProject(projectId).map(r => r.code).sort()).toEqual([A, B]);
    expect(w.repo.getRunner(rid(B), 'BA')).toBe(id('ba2'));
  }, T);

  it('parallel requests reach the first gate; every Claude call is on the right seat inside a worktree', async () => {
    await w.settle(() => at(A, 'CODEBASE_SCAN')() && at(B, 'CODEBASE_SCAN')(), 'CODEBASE_SCAN gates');
    const scans = w.calls.filter(c => c.role === 'explorer');
    // The codebase map is cached per GitLab project: the first request scans, the second reuses it.
    expect(scans).toHaveLength(1);
    expect([A, B]).toContain(scans[0]!.wt);
    expect(scans[0]!.userId).toBe(id('se'));
    for (const c of w.calls) expect(dirname(c.cwd), c.wt).toBe(join(projectPath, '.devflow', 'worktrees'));
    // Both request worktrees exist on their own branches.
    expect(git(projectPath, 'worktree', 'list')).toContain('.devflow/worktrees/ALPHA-1');
    expect(git(projectPath, 'worktree', 'list')).toContain('.devflow/worktrees/BETA-2');
    // Wrong role / other department / non-member / cto: 403 and no state change. SE of the project may approve.
    await expectDenied(A, [E.dev1, E.ba1, E.rev, E.outsider, E.sghead, E.cto, E.tester]);
    expect((await approve(E.se, A)).statusCode).toBe(302);
    expect((await approve(E.pm, B)).statusCode).toBe(302); // the PM may approve any gate
    expect(w.repo.listApprovals(rid(A)).map(a => [a.stage, a.userId, a.decision])).toEqual([['CODEBASE_SCAN', id('se'), 'approve']]);
  }, T);

  it('ANALYSIS runs on both BAs at the same time; only the request BAs approve; CLARIFY needs a BA', async () => {
    const hA = w.hold(c => c.wt === A && c.role === 'analyst');
    const hB = w.hold(c => c.wt === B && c.role === 'analyst');
    await w.worker.tick();
    // Explicit rendezvous: both analyst calls are inside Claude at the same moment, on different seats and worktrees.
    await w.within(Promise.all([hA.started.promise, hB.started.promise]), 'both analyst calls in flight');
    expect(w.maxInFlight()).toBeGreaterThanOrEqual(2);
    const live = w.calls.filter(c => c.role === 'analyst');
    expect(live.map(c => [c.wt, c.userId]).sort()).toEqual([[A, id('ba1')], [B, id('ba2')]].sort());
    hA.release.resolve(); hB.release.resolve();
    await w.settle(() => at(A, 'ANALYSIS')() && at(B, 'ANALYSIS')(), 'ANALYSIS gates');

    // ba2 is a project BA but not an assignee of ALPHA-1: refused. Developers, other department, CTO: refused.
    await expectDenied(A, [E.ba2, E.dev1, E.se, E.outsider, E.sghead, E.cto, E.tester]);
    expect((await approve(E.ba1, A)).statusCode).toBe(302);
    expect((await approve(E.ba1, B)).statusCode).toBe(302); // either assignee of the role may approve
    await w.settle(() => at(A, 'CLARIFY', 'awaiting_customer')() && at(B, 'CLARIFY', 'awaiting_customer')(), 'CLARIFY');

    const qid = w.repo.listQuestions(rid(A))[0]!.id;
    const before = JSON.stringify(w.repo.latestAnswers(rid(A)).entries().toArray?.() ?? [...w.repo.latestAnswers(rid(A))]);
    for (const e of [E.dev1, E.tester, E.rev, E.outsider, E.cto]) {
      expect((await w.post(e, `/requests/${rid(A)}/answers`, { qid, answer: 'Nhân viên' })).statusCode, e).toBe(403);
      expect((await w.post(e, `/requests/${rid(A)}/continue`)).statusCode, e).toBe(403);
    }
    expect(JSON.stringify([...w.repo.latestAnswers(rid(A))])).toBe(before);
    expect(status(A).status).toBe('awaiting_customer');
    for (const [code, ba] of [[A, 'ba1'], [B, 'ba2']] as const) {
      expect((await w.post(E[ba], `/requests/${rid(code)}/answers`, { qid: w.repo.listQuestions(rid(code))[0]!.id, answer: 'Nhân viên' })).statusCode).toBe(302);
      expect((await w.post(E[ba], `/requests/${rid(code)}/continue`)).statusCode).toBe(302);
    }
    await w.settle(() => at(A, 'ANALYSIS')() && at(B, 'ANALYSIS')(), 'ANALYSIS gates, round 2');
    expect((await approve(E.ba1, A)).statusCode).toBe(302);
    expect((await approve(E.ba2, B)).statusCode).toBe(302);
  }, T);

  it('runner changed mid-run: BREAKDOWN of BETA-2 continues on the new seat without a retry', async () => {
    const h = w.hold(c => c.wt === B && c.role === 'analyst-breakdown');
    await w.pumpUntil(h.started.promise, 'BREAKDOWN call in flight'); // ba2 is inside Claude
    expect(w.repo.getRunner(rid(B), 'BA')).toBe(id('ba2'));
    // Stale click (wrong expected runner) is refused and changes nothing.
    const stale = await w.post(E.pm, `/requests/${rid(B)}/assignees`, { role: 'BA', user: String(id('ba1')), op: 'first', expect_runner: String(id('ba1')) });
    expect(stale.statusCode).toBe(409);
    expect(w.repo.getRunner(rid(B), 'BA')).toBe(id('ba2'));
    // Wrong role cannot change the runner.
    expect((await w.post(E.dev1, `/requests/${rid(B)}/assignees`, { role: 'BA', user: String(id('ba1')), op: 'first', expect_runner: String(id('ba2')) })).statusCode).toBe(403);
    const res = await w.post(E.pm, `/requests/${rid(B)}/assignees`, { role: 'BA', user: String(id('ba1')), op: 'first', expect_runner: String(id('ba2')) });
    expect(res.statusCode).toBe(302);
    await w.settle(() => at(A, 'BREAKDOWN')() && at(B, 'BREAKDOWN')(), 'BREAKDOWN gates');

    const bd = w.calls.filter(c => c.wt === B && c.role === 'analyst-breakdown');
    expect(bd.map(c => [c.userId, c.outcome])).toEqual([[id('ba2'), 'aborted'], [id('ba1'), 'ok']]);
    expect(w.calls.filter(c => c.wt === A && c.role === 'analyst-breakdown').map(c => [c.userId, c.outcome])).toEqual([[id('ba1'), 'ok']]);
    // No failure, no retry counted: the stopped run is cancelled and the job re-enqueued with errRetries untouched.
    const runs = w.repo.listStageRuns(rid(B)).filter(r => r.stage === 'BREAKDOWN').map(r => r.status);
    expect(runs).toContain('cancelled');
    expect(runs).not.toContain('failed');
    for (const j of w.repo.listJobs(rid(B))) expect((j.payload as { errRetries?: number }).errRetries ?? 0).toBe(0);
    expect(status(B).status).toBe('awaiting_approval');
  }, T);

  it('expired seat parks the stage as awaiting_seat; reconnecting resumes it', async () => {
    w.seatState.set(id('se'), 'expired');
    expect((await approve(E.ba1, A)).statusCode).toBe(302);
    expect((await approve(E.ba2, B)).statusCode).toBe(302);
    await w.settle(() => at(A, 'DESIGN', 'awaiting_seat')() && at(B, 'DESIGN', 'awaiting_seat')(), 'awaiting_seat');
    const arch = w.calls.filter(c => c.role === 'architect');
    expect(arch.length).toBeGreaterThan(0);
    expect(arch.every(c => c.outcome === 'seatError' && c.userId === id('se'))).toBe(true);
    for (const code of [A, B]) {
      expect(status(code).status).toBe('awaiting_seat');
      expect(w.repo.listStageRuns(rid(code)).filter(r => r.stage === 'DESIGN').map(r => r.status)).toContain('awaiting_seat');
    }
    // The CTO sees it as a blocker.
    const bl = await w.get(E.cto, `/oversight/projects/${projectId}`);
    expect(bl.statusCode).toBe(200);
    expect(bl.body).toContain(A);

    // The SE reconnects through the seat page: the login succeeds and the parked jobs wake up at once.
    w.seatState.set(id('se'), 'connected');
    expect((await w.post(E.se, '/seat/connect')).statusCode).toBe(302);
    const login = w.logins.at(-1)!;
    login.finish({ success: true });
    await login.result;
    await w.settle(() => at(A, 'DESIGN')() && at(B, 'DESIGN')(), 'DESIGN gates after reconnect');
    expect(w.calls.filter(c => c.role === 'architect' && c.outcome === 'ok').every(c => c.userId === id('se'))).toBe(true);
    expect((await approve(E.se, A)).statusCode).toBe(302);
    expect((await approve(E.se, B)).statusCode).toBe(302);
  }, T);

  /** Gate users per stage for the happy path. */
  const finishGatesUntil = async (code: string, stage: string): Promise<void> => {
    await w.settle(() => at(code, stage)(), `${code} at ${stage}`);
  };

  it('PLANNING: DEV runs tasks, TESTER runs test cases; only the PM approves', async () => {
    await w.settle(() => at(A, 'PLANNING')() && at(B, 'PLANNING')(), 'PLANNING gates');
    for (const code of [A, B]) {
      const users = new Set(w.calls.filter(c => c.wt === code && c.role === 'planner').map(c => c.userId));
      expect(users).toEqual(new Set([id('dev1'), id('tester')]));
    }
    await expectDenied(A, [E.ba1, E.se, E.rev, E.dev1, E.tester, E.outsider, E.sghead, E.cto]);
    expect((await approve(E.pm, A)).statusCode).toBe(302);
  }, T);

  it('DEVELOP: two Devs work in parallel worktrees; merges are serialized; reviewer approves; TEST/BUGFIX; PM closes', async () => {
    const mergeCalls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const origMerge = w.gl.client.mergeMR.bind(w.gl.client);
    w.gl.client.mergeMR = (async (...a: Parameters<typeof origMerge>) => {
      active++; maxActive = Math.max(maxActive, active); mergeCalls.push(String(a[1]));
      await new Promise(r => setImmediate(r));
      try { return await origMerge(...a); } finally { active--; }
    }) as typeof origMerge;

    // Tasks exist after PLANNING: the PM gives T-02 to the second Dev (a reviewer cannot).
    expect((await w.post(E.rev, `/requests/${rid(A)}/tasks/T-02/assign`, { user: String(id('dev2')) })).statusCode).toBe(403);
    expect((await w.post(E.pm, `/requests/${rid(A)}/tasks/T-02/assign`, { user: String(id('dev2')) })).statusCode).toBe(302);
    expect(w.repo.getTask(rid(A), 'T-02')!.assigneeId).toBe(id('dev2'));

    // Rendezvous: both developer calls are inside Claude at the same moment.
    const d1 = w.hold(c => c.wt === `${A}-T-01` && c.role === 'developer');
    const d2 = w.hold(c => c.wt === `${A}-T-02` && c.role === 'developer');
    await w.pumpUntil(Promise.all([d1.started.promise, d2.started.promise]), 'both developers in flight').catch(e => { throw new Error(`${e.message} ${JSON.stringify([w.repo.listRequests().map(r => [r.code, r.stage, r.status]), w.repo.listJobs(rid(A)).slice(-6).map(j => [j.kind, j.status, j.payload, j.seatUserId, j.lastError]), w.calls.slice(-4).map(c => [c.wt, c.role, c.userId, c.outcome]), w.repo.listTasks(rid(A)).map(t => [t.id, t.status, t.assigneeId]), w.repo.listEvents(rid(A)).slice(-6).map(e => e.message)])}`); });
    const devs = w.calls.filter(c => c.wt.startsWith(`${A}-T-`) && c.role === 'developer');
    expect(new Map(devs.map(c => [c.wt, c.userId]))).toEqual(new Map([[`${A}-T-01`, id('dev1')], [`${A}-T-02`, id('dev2')]]));
    expect(new Set(devs.map(c => c.cwd)).size).toBe(2);
    expect(existsSync(join(projectPath, '.devflow', 'worktrees', `${A}-T-01`))).toBe(true);
    expect(existsSync(join(projectPath, '.devflow', 'worktrees', `${A}-T-02`))).toBe(true);
    d1.release.resolve(); d2.release.resolve();
    await finishGatesUntil(A, 'DEVELOP');

    expect(maxActive).toBe(1);
    expect([...w.gl.mrs.values()].filter(m => m.target === `devflow/${A}` && m.state === 'merged').map(m => m.source).sort()).toEqual([`devflow/${A}-T-01`, `devflow/${A}-T-02`]);
    const tree = git(projectPath, 'ls-tree', '-r', '--name-only', `devflow/${A}`);
    expect(tree).toMatch(/src\/code-\d+\.txt/);
    expect(w.calls.filter(c => c.role === 'reviewer' && c.wt.startsWith(A)).every(c => c.userId === id('rev'))).toBe(true);

    // DEVELOP gate: the reviewer approves; developers, BA, tester, other department do not.
    await expectDenied(A, [E.dev1, E.dev2, E.ba1, E.se, E.tester, E.outsider, E.sghead, E.cto]);
    expect((await approve(E.rev, A)).statusCode).toBe(302);
    await finishGatesUntil(A, 'DONE'); // TEST fails one case, BUGFIX fixes it on the task's Dev, TEST passes
    const bug = w.calls.filter(c => c.wt.startsWith(A) && c.role === 'developer').at(-1)!;
    expect(bug.userId).toBe(id('dev1')); // the failing feature's task belongs to dev1
    expect(w.calls.filter(c => c.wt === A && c.role === 'tester').every(c => c.userId === id('tester'))).toBe(true);

    // DONE: PM only.
    await expectDenied(A, [E.rev, E.ba1, E.se, E.dev1, E.tester, E.outsider, E.sghead, E.cto]);
    expect((await approve(E.pm, A)).statusCode).toBe(302);
    expect(status(A).status).toBe('done');

    // Deliverables are committed under docs/devflow/<code>/deliverables/ and pushed; the final MR is opened, not merged.
    const files = git(projectPath, 'ls-tree', '-r', '--name-only', `devflow/${A}`).split('\n');
    expect(files.some(f => f.startsWith(`docs/devflow/${A}/deliverables/`))).toBe(true);
    expect(git(w.bare, 'ls-tree', '-r', '--name-only', `devflow/${A}`)).toContain(`docs/devflow/${A}/deliverables/`);
    expect([...w.gl.mrs.values()].find(m => m.source === `devflow/${A}` && m.target === 'main')?.state).toBe('opened');
    expect(git(w.bare, 'log', '--format=%s', 'main')).toBe('readme\ninit');
  }, T);

  it('removing a member stops their running job first; the work moves to the remaining Dev', async () => {
    expect((await approve(E.pm, B)).statusCode).toBe(302);
    expect((await w.post(E.pm, `/requests/${rid(B)}/tasks/T-02/assign`, { user: String(id('dev2')) })).statusCode).toBe(302);
    const h = w.hold(c => c.wt === `${B}-T-02` && c.role === 'developer');
    await w.pumpUntil(h.started.promise, 'dev2 inside Claude');
    expect(w.calls.at(-1)!.userId === id('dev2') || w.calls.some(c => c.wt === `${B}-T-02` && c.userId === id('dev2'))).toBe(true);

    const keep = w.repo.listProjectMembers(projectId).filter(m => m.userId !== id('dev2'));
    const body: Record<string, string[]> = Object.fromEntries(keep.map(m => [`r_${m.userId}`, m.roles]));
    expect((await w.post(E.dev1, `/projects/${projectId}/members`, body)).statusCode).toBe(403);
    expect((await w.post(E.pm, `/projects/${projectId}/members`, body)).statusCode).toBe(302);
    const aborted = w.timeline.indexOf(`abort:${id('dev2')}:${B}-T-02`);
    const groupChange = w.timeline.indexOf(`setMembers:${keep.map(m => m.userId).sort((a, b) => a - b).join(',')}`);
    expect(aborted).toBeGreaterThanOrEqual(0);
    expect(groupChange).toBeGreaterThan(aborted); // the OS group changes only after the run stopped

    await finishGatesUntil(B, 'DEVELOP');
    const t2 = w.calls.filter(c => c.wt === `${B}-T-02` && c.role === 'developer');
    expect(t2.map(c => [c.userId, c.outcome])).toEqual([[id('dev2'), 'aborted'], [id('dev1'), 'ok']]);
    expect(w.repo.getRunner(rid(B), 'DEV')).toBe(id('dev1'));
    expect((await approve(E.rev, B)).statusCode).toBe(302);
    await finishGatesUntil(B, 'DONE');
    expect((await approve(E.pm, B)).statusCode).toBe(302);
    expect(status(B).status).toBe('done');
  }, T);

  it('every Claude call ran on the right seat inside a worktree of the project', () => {
    const wtDir = join(projectPath, '.devflow', 'worktrees');
    const seatsOf: Record<string, number[]> = {
      explorer: [id('se')], architect: [id('se')], reviewer: [id('rev')], tester: [id('tester')],
      analyst: [id('ba1'), id('ba2')], 'analyst-breakdown': [id('ba1'), id('ba2')], planner: [id('dev1'), id('tester')], developer: [id('dev1'), id('dev2')],
    };
    expect(w.calls.length).toBeGreaterThan(30);
    for (const c of w.calls) {
      expect(dirname(c.cwd), `${c.role} ${c.wt}`).toBe(wtDir);
      expect(c.wt.startsWith(A) || c.wt.startsWith(B), c.wt).toBe(true);
      expect(seatsOf[c.role], c.role).toContain(c.userId);
    }
    expect(w.calls.filter(c => c.wt.startsWith(A) && ['analyst', 'analyst-breakdown'].includes(c.role)).every(c => c.userId === id('ba1'))).toBe(true);
    // Every run is followed by the root-side sweep before DevFlow touches the worktree.
    expect(w.timeline.some(t => t.startsWith('sweep:'))).toBe(true);
  });

  it('oversight: CTO sees progress, blockers and files; secrets are hidden and views are audited; other department gets 404', async () => {
    const pj = `/oversight/projects/${projectId}`;
    const page = await w.get(E.cto, pj);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(A);
    expect(page.body).toContain(B);
    expect((await w.get(E.cto, '/oversight/blockers')).statusCode).toBe(200);
    expect((await w.get(E.cto, '/oversight/users')).statusCode).toBe(200);
    expect((await w.get(E.head, pj)).statusCode).toBe(200);
    expect((await w.get('root@corp.com' in {} ? E.cto : E.cto, pj)).statusCode).toBe(200);
    expect((await w.get(E.sghead, pj)).statusCode).toBe(404);
    expect((await w.get(E.sghead, `${pj}/files?path=README.md`)).statusCode).toBe(404);
    for (const e of [E.pm, E.dev1, E.outsider]) expect((await w.get(e, pj)).statusCode, e).toBe(403);

    // Content: README readable; planted .env hidden everywhere; deliverables readable.
    const readme = await w.get(E.cto, `${pj}/files?ref=main&path=README.md`);
    expect(readme.statusCode).toBe(200);
    expect(readme.body).toContain('# app');
    const root = await w.get(E.cto, `${pj}/files?ref=main`);
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('README.md');
    expect(root.body).not.toContain('.env');
    const env = await w.get(E.cto, `${pj}/files?ref=main&path=.env`);
    expect(env.statusCode).toBe(404);
    expect(env.body).not.toContain('hunter2');
    expect((await w.get(E.cto, `${pj}/files?ref=main&path=../../etc/passwd`)).statusCode).toBeGreaterThanOrEqual(400);
    const deliv = await w.get(E.cto, `${pj}/files?ref=devflow/${A}&path=docs/devflow/${A}/deliverables`);
    expect(deliv.statusCode).toBe(200);
    expect((await w.get(E.cto, `${pj}/docs`)).statusCode).toBe(200);
    expect((await w.get(E.cto, `${pj}/logs`)).statusCode).toBe(200);

    // Every content view is in the audit log under the CTO.
    const audit = w.repo.web.listAudit({ projectId }).filter(a => a.action.startsWith('oversight.'));
    expect(audit.some(a => a.userId === id('cto') && a.action === 'oversight.content' && String(a.detail).includes('README.md'))).toBe(true);
    expect(audit.some(a => a.action === 'oversight.content.denied' && String(a.detail).includes('.env'))).toBe(true);

    // Read-only: no write verb is reachable.
    for (const m of ['POST', 'PUT', 'DELETE'] as const) {
      const r = await w.app.inject({ method: m, url: pj, headers: { origin: BASE, host: HOST, cookie: w.cookieOf(E.cto) } });
      expect(r.statusCode, m).toBe(404);
    }
  }, T);
});
