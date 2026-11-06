import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTooLargeError, safeReadFile, safeReadText } from '../../src/engine/safe-fs.js';
import { changeDir } from '../../src/engine/stages/common.js';
import { Workspace } from '../../src/engine/workspace.js';
import { buildServer } from '../../src/web/server.js';
import { mkReq, setup } from '../engine/helpers.js';

/**
 * N1 (re-review): a seat writes a sparse multi-GB analysis.md/impact.md (`truncate -s 20G`). Opening the request page
 * must never allocate it: whole-file reads have a size cap, the UI says the file is too large, the zip has a total cap.
 */
const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const GB = 1024 ** 3;
const sparse = (p: string, size: number): void => { writeFileSync(p, ''); truncateSync(p, size); };

async function boot() {
  const s = setup();
  const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
  apps.push(app);
  const r = mkReq(s.repo);
  const ws = Workspace.for(s.cfg, r.id).ensure();
  mkdirSync(ws.devflowDir, { recursive: true });
  return { ...s, app, r, ws };
}

describe('size caps on reads (N1)', () => {
  it('safeReadFile refuses a file over its cap without allocating it (default and per call)', () => {
    const s = setup();
    const ws = Workspace.for(s.cfg, 'REQ-9').ensure();
    const big = join(ws.artifactsDir, 'big.md');
    sparse(big, 20 * GB);
    expect(() => safeReadFile(big, ws.trustRoot)).toThrow(FileTooLargeError);
    const small = join(ws.artifactsDir, 'small.md');
    writeFileSync(small, 'x'.repeat(100));
    expect(() => safeReadText(small, ws.trustRoot, { maxBytes: 10 })).toThrow(FileTooLargeError);
    expect(safeReadText(small, ws.trustRoot, { maxBytes: 100 })).toHaveLength(100);
  });

  it('analysis tab, impact page, decision panel and changes tab survive sparse 20 GB markdown', async () => {
    const { app, repo, r, ws } = await boot();
    sparse(join(ws.devflowDir, 'analysis.md'), 20 * GB);
    repo.updateRequest(r.id, { status: 'awaiting_approval', stage: 'CHANGE' });
    const cr = repo.createChangeRequest(r.id, { title: 'T', description: 'd', kind: 'add', source: 'staff', status: 'awaiting_decision' });
    mkdirSync(changeDir(ws, cr.id), { recursive: true });
    sparse(join(changeDir(ws, cr.id), 'impact.md'), 20 * GB);
    sparse(join(changeDir(ws, cr.id), 'impact.json'), 20 * GB);
    const analysis = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=analysis` });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.body).toContain('quá lớn');
    const page = await app.inject({ method: 'GET', url: `/requests/${r.id}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('quá lớn');
    const imp = await app.inject({ method: 'GET', url: `/requests/${r.id}/changes/${cr.id}/impact` });
    expect(imp.statusCode).toBe(200);
    expect(imp.body).toContain('quá lớn');
    const tab = await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=changes` });
    expect(tab.statusCode).toBe(200);
  }, 60_000);

  it('bundle.zip refuses when the artifacts exceed the total cap (clear error, nothing streamed)', async () => {
    const { app, r, ws } = await boot();
    writeFileSync(join(ws.artifactsDir, 'ok.md'), 'fine');
    sparse(join(ws.artifactsDir, 'huge.bin'), 300 * 1024 * 1024);
    const zip = await app.inject({ method: 'GET', url: `/requests/${r.id}/bundle.zip` });
    expect(zip.statusCode).toBe(413);
    expect(zip.body).toContain('quá lớn');
  });
});
