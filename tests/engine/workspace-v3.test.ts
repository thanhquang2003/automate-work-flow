import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workspace } from '../../src/engine/workspace.js';
import { setup } from './helpers.js';
import { register } from './stage-helpers.js';
import { fullProject, git, mkEnv } from '../projects/helpers.js';

async function v3(codes: string[]) {
  const e = mkEnv();
  const f = await fullProject(e);
  const reqs = [];
  for (const code of codes) reqs.push(await e.svc.createRequest({ projectId: f.p.id, code, title: code, description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: e.pm.id }));
  return { e, f, reqs };
}

describe('Workspace v3', () => {
  it('legacy request keeps v2 paths', () => {
    const { cfg, repo } = setup();
    const r = repo.createRequest({ title: 't', description: '', perfReq: '', nonfuncReq: '', projectKind: 'new', gitlabProject: null, softwareTypes: ['web'], runMode: 'auto', createdBy: null });
    const ws = Workspace.forRequest(cfg, repo, r);
    expect(ws.repoDir).toBe(join(cfg.dataDir, 'workspaces', r.id, 'repo'));
    expect(ws.devflowDir).toBe(join(ws.repoDir, 'docs', 'devflow'));
    expect(ws.key).toBe(r.id);
    expect(ws.docsRel).toBe('docs/devflow');
  });
  it('docs path per request code', async () => {
    const { e, f, reqs } = await v3(['ERP-001']);
    const ws = Workspace.forRequest(e.cfg, e.repo, reqs[0]!);
    expect(ws.root).toBe(join(f.p.path, '.devflow', 'requests', 'ERP-001'));
    expect(ws.repoDir).toBe(join(f.p.path, '.devflow', 'worktrees', 'ERP-001'));
    expect(ws.devflowDir).toBe(join(ws.repoDir, 'docs', 'devflow', 'ERP-001'));
    expect(ws.docsRel).toBe('docs/devflow/ERP-001');
    expect(ws.taskWorktree('T-01')).toBe(join(f.p.path, '.devflow', 'worktrees', 'ERP-001-T-01'));
    expect(ws.taskBranch('T-01')).toBe('devflow/ERP-001-T-01');
    expect(() => ws.taskWorktree('../x')).toThrow();
    ws.ensure();
    for (const d of ['inputs', 'artifacts', 'evidence', 'logs']) expect(existsSync(join(ws.root, d))).toBe(true);
    expect(existsSync(ws.repoDir)).toBe(false);
  });
  it('intake creates worktree from default branch', async () => {
    register(['CODEBASE_SCAN']);
    const { cfg, repo, pipeline, worker } = setup();
    const e = mkEnv(); const f = await fullProject(e);
    const r = await e.svc.createRequest({ projectId: f.p.id, code: 'ERP-001', title: 't', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: e.pm.id });
    // run the pipeline against the service's repo/config
    const s = setup({ projectRoots: e.cfg.projectRoots });
    void cfg; void repo; void pipeline; void worker;
    const { Pipeline } = await import('../../src/engine/pipeline.js');
    const { Worker } = await import('../../src/engine/worker.js');
    const pl = new Pipeline(s.cfg, e.repo); const wk = new Worker(s.cfg, e.repo, pl);
    pl.start(r.id);
    await wk.drain();
    const ws = Workspace.forRequest(s.cfg, e.repo, r);
    expect(git(ws.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('devflow/ERP-001');
    expect(git(f.p.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(ws.repoDir, 'rev-parse', 'HEAD')).toBe(git(f.p.path, 'rev-parse', 'main'));
    expect(e.repo.getRequest(r.id)!.stage).toBe('CODEBASE_SCAN');
  });
  it('two requests get separate worktrees and branches', async () => {
    register(['CODEBASE_SCAN']);
    const { e, f, reqs } = await v3(['ERP-001', 'ERP-002']);
    const s = setup({ projectRoots: e.cfg.projectRoots });
    const { Pipeline } = await import('../../src/engine/pipeline.js');
    const { Worker } = await import('../../src/engine/worker.js');
    const pl = new Pipeline(s.cfg, e.repo); const wk = new Worker(s.cfg, e.repo, pl);
    for (const r of reqs) pl.start(r.id);
    await wk.drain();
    const wss = reqs.map(r => Workspace.forRequest(s.cfg, e.repo, r));
    expect(wss[0]!.repoDir).not.toBe(wss[1]!.repoDir);
    expect(wss.map(w => git(w.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'))).toEqual(['devflow/ERP-001', 'devflow/ERP-002']);
    writeFileSync(join(wss[0]!.repoDir, 'only1.txt'), 'x');
    expect(existsSync(join(wss[1]!.repoDir, 'only1.txt'))).toBe(false);
    expect(readdirSync(join(f.p.path, '.devflow', 'worktrees')).sort()).toEqual(['ERP-001', 'ERP-002']);
    expect(git(f.p.path, 'status', '--porcelain')).toBe('');
  });
});
