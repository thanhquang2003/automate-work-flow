import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { Pipeline } from '../../src/engine/pipeline.js';
import { Git } from '../../src/gitlab/git.js';
import { COOKIE, verifySession } from '../../src/web/auth.js';
import type { OidcClaims, OidcClient } from '../../src/web/oidc.js';
import { buildServer } from '../../src/web/server.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const ENV = {
  DEVFLOW_MODE: 'server', CLAUDE_MOCK: '1', SECRET_KEY: 'sso-secret', PUBLIC_BASE_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', ALLOWED_EMAIL_DOMAINS: 'corp.com',
  ADMIN_EMAILS: 'root@corp.com', CTO_EMAILS: 'cto@corp.com', HEAD_EMAILS: 'DEV:head@corp.com', DEPUTY_EMAILS: 'SGLOBAL:dep@corp.com',
};

async function boot(env: Record<string, string> = {}, claims: Partial<OidcClaims> = {}) {
  const cfg = loadConfig({ ...ENV, ...env });
  const repo = new Repo(openDb(':memory:'));
  const pipeline = new Pipeline(cfg, repo, { makeGit: (_r, ws) => new Git(ws.repoDir), allowLocalSeatsInServerMode: true });
  const current: { claims: OidcClaims } = { claims: { sub: 's1', email: 'u@corp.com', emailVerified: true, name: 'U', ...claims } };
  const seen: { state?: string; nonce?: string } = {};
  const oidc: OidcClient = {
    async authUrl(p) { seen.state = p.state; seen.nonce = p.nonce; return `https://accounts.example/auth?state=${p.state}&cc=${p.codeChallenge}`; },
    async exchange(p) { if (p.nonce !== seen.nonce) throw new Error('nonce'); return current.claims; },
  };
  const provisioned: number[] = [];
  const app = await buildServer(cfg, { repo, pipeline, oidc, systemOps: { provisionUser: id => { provisioned.push(id); } } });
  apps.push(app);
  const hdr = { host: 'localhost:3000' };
  async function login(c?: Partial<OidcClaims>, over: { state?: string } = {}) {
    if (c) current.claims = { ...current.claims, ...c };
    const start = await app.inject({ method: 'GET', url: '/auth/google', headers: hdr });
    const ck = String(start.headers['set-cookie']).split(';')[0]!;
    return app.inject({ method: 'GET', url: `/auth/google/callback?code=abc&state=${over.state ?? seen.state}`, headers: { ...hdr, cookie: ck } });
  }
  return { app, repo, cfg, login, provisioned, start: () => app.inject({ method: 'GET', url: '/auth/google', headers: hdr }) };
}

const sessionOf = (res: { headers: Record<string, unknown> }, secret = 'sso-secret') => {
  const sc = ([] as string[]).concat(res.headers['set-cookie'] as string[] | string ?? []);
  const c = sc.find(x => x.startsWith(`${COOKIE}=`));
  return c ? verifySession(secret, decodeURIComponent(c.split(';')[0]!.slice(COOKIE.length + 1))) : undefined;
};

