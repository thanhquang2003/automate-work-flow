import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../src/engine/bus.js';
import { Workspace } from '../../src/engine/workspace.js';
import { hashPassword } from '../../src/security/crypto.js';
import { signSession } from '../../src/web/auth.js';
import { markdownToHtml } from '../../src/web/markdown-html.js';
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

function multipart(fields: [string, string][], files: { name: string; filename: string; content: string }[] = []) {
  const b = '----devflowtest';
  let body = '';
  for (const [k, v] of fields) body += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  for (const f of files) body += `--${b}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: text/plain\r\n\r\n${f.content}\r\n`;
  body += `--${b}--\r\n`;
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${b}`, origin: 'http://localhost:3000', host: 'localhost:3000' } };
}

describe('web: local mode', () => {
  it('local mode dashboard 200 without login', async () => {
    const { app, repo } = await boot();
    mkReq(repo, { title: 'Hệ thống bán hàng' });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Yêu cầu');
    expect(res.body).toContain('Hệ thống bán hàng');
    expect((await app.inject({ method: 'GET', url: '/static/app.css' })).statusCode).toBe(200);
  });

  it('create request with attachment starts pipeline', async () => {
    const { app, repo, pipeline, cfg } = await boot();
    const start = vi.spyOn(pipeline, 'start');
    const m = multipart(
      [['title', 'Quản lý kho'], ['description', 'Mô tả chi tiết'], ['project_kind', 'new'], ['run_mode', 'auto'], ['software_types', 'web'], ['software_types', 'api'], ['software_types', 'bogus']],
      [{ name: 'files', filename: '../../evil name.txt', content: 'hello' }],
    );
    const res = await app.inject({ method: 'POST', url: '/requests', ...m });
    expect(res.statusCode).toBe(302);
    const r = repo.listRequests()[0]!;
    expect(res.headers.location).toBe(`/requests/${r.id}`);
    expect(r.softwareTypes).toEqual(['web', 'api']);
    expect(r.runMode).toBe('auto');
    expect(start).toHaveBeenCalledWith(r.id);
    const att = repo.listAttachments(r.id);
    expect(att).toHaveLength(1);
    expect(att[0]!.filename).toBe('evil name.txt');
    expect(att[0]!.path.startsWith(Workspace.for(cfg, r.id).inputsDir)).toBe(true);
    expect(att[0]!.size).toBe(5);
  });

  it('create request validates required fields', async () => {
    const { app, repo } = await boot();
    const res = await app.inject({ method: 'POST', url: '/requests', ...multipart([['title', ''], ['description', 'x']]) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Vui lòng nhập tiêu đề');
    expect(repo.listRequests()).toHaveLength(0);
  });

  it('approve endpoint calls pipeline.approve; reject needs feedback', async () => {
    const { app, repo, pipeline } = await boot();
    const r = mkReq(repo);
    repo.updateRequest(r.id, { status: 'awaiting_approval', stage: 'ANALYSIS' });
    const approve = vi.spyOn(pipeline, 'approve').mockImplementation(() => undefined);
    const reject = vi.spyOn(pipeline, 'reject').mockImplementation(() => undefined);
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/approve` });
    expect(res.statusCode).toBe(302);
    expect(approve).toHaveBeenCalledWith(r.id);
    const bad = await app.inject({ method: 'POST', url: `/requests/${r.id}/reject`, payload: 'feedback=+', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(bad.headers.location).toContain('err=');
    expect(reject).not.toHaveBeenCalled();
    await app.inject({ method: 'POST', url: `/requests/${r.id}/reject`, payload: 'feedback=l%C3%A0m+l%E1%BA%A1i', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(reject).toHaveBeenCalledWith(r.id, 'làm lại');
  });

  it('busy pipeline shows a flash error instead of 500', async () => {
    const { app, repo, pipeline } = await boot();
    const r = mkReq(repo);
    const { PipelineBusyError } = await import('../../src/engine/pipeline.js');
    vi.spyOn(pipeline, 'rerunStage').mockImplementation(() => { throw new PipelineBusyError(r.id); });
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/rerun` });
    expect(res.statusCode).toBe(302);
    const page = await app.inject({ method: 'GET', url: res.headers.location as string });
    expect(page.body).toContain('đang chạy');
  });

  it('detail page renders tabs, actions per status and Vietnamese stage labels', async () => {
    const { app, repo } = await boot();
    const r = mkReq(repo);
    repo.updateRequest(r.id, { status: 'awaiting_approval', stage: 'ANALYSIS' });
    const page = await app.inject({ method: 'GET', url: `/requests/${r.id}` });
    expect(page.statusCode).toBe(200);
    for (const s of ['Tiếp nhận', 'Đọc hiểu dự án', 'Làm rõ yêu cầu', 'Lập kế hoạch & Test case'.replace('&', '&amp;'), 'Duyệt (Approve)', 'Từ chối (Reject)']) expect(page.body).toContain(s);
    for (const tab of ['analysis', 'questions', 'docs', 'tasks', 'tests', 'bugs']) {
      expect((await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=${tab}` })).statusCode).toBe(200);
    }
    repo.updateRequest(r.id, { status: 'failed' });
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}` })).body).toContain('Chạy lại bước');
    expect((await app.inject({ method: 'GET', url: '/requests/REQ-999' })).statusCode).toBe(404);
  });

  it('analysis tab escapes raw HTML', async () => {
    const { app, repo, cfg } = await boot();
    const r = mkReq(repo);
    const ws = Workspace.for(cfg, r.id).ensure();
    mkdirSync(ws.devflowDir, { recursive: true });
    writeFileSync(join(ws.devflowDir, 'analysis.md'), '# Tiêu đề\n\n<script>alert(1)</script> **đậm**\n\n- a\n- b\n');
    const res = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=analysis` });
    expect(res.body).not.toContain('<script>alert(1)');
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).toContain('<strong>đậm</strong>');
    expect(markdownToHtml('| a | b |\n|---|---|\n| 1 | <i> |')).toContain('<td>&lt;i&gt;</td>');
  });

  it('file download works and blocks ../ traversal', async () => {
    const { app, repo, cfg } = await boot();
    const r = mkReq(repo);
    const ws = Workspace.for(cfg, r.id).ensure();
    writeFileSync(join(ws.artifactsDir, 'report.md'), 'ok-report');
    writeFileSync(join(ws.root, 'secret.txt'), 'TOP-SECRET');
    mkdirSync(join(ws.evidenceDir, 'TC-1'), { recursive: true });
    writeFileSync(join(ws.evidenceDir, 'TC-1', 'a.png'), 'png');
    const ok = await app.inject({ method: 'GET', url: `/requests/${r.id}/files/report.md` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('ok-report');
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/files/evidence/TC-1/a.png` })).statusCode).toBe(200);
    for (const u of ['..%2Fsecret.txt', '..%2f..%2fsecret.txt', '../secret.txt', '%2e%2e/secret.txt', '..%5Csecret.txt', 'evidence/..%2F..%2Fsecret.txt']) {
      const res = await app.inject({ method: 'GET', url: `/requests/${r.id}/files/${u}` });
      expect(res.statusCode, u).toBeGreaterThanOrEqual(400);
      expect(res.body, u).not.toContain('TOP-SECRET');
    }
  });

  it('bundle.zip returns a zip', async () => {
    const { app, repo, cfg } = await boot();
    const r = mkReq(repo);
    const ws = Workspace.for(cfg, r.id).ensure();
    writeFileSync(join(ws.artifactsDir, 'report.md'), 'x');
    const res = await app.inject({ method: 'GET', url: `/requests/${r.id}/bundle.zip` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('SSE endpoint content-type, replays stored events then streams live', async () => {
    const { app, repo } = await boot();
    const r = mkReq(repo);
    repo.addEvent(r.id, 'info', 'cũ');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const chunks: string[] = [];
    const ctype = await new Promise<string>((resolve, reject) => {
      const req = get({ host: '127.0.0.1', port, path: `/requests/${r.id}/events` }, res => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          chunks.push(c);
          const all = chunks.join('');
          if (all.includes('cũ') && !all.includes('mới')) bus.emit('event', { requestId: r.id, id: 99, ts: Date.now(), level: 'info', message: 'mới' });
          if (all.includes('mới')) { req.destroy(); resolve(String(res.headers['content-type'])); }
        });
      });
      req.on('error', e => { if (!chunks.join('').includes('mới')) reject(e); });
      setTimeout(() => reject(new Error('timeout')), 4000);
    });
    expect(ctype).toContain('text/event-stream');
    await new Promise(r2 => setTimeout(r2, 50));
    expect(bus.listenerCount('event')).toBe(0);
  });
});

describe('web: server mode', () => {
  const origin = { origin: 'http://localhost:3000', host: 'localhost:3000' };
  const form = { 'content-type': 'application/x-www-form-urlencoded', ...origin };

  it('server mode redirects to /login (and /setup when no users)', async () => {
    const { app, repo } = await boot(true);
    const first = await app.inject({ method: 'GET', url: '/' });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe('/setup');
    repo.createUser({ username: 'admin', passwordHash: hashPassword('password123'), role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
    expect((await app.inject({ method: 'GET', url: '/login' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/static/app.css' })).statusCode).toBe(200);
  });

  it('setup creates admin, login sets signed httpOnly cookie, forged cookie rejected', async () => {
    const { app, repo, cfg } = await boot(true);
    const setupRes = await app.inject({ method: 'POST', url: '/setup', payload: 'username=admin&password=password123', headers: form });
    expect(setupRes.statusCode).toBe(302);
    expect(repo.listUsers()).toHaveLength(1);
    expect(repo.listUsers()[0]!.role).toBe('admin');
    expect((await app.inject({ method: 'POST', url: '/setup', payload: 'username=eve&password=password123', headers: form })).statusCode).toBe(302);
    expect(repo.listUsers()).toHaveLength(1);

    const bad = await app.inject({ method: 'POST', url: '/login', payload: 'username=admin&password=nope', headers: form });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/login', payload: 'username=admin&password=password123', headers: form });
    expect(ok.statusCode).toBe(302);
    const sc = String(ok.headers['set-cookie']);
    expect(sc).toMatch(/devflow_sid=\d+\.\d+\.[0-9a-f]{64}/);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Lax');
    const cookie = sc.split(';')[0]!;
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).statusCode).toBe(200);
    const [uid, exp, mac] = cookie.split('=')[1]!.split('.');
    const forged = `devflow_sid=${uid}.${Number(exp) + 1000}.${mac}`;
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie: forged } })).statusCode).toBe(302);
    const expired = `devflow_sid=${signSession(cfg.secretKey, 1, Date.now() - 8 * 24 * 3600 * 1000)}`;
    expect((await app.inject({ method: 'GET', url: '/', headers: { cookie: expired } })).statusCode).toBe(302);
  });

  it('POST from another origin is rejected (CSRF)', async () => {
    const { app, repo, cfg } = await boot(true);
    const u = repo.createUser({ username: 'admin', passwordHash: hashPassword('password123'), role: 'admin' });
    const cookie = `devflow_sid=${signSession(cfg.secretKey, u.id)}`;
    const r = mkReq(repo);
    const evil = await app.inject({ method: 'POST', url: `/requests/${r.id}/cancel`, headers: { cookie, origin: 'http://evil.example', host: 'localhost:3000' } });
    expect(evil.statusCode).toBe(403);
    const none = await app.inject({ method: 'POST', url: `/requests/${r.id}/cancel`, headers: { cookie } });
    expect(none.statusCode).toBe(403);
    expect(repo.getRequest(r.id)!.status).not.toBe('cancelled');
    const good = await app.inject({ method: 'POST', url: `/requests/${r.id}/cancel`, headers: { cookie, ...origin } });
    expect(good.statusCode).toBe(302);
  });
});

