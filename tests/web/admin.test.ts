import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { templatePath } from '../../src/office/templates.js';
import { decrypt, encrypt, hashPassword, verifyPassword } from '../../src/security/crypto.js';
import { getSecretKey } from '../../src/security/secret.js';
import { effectiveConfig, gitlabFor } from '../../src/settings.js';
import { signSession } from '../../src/web/auth.js';
import { buildServer } from '../../src/web/server.js';
import { mkReq, setup } from '../engine/helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

async function boot(serverMode = false) {
  const s = setup(serverMode ? { mode: 'server', secretKey: 'test-secret', host: '0.0.0.0' } : {});
  const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
  apps.push(app);
  return { ...s, app };
}

const origin = { origin: 'http://localhost:3000', host: 'localhost:3000' };
const form = { 'content-type': 'application/x-www-form-urlencoded', ...origin };
const enc = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

function upload(filename: string, content: Buffer) {
  const bd = '----adm';
  const head = Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  return { payload: Buffer.concat([head, content, Buffer.from(`\r\n--${bd}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${bd}`, ...origin } };
}
async function zipWith(path: string): Promise<Buffer> {
  const z = new JSZip();
  z.file(path, '<x/>');
  return z.generateAsync({ type: 'nodebuffer' });
}

describe('templates', () => {
  it('upload template replaces path', async () => {
    const { app, cfg, repo } = await boot();
    const def = templatePath(cfg, 'tkct');
    expect(def).not.toContain(cfg.dataDir);
    const res = await app.inject({ method: 'POST', url: '/templates/tkct', ...upload('mau.docx', await zipWith('word/document.xml')) });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('ok=');
    const p = templatePath(cfg, 'tkct');
    expect(p).toBe(join(cfg.dataDir, 'templates', 'tkct.docx'));
    expect(existsSync(p)).toBe(true);
    expect(repo.web.getTemplate('tkct')).toBe(p);
    const xl = await app.inject({ method: 'POST', url: '/templates/ulnl', ...upload('u.xlsx', await zipWith('xl/workbook.xml')) });
    expect(xl.statusCode).toBe(302);
    expect(existsSync(templatePath(cfg, 'ulnl'))).toBe(true);
    const page = await app.inject({ method: 'GET', url: '/templates' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Mẫu tài liệu');
    const dl = await app.inject({ method: 'GET', url: '/templates/tkct/download' });
    expect(dl.statusCode).toBe(200);
    // reset restores default
    const rs = await app.inject({ method: 'POST', url: '/templates/tkct/reset', headers: form });
    expect(rs.statusCode).toBe(302);
    expect(templatePath(cfg, 'tkct')).toBe(def);
    expect(repo.web.getTemplate('tkct')).toBeUndefined();
  });

  it('rejects non-office upload', async () => {
    const { app, cfg } = await boot();
    const bad = async (kind: string, name: string, buf: Buffer) => {
      const res = await app.inject({ method: 'POST', url: `/templates/${kind}`, ...upload(name, buf) });
      expect(res.statusCode).toBe(302);
      expect(decodeURIComponent(String(res.headers.location))).toContain('err=');
    };
    await bad('tkct', 'x.docx', Buffer.from('not a zip'));
    await bad('tkct', 'x.txt', await zipWith('word/document.xml'));
    await bad('tkct', 'x.docx', await zipWith('xl/workbook.xml')); // wrong marker
    await bad('testcase', 'x.docx', await zipWith('word/document.xml')); // wrong extension for kind
    expect(existsSync(join(cfg.dataDir, 'templates', 'tkct.docx'))).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/templates/bogus', ...upload('a.docx', await zipWith('word/document.xml')) })).statusCode).toBe(404);
  });

  it('member can view but not upload templates (server mode)', async () => {
    const { app, repo, cfg } = await boot(true);
    const m = repo.web.createUser({ username: 'm', passwordHash: hashPassword('password1'), role: 'member' });
    const cookie = `devflow_sid=${signSession(cfg.secretKey, m.id)}`;
    expect((await app.inject({ method: 'GET', url: '/templates', headers: { cookie } })).statusCode).toBe(200);
    const up = upload('a.docx', await zipWith('word/document.xml'));
    expect((await app.inject({ method: 'POST', url: '/templates/tkct', payload: up.payload, headers: { ...up.headers, cookie } })).statusCode).toBe(403);
  });
});

describe('settings', () => {
  it('settings saved encrypted', async () => {
    const { app, repo, cfg } = await boot();
    const res = await app.inject({
      method: 'POST', url: '/settings', headers: form,
      payload: enc({ gitlab_url: 'https://gl.example.com', gitlab_token: 'glpat-SECRET123', gitlab_default_group: 'team', max_concurrent_jobs: '3', claude_bin: 'claude2' }),
    });
    expect(res.statusCode).toBe(302);
    const stored = repo.web.getSetting('gitlab.token')!;
    expect(stored).not.toContain('SECRET123');
    expect(decrypt(stored, getSecretKey(cfg))).toBe('glpat-SECRET123');
    expect(repo.web.getSetting('gitlab.url')).toBe('https://gl.example.com');
    expect(existsSync(join(cfg.dataDir, 'secret.key'))).toBe(true);
    const page = await app.inject({ method: 'GET', url: '/settings' });
    expect(page.body).not.toContain('SECRET123');
    expect(page.body).not.toContain(stored);
    expect(page.body).toContain('đã lưu ••••');
    expect(page.body).toContain('https://gl.example.com');
    // live cfg updated for new jobs
    expect(cfg.maxConcurrentJobs).toBe(3);
    expect(cfg.claudeBin).toBe('claude'); // CLAUDE_BIN is env-only: a posted claude_bin is ignored
    expect(repo.web.getSetting('claudeBin')).toBeUndefined();
    expect(page.body).not.toContain('name="claude_bin"');
    expect(cfg.gitlab.token).toBe('glpat-SECRET123');
    // blank token keeps the stored one
    await app.inject({ method: 'POST', url: '/settings', headers: form, payload: enc({ gitlab_url: 'https://gl2.example.com', gitlab_token: '', max_concurrent_jobs: '2' }) });
    expect(decrypt(repo.web.getSetting('gitlab.token')!, getSecretKey(cfg))).toBe('glpat-SECRET123');
    expect(cfg.gitlab.url).toBe('https://gl2.example.com');
    // invalid concurrency rejected
    const bad = await app.inject({ method: 'POST', url: '/settings', headers: form, payload: enc({ max_concurrent_jobs: '0' }) });
    expect(decodeURIComponent(String(bad.headers.location))).toContain('err=');
  });

  it('admin only in server mode', async () => {
    const { app, repo, cfg } = await boot(true);
    const m = repo.web.createUser({ username: 'm', passwordHash: hashPassword('password1'), role: 'member' });
    const cookie = `devflow_sid=${signSession(cfg.secretKey, m.id)}`;
    expect((await app.inject({ method: 'GET', url: '/settings', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/settings', headers: { ...form, cookie }, payload: enc({ gitlab_url: 'x' }) })).statusCode).toBe(403);
    expect(repo.web.getSetting('gitlab.url')).toBeUndefined();
  });

  it('effectiveConfig: DB overrides env; getSecretKey prefers SECRET_KEY, else key file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-set-'));
    const cfg = { ...loadConfig({ DEVFLOW_MODE: 'local', GITLAB_URL: 'https://env', GITLAB_TOKEN: 'envtok', MAX_CONCURRENT_JOBS: '1' }), dataDir: dir };
    const repo = new Repo(openDb(':memory:'));
    expect(effectiveConfig(cfg, repo).gitlab).toEqual({ url: 'https://env', token: 'envtok', defaultGroup: '' });
    const key = getSecretKey(cfg);
    expect(key).toHaveLength(64);
    expect(getSecretKey(cfg)).toBe(key);
    expect(readFileSync(join(dir, 'secret.key'), 'utf8').trim()).toBe(key);
    expect(getSecretKey({ ...cfg, secretKey: 'abc' })).toBe('abc');
    repo.web.setSetting('gitlab.url', 'https://db');
    repo.web.setSetting('gitlab.token', encrypt('dbtok', key));
    repo.web.setSetting('gitlab.defaultGroup', 'g');
    repo.web.setSetting('maxConcurrentJobs', '4');
    repo.web.setSetting('claudeBin', 'cl');
    const e = effectiveConfig(cfg, repo);
    expect(e.gitlab).toEqual({ url: 'https://db', token: 'dbtok', defaultGroup: 'g' });
    expect(e.maxConcurrentJobs).toBe(4);
    expect(e.claudeBin).toBe('claude'); // a legacy DB value never overrides CLAUDE_BIN
    expect(cfg.gitlab.url).toBe('https://env'); // input untouched
    // per-user token takes precedence for the request creator
    const u = repo.web.createUser({ username: 'u', passwordHash: 'x', role: 'member' });
    repo.web.setUserGitlabToken(u.id, encrypt('usertok', key));
    const r = repo.createRequest({ title: 't', description: 'd', perfReq: '', nonfuncReq: '', projectKind: 'new', gitlabProject: null, softwareTypes: [], runMode: 'auto', createdBy: u.id });
    const own = gitlabFor(cfg, repo, r) as unknown as { token: string; baseUrl: string };
    expect(JSON.stringify(own)).toContain('usertok');
    const other = gitlabFor(cfg, repo, { ...r, createdBy: null }) as unknown as object;
    expect(JSON.stringify(other)).toContain('dbtok');
  });
});

describe('secret key file', () => {
  it('refuses to regenerate an empty or invalid key file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devflow-key-'));
    const cfg = { secretKey: '', dataDir: dir };
    writeFileSync(join(dir, 'secret.key'), '');
    expect(() => getSecretKey(cfg)).toThrow(/rỗng hoặc không hợp lệ/);
    expect(readFileSync(join(dir, 'secret.key'), 'utf8')).toBe('');
    writeFileSync(join(dir, 'secret.key'), 'garbage');
    expect(() => getSecretKey(cfg)).toThrow();
  });
});

describe('users', () => {
  async function adminSetup() {
    const b = await boot(true);
    const admin = b.repo.web.createUser({ username: 'admin', passwordHash: hashPassword('password1'), role: 'admin' });
    const member = b.repo.web.createUser({ username: 'mem', passwordHash: hashPassword('password1'), role: 'member' });
    const ck = (id: number) => `devflow_sid=${signSession(b.cfg.secretKey, id)}`;
    return { ...b, admin, member, adminCookie: ck(admin.id), memberCookie: ck(member.id) };
  }

  it('member cannot access users page (403)', async () => {
    const { app, memberCookie, repo } = await adminSetup();
    expect((await app.inject({ method: 'GET', url: '/users', headers: { cookie: memberCookie } })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/users', headers: { ...form, cookie: memberCookie }, payload: enc({ username: 'evil', password: 'password12', role: 'admin' }) });
    expect(res.statusCode).toBe(403);
    expect(repo.web.getUserByUsername('evil')).toBeUndefined();
  });

  it('admin lists, creates, resets password, deletes', async () => {
    const { app, adminCookie, repo, admin, member } = await adminSetup();
    const h = { ...form, cookie: adminCookie };
    const page = await app.inject({ method: 'GET', url: '/users', headers: { cookie: adminCookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('mem');
    expect(page.body).not.toContain(admin.passwordHash);
    await app.inject({ method: 'POST', url: '/users', headers: h, payload: enc({ username: 'new.user', password: 'password12', role: 'member' }) });
    const nu = repo.web.getUserByUsername('new.user')!;
    expect(nu.role).toBe('member');
    expect(verifyPassword('password12', nu.passwordHash)).toBe(true);
    // validation + duplicates
    for (const p of [{ username: 'a', password: 'password12', role: 'member' }, { username: 'ok1', password: 'short', role: 'member' }, { username: 'mem', password: 'password12', role: 'member' }]) {
      const r = await app.inject({ method: 'POST', url: '/users', headers: h, payload: enc(p) });
      expect(decodeURIComponent(String(r.headers.location))).toContain('err=');
    }
    expect(repo.web.listUsers()).toHaveLength(3);
    await app.inject({ method: 'POST', url: `/users/${member.id}/password`, headers: h, payload: enc({ password: 'newpassword1' }) });
    expect(verifyPassword('newpassword1', repo.web.getUser(member.id)!.passwordHash)).toBe(true);
    await app.inject({ method: 'POST', url: `/users/${nu.id}/delete`, headers: h });
    expect(repo.web.getUser(nu.id)).toBeUndefined();
    // cannot delete self
    const self = await app.inject({ method: 'POST', url: `/users/${admin.id}/delete`, headers: h });
    expect(decodeURIComponent(String(self.headers.location))).toContain('err=');
    expect(repo.web.getUser(admin.id)).toBeDefined();
  });

  it('deleted user session is rejected; their requests are kept and shown as -', async () => {
    const { app, repo, admin, member, adminCookie, memberCookie } = await adminSetup();
    const r = mkReq(repo, { createdBy: member.id });
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie: memberCookie } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/users/${member.id}/delete`, headers: { ...form, cookie: adminCookie } });
    const after = await app.inject({ method: 'GET', url: '/', headers: { cookie: memberCookie } });
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toBe('/login');
    expect(repo.getRequest(r.id)).toBeDefined();
    const dash = await app.inject({ method: 'GET', url: '/', headers: { cookie: adminCookie } });
    expect(dash.body).toContain(r.id);
    void admin;
  });

  it('/me stores own gitlab token encrypted and never echoes it', async () => {
    const { app, memberCookie, repo, member, cfg } = await adminSetup();
    const res = await app.inject({ method: 'POST', url: '/me', headers: { ...form, cookie: memberCookie }, payload: enc({ gitlab_token: 'glpat-MINE999' }) });
    expect(res.statusCode).toBe(302);
    const enc1 = repo.web.getUser(member.id)!.gitlabTokenEnc!;
    expect(enc1).not.toContain('MINE999');
    expect(decrypt(enc1, getSecretKey(cfg))).toBe('glpat-MINE999');
    const page = await app.inject({ method: 'GET', url: '/me', headers: { cookie: memberCookie } });
    expect(page.body).not.toContain('MINE999');
    expect(page.body).toContain('đã lưu ••••');
    await app.inject({ method: 'POST', url: '/me', headers: { ...form, cookie: memberCookie }, payload: enc({ clear_token: '1' }) });
    expect(repo.web.getUser(member.id)!.gitlabTokenEnc).toBeNull();
  });

  it('local mode allows everything', async () => {
    const { app } = await boot();
    for (const u of ['/settings', '/templates', '/me']) expect((await app.inject({ method: 'GET', url: u })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/users' })).statusCode).toBe(404);
    void mkReq;
  });
});
