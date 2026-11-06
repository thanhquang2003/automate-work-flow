import { describe, expect, it, vi } from 'vitest';
import { setup } from '../engine/helpers.js';
import { buildServer } from '../../src/web/server.js';
import { webEnv } from './v3-helpers.js';

describe('v3 seat page', () => {
  it('seat login flow posts code to session and never echoes it', async () => {
    const w = await webEnv();
    const log = vi.spyOn(console, 'log'); const err = vi.spyOn(console, 'error'); const warn = vi.spyOn(console, 'warn');
    const wake = vi.spyOn(w.pipeline, 'seatReconnected');
    expect((await w.get(w.dev.id, '/seat')).body).toContain('Claude của tôi');
    expect((await w.post(w.dev.id, '/seat/connect')).statusCode).toBe(302);
    const page = (await w.get(w.dev.id, '/seat')).body;
    expect(page).toContain('https://claude.ai/login?x=1');
    const SECRET = 'SECRET-CODE-123';
    const res = await w.post(w.dev.id, '/seat/code', { code: SECRET });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).not.toContain(SECRET);
    expect(res.body).not.toContain(SECRET);
    expect(w.logins[0]!.codes).toEqual([SECRET]);
    w.logins[0]!.finish({ success: true });
    await new Promise(r => setTimeout(r, 20));
    const after = (await w.get(w.dev.id, '/seat')).body;
    expect(after).toContain('Đăng nhập thành công');
    expect(after).not.toContain(SECRET);
    expect(wake).toHaveBeenCalledWith(w.dev.id);
    expect(JSON.stringify(w.repo.web.listAudit({ limit: 500 }))).not.toContain(SECRET);
    for (const s of [log, err, warn]) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
    vi.restoreAllMocks();
  });

  it('seat actions are per user and need the origin check', async () => {
    const w = await webEnv();
    await w.post(w.dev.id, '/seat/connect');
    // another user has no attempt waiting for a code
    expect(String((await w.post(w.ba.id, '/seat/code', { code: 'x' })).headers.location)).toContain('err=');
    expect(w.logins[0]!.codes).toEqual([]);
    const evil = await w.app.inject({ method: 'POST', url: '/seat/code', payload: 'code=x', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example', host: 'localhost:3000', cookie: w.cookie(w.dev.id) } });
    expect(evil.statusCode).toBe(403);
  });
});

describe('v3 local mode', () => {
  it('local mode works without login', async () => {
    const s = setup();
    const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
    try {
      expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/requests' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/settings' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/requests/new' })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
