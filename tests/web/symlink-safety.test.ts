import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { changeDir } from '../../src/engine/stages/common.js';
import { Workspace } from '../../src/engine/workspace.js';
import { buildServer } from '../../src/web/server.js';
import { mkReq, setup } from '../engine/helpers.js';

/**
 * C1 (final review): a seat can plant symlinks / FIFOs in the folders it writes (artifacts/, evidence/, the worktree's
 * docs/devflow/<code>/, changes/<cr>/, inputs/). Web routes run as the service user: they must never follow them.
 */
const apps: FastifyInstance[] = [];
const outside: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (outside.length) rmSync(outside.pop()!, { recursive: true, force: true });
});

const SECRET = 'SECRET_KEY=leaked-value-123';

async function boot() {
  const s = setup();
  const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
  apps.push(app);
  const r = mkReq(s.repo);
  const ws = Workspace.for(s.cfg, r.id).ensure();
  mkdirSync(ws.devflowDir, { recursive: true });
  // A file DevFlow can read but the seat must never be able to make it return (stands in for /proc/self/environ, the DB...).
  const out = mkdtempSync(join(tmpdir(), 'devflow-outside-'));
  outside.push(out);
  const secret = join(out, 'secret.txt');
  writeFileSync(secret, SECRET);
  return { ...s, app, r, ws, out, secret };
}

const origin = { origin: 'http://localhost:3000', host: 'localhost:3000' };
function multipart(fields: [string, string][], files: { name: string; filename: string; content: string }[] = []) {
  const b = '----devflowtest';
  let body = '';
  for (const [k, v] of fields) body += `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  for (const f of files) body += `--${b}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: text/plain\r\n\r\n${f.content}\r\n`;
  body += `--${b}--\r\n`;
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${b}`, ...origin } };
}

async function zipTexts(buf: Buffer): Promise<Record<string, string>> {
  const z = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const [name, f] of Object.entries(z.files)) if (!f.dir) out[name] = await f.async('string');
  return out;
}

const mkfifo = (p: string): void => { execFileSync('mkfifo', [p]); };

