import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { GitLabClient, GitLabError } from '../../src/gitlab/client.js';

interface Rec { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server; let base: string; let recs: Rec[];
let respond: (r: Rec) => { status: number; json?: unknown } = () => ({ status: 200, json: {} });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rec = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') };
      recs.push(rec);
      const r = respond(rec);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { recs = []; respond = () => ({ status: 200, json: {} }); });

describe('GitLabClient', () => {
  it('sends PRIVATE-TOKEN header', async () => {
    respond = () => ({ status: 200, json: { id: 1, path_with_namespace: 'g/p', default_branch: 'main', http_url_to_repo: 'x' } });
    const c = new GitLabClient(base + '/', 'tok123');
    const p = await c.getProject('g/p');
    expect(p.id).toBe(1);
    expect(recs[0].headers['private-token']).toBe('tok123');
    expect(recs[0].url).toBe('/api/v4/projects/g%2Fp');
  });
  it('createIssue posts labels joined by comma', async () => {
    respond = () => ({ status: 201, json: { iid: 5, web_url: 'u' } });
    const c = new GitLabClient(base, 't');
    const r = await c.createIssue(1, { title: 'T', description: 'D', labels: ['a', 'b'] });
    expect(r.iid).toBe(5);
    expect(JSON.parse(recs[0].body)).toMatchObject({ title: 'T', labels: 'a,b' });
    expect(recs[0].url).toBe('/api/v4/projects/1/issues');
  });
  it('createBranch ignores already exists', async () => {
    respond = () => ({ status: 400, json: { message: 'Branch already exists' } });
    await expect(new GitLabClient(base, 't').createBranch(1, 'b', 'main')).resolves.toBeUndefined();
  });
  it('createBranch rethrows other errors', async () => {
    respond = () => ({ status: 403, json: { message: 'nope' } });
    const e = await new GitLabClient(base, 't').createBranch(1, 'b', 'main').catch(x => x);
    expect(e).toBeInstanceOf(GitLabError);
    expect(e.status).toBe(403);
    expect(e.body).toContain('nope');
  });
  it('findOpenMR returns first or undefined', async () => {
    const c = new GitLabClient(base, 't');
    respond = () => ({ status: 200, json: [{ iid: 3, web_url: 'w' }] });
    expect((await c.findOpenMR(1, 's', 't'))?.iid).toBe(3);
    expect(recs[0].url).toContain('state=opened');
    respond = () => ({ status: 200, json: [] });
    expect(await c.findOpenMR(1, 's', 't')).toBeUndefined();
  });
  it('findGroupId returns undefined on 404', async () => {
    const c = new GitLabClient(base, 't');
    respond = () => ({ status: 404, json: { message: '404' } });
    expect(await c.findGroupId('grp/sub')).toBeUndefined();
    expect(recs[0].url).toBe('/api/v4/groups/grp%2Fsub');
    respond = () => ({ status: 200, json: { id: 9 } });
    expect(await c.findGroupId('grp')).toBe(9);
  });
  it('createProject, createMR, notes, merge, updateIssue use right endpoints', async () => {
    const c = new GitLabClient(base, 't');
    await c.createProject('n', 4);
    await c.createMR(1, { source: 's', target: 't', title: 'x', description: 'd' });
    await c.addMRNote(1, 2, 'hi');
    await c.mergeMR(1, 2);
    await c.addIssueNote(1, 3, 'hi');
    await c.updateIssue(1, 3, { state_event: 'close', add_labels: 'x' });
    expect(recs.map(r => `${r.method} ${r.url}`)).toEqual([
      'POST /api/v4/projects', 'POST /api/v4/projects/1/merge_requests',
      'POST /api/v4/projects/1/merge_requests/2/notes', 'PUT /api/v4/projects/1/merge_requests/2/merge',
      'POST /api/v4/projects/1/issues/3/notes', 'PUT /api/v4/projects/1/issues/3',
    ]);
    expect(JSON.parse(recs[0].body)).toMatchObject({ name: 'n', namespace_id: 4 });
    expect(JSON.parse(recs[1].body)).toMatchObject({ source_branch: 's', target_branch: 't', remove_source_branch: false });
  });
  it('uploadFile sends multipart', async () => {
    respond = () => ({ status: 201, json: { markdown: '![f](/uploads/x/f.png)' } });
    const f = join(mkdtempSync(join(tmpdir(), 'gl-')), 'f.png');
    writeFileSync(f, 'PNGDATA');
    const r = await new GitLabClient(base, 't').uploadFile(1, f);
    expect(r.markdown).toContain('/uploads/');
    expect(recs[0].headers['content-type']).toMatch(/multipart\/form-data/);
    expect(recs[0].body).toContain('filename="f.png"');
    expect(recs[0].body).toContain('PNGDATA');
  });
});