describe('google sso', () => {
  it('starts with PKCE, state and nonce in a signed short-lived cookie', async () => {
    const { start } = await boot();
    const res = await start();
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('cc=');
    const ck = String(res.headers['set-cookie']);
    expect(ck).toContain('devflow_oidc=');
    expect(ck).toContain('HttpOnly');
    expect(ck).toContain('Max-Age=600');
  });
  it('rejects other domain', async () => {
    const { login, repo } = await boot();
    const res = await login({ email: 'x@evil.com', sub: 'x1' });
    expect(res.statusCode).toBe(403);
    expect(sessionOf(res)).toBeUndefined();
    expect(repo.web.getUserByEmail('x@evil.com')).toBeUndefined();
  });
  it('rejects every login when ALLOWED_EMAIL_DOMAINS is empty', async () => {
    const { login } = await boot({ ALLOWED_EMAIL_DOMAINS: '' });
    const res = await login();
    expect(res.statusCode).toBe(403);
    expect(sessionOf(res)).toBeUndefined();
  });
  it('rejects unverified email', async () => {
    const { login } = await boot();
    const res = await login({ emailVerified: false });
    expect(res.statusCode).toBe(403);
    expect(sessionOf(res)).toBeUndefined();
  });
  it('state mismatch rejected', async () => {
    const { login } = await boot();
    const res = await login(undefined, { state: 'forged' });
    expect(res.statusCode).toBe(400);
    expect(sessionOf(res)).toBeUndefined();
  });
  it('callback without the state cookie is rejected', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/auth/google/callback?code=a&state=b', headers: { host: 'localhost:3000' } });
    expect(res.statusCode).toBe(400);
  });
  it('seeds admin cto head deputy with department at first login', async () => {
    const { login, repo, provisioned } = await boot();
    const dev = repo.web.getDepartmentByCode('DEV')!;
    const sg = repo.web.getDepartmentByCode('SGLOBAL')!;
    const cases: [string, string, string, number | null][] = [
      ['root@corp.com', 'a1', 'admin', null], ['cto@corp.com', 'a2', 'cto', null],
      ['head@corp.com', 'a3', 'head', dev.id], ['dep@corp.com', 'a4', 'deputy', sg.id],
    ];
    for (const [email, sub, role, dept] of cases) {
      const res = await login({ email, sub });
      expect(res.statusCode).toBe(302);
      const uid = sessionOf(res)!;
      const u = repo.web.getUser(uid)!;
      expect(u.email).toBe(email);
      expect(u.sysRole).toBe(role);
      expect(u.departmentId).toBe(dept);
      expect(provisioned).toContain(uid);
    }
  });
  it('existing user keeps stored role and department (seeding is first login only)', async () => {
    const { login, repo } = await boot();
    await login({ email: 'head@corp.com', sub: 'h1' });
    const u = repo.web.getUserByEmail('head@corp.com')!;
    repo.web.setUserSysRole(u.id, 'member');
    repo.web.setUserDepartment(u.id, null);
    await login({ email: 'head@corp.com', sub: 'h1' });
    const after = repo.web.getUser(u.id)!;
    expect(after.sysRole).toBe('member');
    expect(after.departmentId).toBeNull();
  });
  it('unknown email becomes member without department', async () => {
    const { login, repo } = await boot();
    const res = await login({ email: 'new@corp.com', sub: 'n1', name: 'New' });
    const u = repo.web.getUser(sessionOf(res)!)!;
    expect(u.sysRole).toBe('member');
    expect(u.departmentId).toBeNull();
    expect(u.canBePm).toBe(false);
    expect(u.displayName).toBe('New');
  });
  it('disabled user is rejected', async () => {
    const { login, repo } = await boot();
    const first = await login({ email: 'd@corp.com', sub: 'd1' });
    repo.web.setUserDisabled(sessionOf(first)!, true);
    const res = await login({ email: 'd@corp.com', sub: 'd1' });
    expect(res.statusCode).toBe(403);
    expect(sessionOf(res)).toBeUndefined();
  });
  it('known email with a different google_sub is rejected, not overwritten', async () => {
    const { login, repo } = await boot();
    const first = await login({ email: 'k@corp.com', sub: 'real' });
    const id = sessionOf(first)!;
    const res = await login({ email: 'k@corp.com', sub: 'attacker' });
    expect(res.statusCode).toBe(403);
    expect(sessionOf(res)).toBeUndefined();
    expect(repo.web.getUser(id)!.googleSub).toBe('real');
  });
  it('a known sub switching to an email owned by another user is rejected', async () => {
    const { login } = await boot();
    await login({ email: 'one@corp.com', sub: 'o1' });
    await login({ email: 'two@corp.com', sub: 't1' });
    const res = await login({ email: 'two@corp.com', sub: 'o1' });
    expect(res.statusCode).toBe(403);
  });
  it('breakglass hidden unless configured', async () => {
    const off = await boot();
    expect((await off.app.inject({ method: 'GET', url: '/login/local', headers: { host: 'localhost:3000' } })).statusCode).toBe(404);
    const page = await off.app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost:3000' } });
    expect(page.body).toContain('/auth/google');
    expect(page.body).not.toContain('/login/local');
    const on = await boot({ BREAKGLASS_ADMIN: 'rescue' });
    const page2 = await on.app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost:3000' } });
    expect(page2.body).toContain('/login/local');
    expect((await on.app.inject({ method: 'GET', url: '/login/local', headers: { host: 'localhost:3000' } })).statusCode).toBe(200);
  });
  it('breakglass password login works only for the configured admin', async () => {
    const { app, repo } = await boot({ BREAKGLASS_ADMIN: 'rescue' });
    const { hashPassword } = await import('../../src/security/crypto.js');
    repo.web.createUser({ username: 'rescue', passwordHash: hashPassword('correct-horse-1'), role: 'admin' });
    repo.web.createUser({ username: 'other', passwordHash: hashPassword('correct-horse-1'), role: 'admin' });
    const h = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3000', host: 'localhost:3000' };
    const ok = await app.inject({ method: 'POST', url: '/login/local', payload: 'username=rescue&password=correct-horse-1', headers: h });
    expect(ok.statusCode).toBe(302);
    expect(sessionOf(ok)).toBeDefined();
    const bad = await app.inject({ method: 'POST', url: '/login/local', payload: 'username=other&password=correct-horse-1', headers: h });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/login', payload: 'username=rescue&password=correct-horse-1', headers: h })).statusCode).toBe(404);
  });
  it('/login/local is 404 without breakglass even for POST', async () => {
    const { app } = await boot();
    const h = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3000', host: 'localhost:3000' };
    expect((await app.inject({ method: 'POST', url: '/login/local', payload: 'username=a&password=b', headers: h })).statusCode).toBe(404);
  });
  it('rejects suffix-spoofed and malformed email domains', async () => {
    const { login, repo } = await boot();
    for (const [i, email] of ['x@evil-corp.com', 'x@corp.com.evil.com', 'a@corp.com@evil.com', 'nocorp.com', '@corp.com'].entries()) {
      const res = await login({ email, sub: `sp${i}` });
      expect(res.statusCode).toBe(403);
      expect(sessionOf(res)).toBeUndefined();
    }
    expect(repo.web.listUsers()).toHaveLength(0);
  });
  it('/setup is 404 in server mode with SSO and creates no user', async () => {
    const { app, repo } = await boot();
    const h = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3000', host: 'localhost:3000' };
    expect((await app.inject({ method: 'GET', url: '/setup', headers: { host: 'localhost:3000' } })).statusCode).toBe(404);
    const post = await app.inject({ method: 'POST', url: '/setup', payload: 'username=evil&password=password123', headers: h });
    expect(post.statusCode).toBe(404);
    expect(sessionOf(post)).toBeUndefined();
    expect(repo.web.listUsers()).toHaveLength(0);
    const root = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost:3000' } });
    expect(root.headers.location).toBe('/login');
  });
});