describe('web routes never follow seat-planted symlinks (C1)', () => {
  it('symlink in artifacts/: file route, docs tab and bundle.zip do not return the target', async () => {
    const { app, r, ws, secret } = await boot();
    writeFileSync(join(ws.artifactsDir, 'ok.md'), 'fine');
    symlinkSync(secret, join(ws.artifactsDir, 'leak.txt'));
    const f = await app.inject({ method: 'GET', url: `/requests/${r.id}/files/leak.txt` });
    expect([403, 404]).toContain(f.statusCode);
    expect(f.body).not.toContain(SECRET);
    const docs = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=docs` });
    expect(docs.statusCode).toBe(200);
    expect(docs.body).not.toContain('leak.txt');
    const zip = await app.inject({ method: 'GET', url: `/requests/${r.id}/bundle.zip` });
    expect(zip.statusCode).toBe(200);
    const files = await zipTexts(zip.rawPayload);
    expect(files['ok.md']).toBe('fine');
    expect(Object.values(files).join('\n')).not.toContain(SECRET);
    expect(Object.keys(files)).not.toContain('leak.txt');
  });

  it('symlink in evidence/: file route, tests tab and bundle.zip do not return the target', async () => {
    const { app, r, ws, secret } = await boot();
    mkdirSync(join(ws.evidenceDir, 'TC-1'), { recursive: true });
    writeFileSync(join(ws.evidenceDir, 'TC-1', 'ok.png'), 'png');
    symlinkSync(secret, join(ws.evidenceDir, 'TC-1', 'leak.png'));
    const f = await app.inject({ method: 'GET', url: `/requests/${r.id}/files/evidence/TC-1/leak.png` });
    expect([403, 404]).toContain(f.statusCode);
    expect(f.body).not.toContain(SECRET);
    const ok = await app.inject({ method: 'GET', url: `/requests/${r.id}/files/evidence/TC-1/ok.png` });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=tests` })).statusCode).toBe(200);
    const zip = await app.inject({ method: 'GET', url: `/requests/${r.id}/bundle.zip` });
    const files = await zipTexts(zip.rawPayload);
    expect(files['evidence/TC-1/ok.png']).toBe('png');
    expect(Object.values(files).join('\n')).not.toContain(SECRET);
  });

  it('intermediate directory symlinks (artifacts/sub, evidence itself, artifacts itself) are refused', async () => {
    const { app, r, ws, out } = await boot();
    symlinkSync(out, join(ws.artifactsDir, 'sub'));
    const f = await app.inject({ method: 'GET', url: `/requests/${r.id}/files/sub/secret.txt` });
    expect([403, 404]).toContain(f.statusCode);
    expect(f.body).not.toContain(SECRET);
    rmSync(ws.evidenceDir, { recursive: true });
    symlinkSync(out, ws.evidenceDir);
    const e = await app.inject({ method: 'GET', url: `/requests/${r.id}/files/evidence/secret.txt` });
    expect([403, 404]).toContain(e.statusCode);
    expect(e.body).not.toContain(SECRET);
    let zip = await app.inject({ method: 'GET', url: `/requests/${r.id}/bundle.zip` });
    expect(Object.values(await zipTexts(zip.rawPayload)).join('\n')).not.toContain(SECRET);
    rmSync(ws.artifactsDir, { recursive: true });
    symlinkSync(out, ws.artifactsDir);
    const a = await app.inject({ method: 'GET', url: `/requests/${r.id}/files/secret.txt` });
    expect([403, 404]).toContain(a.statusCode);
    expect(a.body).not.toContain(SECRET);
    const docs = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=docs` });
    expect(docs.statusCode).toBe(200);
    expect(docs.body).not.toContain('secret.txt');
    zip = await app.inject({ method: 'GET', url: `/requests/${r.id}/bundle.zip` });
    expect(Object.values(await zipTexts(zip.rawPayload)).join('\n')).not.toContain(SECRET);
  });

  it('analysis.md symlink (and a symlinked docs folder) in the worktree is not rendered', async () => {
    const { app, r, ws, secret, out } = await boot();
    symlinkSync(secret, join(ws.devflowDir, 'analysis.md'));
    const res = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=analysis` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('leaked-value-123');
    rmSync(join(ws.repoDir, 'docs'), { recursive: true });
    mkdirSync(join(out, 'devflow'));
    writeFileSync(join(out, 'devflow', 'analysis.md'), SECRET);
    symlinkSync(out, join(ws.repoDir, 'docs'));
    const res2 = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=analysis` });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).not.toContain('leaked-value-123');
  });

  it('impact.md symlink is not rendered (impact page and decision panel)', async () => {
    const { app, repo, r, ws, secret } = await boot();
    repo.updateRequest(r.id, { status: 'awaiting_approval', stage: 'CHANGE' });
    const cr = repo.createChangeRequest(r.id, { title: 'T', description: 'd', kind: 'add', source: 'staff', status: 'awaiting_decision' });
    mkdirSync(changeDir(ws, cr.id), { recursive: true });
    symlinkSync(secret, join(changeDir(ws, cr.id), 'impact.md'));
    symlinkSync(secret, join(changeDir(ws, cr.id), 'impact.json'));
    const imp = await app.inject({ method: 'GET', url: `/requests/${r.id}/changes/${cr.id}/impact` });
    expect(imp.statusCode).toBe(200);
    expect(imp.body).not.toContain('leaked-value-123');
    const page = await app.inject({ method: 'GET', url: `/requests/${r.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('leaked-value-123');
    const tab = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=changes` });
    expect(tab.statusCode).toBe(200);
  });

  it('a symlinked inputs/changes folder does not redirect a CR upload', async () => {
    const { app, repo, r, ws, out } = await boot();
    repo.updateRequest(r.id, { status: 'running', stage: 'DESIGN' });
    const target = join(out, 'redirected');
    mkdirSync(target);
    symlinkSync(target, join(ws.inputsDir, 'changes'));
    const res = await app.inject({ method: 'POST', url: `/requests/${r.id}/changes`, ...multipart(
      [['title', 'x'], ['description', 'y'], ['kind', 'add']],
      [{ name: 'files', filename: 'planted.txt', content: 'payload' }]) });
    expect(res.statusCode).toBe(302);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [e.name]));
    expect(walk(target)).toEqual([]);
    // The CR itself exists; the attachment was refused (flash names it).
    expect(repo.listChangeRequests(r.id)).toHaveLength(1);
    expect(repo.listCrAttachments(r.id, repo.listChangeRequests(r.id)[0]!.id)).toHaveLength(0);
    expect(decodeURIComponent(String(res.headers.location))).toContain('planted.txt');
  });

  it('a symlinked inputs folder does not redirect the CR folder creation either', async () => {
    const { app, repo, r, ws, out } = await boot();
    repo.updateRequest(r.id, { status: 'running', stage: 'DESIGN' });
    rmSync(ws.inputsDir, { recursive: true });
    symlinkSync(out, ws.inputsDir);
    await app.inject({ method: 'POST', url: `/requests/${r.id}/changes`, ...multipart(
      [['title', 'x'], ['description', 'y'], ['kind', 'add']],
      [{ name: 'files', filename: 'planted.txt', content: 'payload' }]) });
    expect(existsSync(join(out, 'changes'))).toBe(false);
  });
});

describe('web routes do not hang on seat-planted FIFOs (C1)', () => {
  it('FIFOs in artifacts/, evidence/, analysis.md and impact.md', async () => {
    const { app, repo, r, ws } = await boot();
    writeFileSync(join(ws.artifactsDir, 'ok.md'), 'fine');
    mkfifo(join(ws.artifactsDir, 'pipe.txt'));
    mkdirSync(join(ws.evidenceDir, 'TC-1'), { recursive: true });
    mkfifo(join(ws.evidenceDir, 'TC-1', 'pipe.png'));
    mkfifo(join(ws.devflowDir, 'analysis.md'));
    const cr = repo.createChangeRequest(r.id, { title: 'T', description: 'd', kind: 'add', source: 'staff', status: 'awaiting_decision' });
    mkdirSync(changeDir(ws, cr.id), { recursive: true });
    mkfifo(join(changeDir(ws, cr.id), 'impact.md'));
    mkfifo(join(changeDir(ws, cr.id), 'impact.json'));
    for (const u of [`/requests/${r.id}/files/pipe.txt`, `/requests/${r.id}/files/evidence/TC-1/pipe.png`]) {
      const res = await app.inject({ method: 'GET', url: u });
      expect([403, 404], u).toContain(res.statusCode);
    }
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=analysis` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=docs` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=tests` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}/changes/${cr.id}/impact` })).statusCode).toBe(200);
    repo.updateRequest(r.id, { status: 'awaiting_approval', stage: 'CHANGE' });
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}` })).statusCode).toBe(200);
    const zip = await app.inject({ method: 'GET', url: `/requests/${r.id}/bundle.zip` });
    expect(zip.statusCode).toBe(200);
    expect((await zipTexts(zip.rawPayload))['ok.md']).toBe('fine');
  }, 30_000);
});
