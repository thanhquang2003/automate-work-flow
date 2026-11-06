import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
      // A parked job (awaiting seat) only moves on an explicit wake-up: nothing to wait for here.
      if (!repo.listRequests().some(r => r.status === 'running')) return;
    }
    throw new Error(`timed out: ${what}`);
  };
  const hold = (match: Hold['match']): Hold => { const h: Hold = { match, started: deferred(), release: deferred(), used: false }; holds.push(h); return h; };
  const gate = (id: string): string => pipeline.gateToken(repo.getRequest(id)!);

  return { cfg, repo, app, bare, gl, mock, calls, seatState, logins, timeline, systemOps, worker, pipeline, login, uid, get, post, settle, hold, gate, maxInFlight: () => maxInFlight, base, root };
}

/**
 * The fixture mock writes to <cwd>/docs/devflow; v3 keeps a request's docs in <worktree>/docs/devflow/<code>.
 * Run it in a scratch folder and copy its docs over; developer/reviewer write src files and absolute outputs.
 * The planner gets two independent tasks so both Devs can work at the same time.
 */
function v3Output(handler: (o: RunOpts) => RunResult, opts: RunOpts): RunResult {
  const role = roleOf(opts.prompt);
  if (role === 'developer' || role === 'reviewer') return handler(opts);
  const scratch = tmp('devflow-v3e2e-scratch-');
  const r = handler({ ...opts, cwd: scratch });
  const src = join(scratch, 'docs', 'devflow');
  const dst = join(opts.cwd, 'docs', 'devflow', basename(opts.cwd));
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
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

  it('boots and lets the seeded head log in through Google', async () => {
    await w.login('head@corp.com');
    const head = w.repo.web.getUserByEmail('head@corp.com')!;
    expect(head.sysRole).toBe('head');
    expect(head.departmentId).toBe(w.repo.web.getDepartmentByCode('DEV')!.id);
    void multipart; void E2E_TASKS; void outputPaths; void dirname;
  }, T);
});
