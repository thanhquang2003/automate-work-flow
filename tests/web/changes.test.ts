import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeDir } from '../../src/engine/stages/common.js';
import { Workspace } from '../../src/engine/workspace.js';
import { hashPassword } from '../../src/security/crypto.js';
import { COOKIE, signSession } from '../../src/web/auth.js';
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
function multipart(fields: [string, string][], files: { name: string; filename: string; content: string }[] = []) {
  const b = '----devflowtest';
  let body = '';
  for (const [k, v] of fields) body += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  for (const f of files) body += `--${b}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: text/plain\r\n\r\n${f.content}\r\n`;
  body += `--${b}--\r\n`;
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${b}`, ...origin } };
}

describe('change requests web', () => {
  it('cr form visible for all statuses except cancelled', async () => {
    const { app, repo } = await boot();
    for (const status of ['running', 'awaiting_approval', 'awaiting_customer', 'paused', 'needs_human', 'failed', 'done'] as const) {
      const r = mkReq(repo);
      repo.updateRequest(r.id, { status, stage: status === 'done' ? 'DONE' : 'DESIGN' });
      const res = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=changes` });
      expect(res.body, status).toContain(`action="/requests/${r.id}/changes"`);
      if (status !== 'running' && status !== 'paused') {
        const ov = await app.inject({ method: 'GET', url: `/requests/${r.id}` });
        expect(ov.body, status).not.toContain('/pause"');
      }
    }
    const c = mkReq(repo);
    repo.updateRequest(c.id, { status: 'cancelled' });
    const res = await app.inject({ method: 'GET', url: `/requests/${c.id}?tab=changes` });
    expect(res.body).not.toContain(`action="/requests/${c.id}/changes"`);
    const post = await app.inject({ method: 'POST', url: `/requests/${c.id}/changes`, ...multipart([['title', 'x'], ['description', 'y'], ['kind', 'add']]) });
    expect(post.statusCode).toBe(409);
    expect(repo.listChangeRequests(c.id)).toHaveLength(0);
  });

  it('post change creates CR and calls submitChange with attachments', async () => {
    const { app, repo, pipeline, cfg } = await boot();
    const r = mkReq(repo);
    repo.updateRequest(r.id, { status: 'running', stage: 'DESIGN' });
    const spy = vi.spyOn(pipeline, 'submitChange');
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes`, ...multipart(
      [['title', 'Thêm xuất Excel'], ['description', 'Cần xuất'], ['kind', 'add']],
      [{ name: 'files', filename: '../../tl.txt', content: 'hello' }]) });
    expect(res.statusCode).toBe(302);
    expect(spy).toHaveBeenCalledWith(r.id, expect.objectContaining({ title: 'Thêm xuất Excel', kind: 'add' }));
    const crs = repo.listChangeRequests(r.id);
    expect(crs).toHaveLength(1);
    expect(crs[0]!.status).toBe('pending');
    // visible to CHANGE as soon as the request returns
    const att = repo.listCrAttachments(r.id, crs[0]!.id);
    expect(att).toHaveLength(1);
    expect(att[0]!.filename).toBe('tl.txt');
    expect(att[0]!.path.startsWith(join(Workspace.for(cfg, r.id).inputsDir, 'changes', crs[0]!.id))).toBe(true);
    expect(existsSync(att[0]!.path)).toBe(true);
  });

  it('post change validates fields and kind', async () => {
    const { app, repo } = await boot();
    const r = mkReq(repo);
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes`, ...multipart([['title', ''], ['description', 'y'], ['kind', 'add']]) });
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).toContain('tiêu đề');
    const bad = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes`, ...multipart([['title', 'a'], ['description', 'y'], ['kind', 'zzz']]) });
    expect(bad.statusCode).toBe(302);
    expect(repo.listChangeRequests(r.id)).toHaveLength(0);
  });

  it('decide endpoint per CR', async () => {
    const { app, repo, pipeline } = await boot();
    const r = mkReq(repo);
    repo.updateRequest(r.id, { status: 'awaiting_approval', stage: 'CHANGE' });
    const cr = repo.createChangeRequest(r.id, { title: 'T <b>x</b>', description: 'd', kind: 'add', source: 'staff', status: 'awaiting_decision' });
    const spy = vi.spyOn(pipeline, 'decideChange').mockImplementation(() => cr);
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes/${cr.id}/decide`, headers: form, payload: enc({ decision: 'reject', note: 'không cần' }) });
    expect(res.statusCode).toBe(302);
    expect(spy).toHaveBeenCalledWith(r.id, cr.id, 'reject', 'không cần', null);
    const bad = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes/${cr.id}/decide`, headers: form, payload: enc({ decision: 'maybe' }) });
    expect(decodeURIComponent(String(bad.headers.location))).toContain('err=');
    const page = await app.inject({ method: 'GET', url: `/requests/${r.id}` });
    expect(page.body).toContain(`/changes/${cr.id}/decide`);
    expect(page.body).not.toContain(`/requests/${r.id}/approve`);
    expect(page.body).not.toContain('T <b>x</b>');
  });

  it('impact page escapes html', async () => {
    const { app, repo, cfg } = await boot();
    const r = mkReq(repo);
    const cr = repo.createChangeRequest(r.id, { title: 'T', description: 'd', kind: 'add', source: 'staff', status: 'awaiting_decision' });
    const ws = Workspace.for(cfg, r.id).ensure();
    mkdirSync(changeDir(ws, cr.id), { recursive: true });
    writeFileSync(join(changeDir(ws, cr.id), 'impact.md'), '# Tác động\n\n<script>alert(1)</script> nội dung\n');
    const res = await app.inject({ method: 'GET', url: `/requests/${r.id}/changes/${cr.id}/impact` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('nội dung');
    expect(res.body).not.toContain('<script>alert(1)');
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/changes/CR-99/impact` })).statusCode).toBe(404);
  });

  it('scope tab lists cancelled features', async () => {
    const { app, repo } = await boot();
    const r = mkReq(repo);
    repo.upsertFeatures(r.id, [
      { id: 'F-01', code: 'F01', name: 'Đăng nhập', description: '', typeCode: 'a', unitTest: true, note: '', kind: 'function', scopeStatus: 'active', changedByCr: null },
      { id: 'F-02', code: 'F02', name: 'Báo cáo cũ', description: '', typeCode: 'a', unitTest: true, note: '', kind: 'function', scopeStatus: 'cancelled', changedByCr: 'CR-01' },
    ]);
    const res = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=scope` });
    expect(res.body).toContain('Báo cáo cũ');
    expect(res.body).toContain('Hủy theo CR-01');
    expect(res.body).toContain('prefill=remove:F-01');
    expect(res.body).toContain('prefill=modify:F-01');
    const ch = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=changes&prefill=remove:F-01` });
    expect(ch.body).toContain('F-01');
  });

  it('customer proposal escaped and not auto-run', async () => {
    const { app, repo, pipeline } = await boot(true);
    const r = mkReq(repo);
    repo.updateRequest(r.id, { status: 'awaiting_customer', stage: 'CLARIFY' });
    repo.web.createSurveyLink({ token: 'tok9', requestId: r.id, round: 1, expiresAt: Date.now() + 86_400_000 });
    const sub = vi.spyOn(pipeline, 'submitChange');
    const res = await app.inject({ method: 'POST', url: '/s/tok9', headers: form, payload: enc({ action: 'save', proposal: '<img src=x onerror=1> thêm báo cáo' }) });
    expect(res.statusCode).toBe(200);
    const crs = repo.listChangeRequests(r.id);
    expect(crs).toHaveLength(1);
    expect(crs[0]).toMatchObject({ status: 'proposed', source: 'customer', title: 'Đề xuất của khách hàng' });
    expect(sub).not.toHaveBeenCalled();
    expect(repo.getRequest(r.id)!.stage).toBe('CLARIFY');
    const again = await app.inject({ method: 'POST', url: '/s/tok9', headers: form, payload: enc({ action: 'save', proposal: '' }) });
    expect(again.body).toContain('name="proposal"');
    expect(repo.listChangeRequests(r.id)).toHaveLength(1);
    expect(res.body).not.toContain('<img src=x');
  });

  it('unexpected errors are not flashed; known state errors are', async () => {
    const { app, repo, pipeline } = await boot();
    const r = mkReq(repo);
    const cr = repo.createChangeRequest(r.id, { title: 'P', description: 'd', kind: 'other', source: 'customer', status: 'proposed' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(pipeline, 'acceptProposal').mockImplementation(() => { throw new Error('SQLITE_CORRUPT secret path C:/x'); });
    const boom = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes/${cr.id}/accept-proposal`, headers: form, payload: '' });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain('SQLITE_CORRUPT');
    err.mockRestore();
    const wrong = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes/${cr.id}/decide`, headers: form, payload: enc({ decision: 'accept' }) });
    expect(wrong.statusCode).toBe(302);
    expect(decodeURIComponent(String(wrong.headers.location))).toContain('err=Yêu cầu');
  });

  it('attachment failure still reports the created CR', async () => {
    const { app, repo } = await boot();
    const r = mkReq(repo);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(repo, 'addCrAttachment').mockImplementation(() => { throw new Error('disk'); });
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes`, ...multipart(
      [['title', 'T'], ['description', 'D'], ['kind', 'add']], [{ name: 'files', filename: 'a.txt', content: 'x' }]) });
    err.mockRestore();
    expect(res.statusCode).toBe(302);
    expect(decodeURIComponent(String(res.headers.location))).toContain('Đã tạo CR-01 nhưng không lưu được tệp: a.txt');
    expect(repo.listChangeRequests(r.id)).toHaveLength(1);
  });

  it('identical open customer proposal is not duplicated', async () => {
    const { app, repo } = await boot(true);
    const r = mkReq(repo);
    repo.updateRequest(r.id, { status: 'awaiting_customer', stage: 'CLARIFY' });
    repo.web.createSurveyLink({ token: 'tokd', requestId: r.id, round: 1, expiresAt: Date.now() + 86_400_000 });
    for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: '/s/tokd', headers: form, payload: enc({ action: 'save', proposal: 'thêm báo cáo' }) });
    expect(repo.listChangeRequests(r.id)).toHaveLength(1);
  });

  it('proposal accept/reject endpoints', async () => {
    const { app, repo, pipeline } = await boot();
    const r = mkReq(repo);
    const cr = repo.createChangeRequest(r.id, { title: 'P', description: 'd', kind: 'other', source: 'customer', status: 'proposed' });
    const acc = vi.spyOn(pipeline, 'acceptProposal').mockImplementation(() => cr);
    const rej = vi.spyOn(pipeline, 'rejectProposal').mockImplementation(() => cr);
    await app.inject({ method: 'POST', url: `/requests/${r.id}/changes/${cr.id}/accept-proposal`, headers: form, payload: '' });
    expect(acc).toHaveBeenCalledWith(r.id, cr.id);
    await app.inject({ method: 'POST', url: `/requests/${r.id}/changes/${cr.id}/reject-proposal`, headers: form, payload: enc({ note: 'ngoài phạm vi' }) });
    expect(rej).toHaveBeenCalledWith(r.id, cr.id, 'ngoài phạm vi', null);
  });

  it('header shows version and dashboard shows version column', async () => {
    const { app, repo } = await boot();
    const r = mkReq(repo);
    repo.updateRequest(r.id, { baselineVersion: 3, iteration: 2, stage: 'CHANGE', status: 'running' });
    repo.createChangeRequest(r.id, { title: 'a', description: 'd', kind: 'add', source: 'staff', status: 'pending' });
    const d = await app.inject({ method: 'GET', url: `/requests/${r.id}` });
    expect(d.body).toContain('Phiên bản yêu cầu v3');
    expect(d.body).toContain('Vòng lặp 2');
    const list = await app.inject({ method: 'GET', url: '/' });
    expect(list.body).toContain('Phiên bản');
    expect(list.body).toContain('v3');
  });

  it('docs tab groups by version, newest first', async () => {
    const { app, repo, cfg } = await boot();
    const r = mkReq(repo);
    const ws = Workspace.for(cfg, r.id).ensure();
    for (const n of [`TKCT_${r.id}.docx`, `TKCT_${r.id}_v2.docx`, 'analysis.md']) writeFileSync(join(ws.artifactsDir, n), 'x');
    const res = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=docs` });
    expect(res.body.indexOf('Phiên bản v2')).toBeGreaterThan(-1);
    expect(res.body.indexOf('Phiên bản v2')).toBeLessThan(res.body.indexOf('Phiên bản v1'));
  });

  it('server mode requires auth and Origin for CR routes', async () => {
    const { app, repo } = await boot(true);
    const u = repo.web.createUser({ username: 'a', passwordHash: hashPassword('password123'), role: 'admin' });
    const r = mkReq(repo);
    const cr = repo.createChangeRequest(r.id, { title: 'P', description: 'd', kind: 'other', source: 'customer', status: 'proposed' });
    const routes = [`/requests/${r.id}/changes`, `/requests/${r.id}/changes/${cr.id}/decide`, `/requests/${r.id}/changes/${cr.id}/accept-proposal`, `/requests/${r.id}/changes/${cr.id}/reject-proposal`];
    const cookie = `${COOKIE}=${signSession('test-secret', u.id)}`;
    for (const url of routes) {
      const noAuth = await app.inject({ method: 'POST', url, headers: form, payload: '' });
      expect(noAuth.statusCode, url).toBe(302);
      expect(noAuth.headers.location).toBe('/login');
      const evil = await app.inject({ method: 'POST', url, headers: { ...form, origin: 'https://evil.example', cookie }, payload: '' });
      expect(evil.statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/changes/${cr.id}/impact`, headers: { host: 'localhost:3000' } })).statusCode).toBe(302);
  });
});
