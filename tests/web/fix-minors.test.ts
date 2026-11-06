import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from '../../src/engine/workspace.js';
import { buildServer } from '../../src/web/server.js';
import { mkReq, setup } from '../engine/helpers.js';
import { webEnv } from './v3-helpers.js';

/** Re-review minors m1-m4. */
const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const origin = { origin: 'http://localhost:3000', host: 'localhost:3000' };
function multipart(fields: [string, string][], files: { name: string; filename: string; content: string }[] = []) {
  const b = '----devflowtest';
  let body = '';
  for (const [k, v] of fields) body += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  for (const f of files) body += `--${b}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: text/plain\r\n\r\n${f.content}\r\n`;
  body += `--${b}--\r\n`;
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${b}`, ...origin } };
}

describe('re-review minors', () => {
  it('m1: disabling a user also drops them from archived projects\' groups', async () => {
    const w = await webEnv();
    const admin = w.mkUser('adm'); w.repo.web.setUserSysRole(admin.id, 'admin');
    w.repo.setProjectArchived(w.p.id, true);
    const n = w.ops.members.length;
    await w.post(admin.id, `/admin/users/${w.dev.id}/disable`, { value: '1' });
    const row = w.ops.members.slice(n).find(m => m[0] === w.p.id);
    expect(row).toBeDefined();
    expect(row![1]).not.toContain(w.dev.id);
  });

  it('m2: legacy create with a pre-planted workspace link fails cleanly (409, no orphan request, nothing outside)', async () => {
    const s = setup();
    const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
    apps.push(app);
    const out = mkdtempSync(join(tmpdir(), 'df-m2-'));
    mkdirSync(join(s.cfg.dataDir, 'workspaces'), { recursive: true });
    symlinkSync(out, join(s.cfg.dataDir, 'workspaces', 'REQ-001'));
    const res = await app.inject({ method: 'POST', url: '/requests', ...multipart(
      [['title', 't'], ['description', 'd'], ['project_kind', 'new'], ['run_mode', 'auto']], [{ name: 'files', filename: 'a.txt', content: 'x' }]) });
    expect(res.statusCode).toBe(409);
    expect(s.repo.listRequests()).toHaveLength(0);
    expect(readdirSync(out)).toEqual([]);
  });

  it('m3: /files/<directory> answers 404, a symlink 403', async () => {
    const s = setup();
    const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
    apps.push(app);
    const r = mkReq(s.repo);
    const ws = Workspace.for(s.cfg, r.id).ensure();
    mkdirSync(join(ws.artifactsDir, 'sub'));
    writeFileSync(join(ws.root, 'x.txt'), 'x');
    symlinkSync(join(ws.root, 'x.txt'), join(ws.artifactsDir, 'link.txt'));
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/files/sub` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/files/evidence` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/files/link.txt` })).statusCode).toBe(403);
    // Round 2 item 2: a path below a FILE (ENOTDIR) is 404, not a 500.
    writeFileSync(join(ws.artifactsDir, 'analysis.md'), '# a');
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/files/analysis.md/x` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/files/evidence/nope/x` })).statusCode).toBe(404);
  });

  it('m4: a pre-planted requests/<code> link makes project request creation fail cleanly (no orphan row)', async () => {
    const w = await webEnv();
    const out = mkdtempSync(join(tmpdir(), 'df-m4-'));
    mkdirSync(join(w.p.path, '.devflow', 'requests'), { recursive: true });
    symlinkSync(out, join(w.p.path, '.devflow', 'requests', 'ERP-777'));
    const fields: [string, string][] = [['code', 'ERP-777'], ['title', 't'], ['description', 'd'],
      ...([['PM', w.pm.id], ['BA', w.ba.id], ['SE', w.se.id], ['DEV', w.dev.id], ['REVIEWER', w.rev.id], ['TESTER', w.tester.id]] as const).map(([r, id]): [string, string] => [`a_${r}`, String(id)])];
    const m = multipart(fields, [{ name: 'files', filename: 'a.txt', content: 'x' }]);
    const res = await w.app.inject({ method: 'POST', url: `/projects/${w.p.id}/requests`, payload: m.payload, headers: { ...m.headers, cookie: w.cookie(w.pm.id) } });
    expect(res.statusCode).toBe(409);
    expect(w.repo.listRequests().filter(r => r.code === 'ERP-777')).toHaveLength(0);
    expect(readdirSync(out)).toEqual([]);
    expect(existsSync(join(out, 'inputs'))).toBe(false);
  });
});
