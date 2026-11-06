import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeatSweepError } from '../../src/claude/seat-runner.js';
import { clearStages } from '../../src/engine/pipeline.js';
import { startEngine } from '../../src/engine/startup.js';
import type { TaskRow } from '../../src/domain/types.js';
import { fullProject } from '../projects/helpers.js';
import { registerStubs, until, v3Env } from './v3-helpers.js';

const workers: { stop(): void }[] = [];
afterEach(() => { while (workers.length) workers.pop()!.stop(); clearStages(); vi.restoreAllMocks(); });

const task = (id: string): TaskRow => ({ id, title: id, featureId: null, dependsOn: [], status: 'todo', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: 'active', changedByCr: null, assigneeId: null });

/**
 * I1 / I1b: after a restart every project is swept before any of ITS jobs run. Worktrees to sweep come from the DB
 * only (a seat can create directories in .devflow/worktrees); projects are gated one by one, so a slow or failing
 * sweep holds only its own project.
 */
describe('startup sweep (server mode)', () => {
  async function env() {
    registerStubs();
    const e = await v3Env();
    e.cfg.mode = 'server';
    workers.push(e.worker);
    const { p: p2 } = await fullProject(e, 'CRM');
    const p3 = await e.svc.createProject({ mode: 'new', key: 'OLD', name: 'OLD', path: join(e.root, 'old'), createdBy: e.pm.id });
    e.repo.setProjectArchived(p3.id, true);
    return { ...e, p2, p3 };
  }

  it('sweeps only DB-known worktrees (a hostile listing adds nothing); a project without worktrees gets one project-level sweep', async () => {
    const e = await env();
    const r = await e.request('ERP-001');
    e.repo.replaceTasks(r.id, [task('T-01'), task('T-02')]);
    const wt = (n: string) => join(e.p.path, '.devflow', 'worktrees', n);
    for (const n of ['ERP-001', 'ERP-001-T-01']) mkdirSync(wt(n), { recursive: true }); // T-02 has no worktree yet
    for (let i = 0; i < 30; i++) mkdirSync(wt(`hostile-${i}`), { recursive: true });
    mkdirSync(join(e.p3.path, '.devflow', 'worktrees', 'Z1'), { recursive: true });
    await startEngine(e.cfg, e.pipeline, e.worker);
    expect(e.seats.sweeps.filter(([id]) => id === e.p.id).map(([, w]) => w).sort()).toEqual([wt('ERP-001'), wt('ERP-001-T-01')]);
    expect(e.seats.sweeps.filter(([id]) => id === e.p2.id)).toEqual([[e.p2.id, undefined]]);
    expect(e.seats.sweeps.some(([id]) => id === e.p3.id)).toBe(false);
    expect(e.pipeline.isProjectBlocked(e.p.id)).toBeUndefined();
  });

  it('a slow sweep holds only its own project; the other project runs at once', async () => {
    const e = await env();
    const r1 = await e.request('ERP-001');
    const r2 = await e.svc.createRequest({ projectId: e.p2.id, code: 'CRM-001', title: 'c', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: e.pm.id });
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const sweep = e.seats.runner.sweepProject.bind(e.seats.runner);
    e.seats.runner.sweepProject = async (id, w) => { if (id === e.p.id) await gate; await sweep(id, w); };
    e.pipeline.start(r1.id);
    e.pipeline.start(r2.id);
    const done = startEngine(e.cfg, e.pipeline, e.worker);
    // CRM's request reaches its first gate while ERP's sweep is still pending.
    await until(e.worker, () => e.repo.getRequest(r2.id)!.status === 'awaiting_approval', 3000);
    expect(e.repo.getRequest(r1.id)!.stage).toBe('INTAKE');
    expect(e.repo.listJobs(r1.id).every(j => j.status === 'queued')).toBe(true);
    release();
    await done;
    await until(e.worker, () => e.repo.getRequest(r1.id)!.status === 'awaiting_approval', 3000);
  });

  it('a failing sweep blocks only that project (requeued job refused, request needs_human); others run', async () => {
    const e = await env();
    const r1 = await e.request('ERP-001');
    const r2 = await e.svc.createRequest({ projectId: e.p2.id, code: 'CRM-001', title: 'c', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: e.pm.id });
    e.pipeline.start(r1.id);
    e.pipeline.start(r2.id);
    for (const r of [r1, r2]) for (const j of e.repo.listJobs(r.id)) e.repo.db.prepare("update jobs set status='running' where id=?").run(j.id);
    const sweep = e.seats.runner.sweepProject.bind(e.seats.runner);
    e.seats.runner.sweepProject = async (id, w) => { if (id === e.p.id) throw new SeatSweepError('symlink in .git/refs'); await sweep(id, w); };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await startEngine(e.cfg, e.pipeline, e.worker);
    expect(e.pipeline.isProjectBlocked(e.p.id)).toContain('symlink in .git/refs');
    expect(e.pipeline.isProjectBlocked(e.p2.id)).toBeUndefined();
    expect(errors.mock.calls.flat().join(' ')).toContain(`#${e.p.id}`);
    expect(e.repo.web.listAudit({ projectId: e.p.id }).some(a => a.action === 'project.sweep_failed')).toBe(true);
    await until(e.worker, () => e.repo.getRequest(r2.id)!.status === 'awaiting_approval' && e.repo.getRequest(r1.id)!.status === 'needs_human', 3000);
    expect(e.seats.calls.some(c => c.cwd.startsWith(e.p.path))).toBe(false);
  });

  it('local mode: no sweep, the worker just starts', async () => {
    const e = await env();
    e.cfg.mode = 'local';
    const start = vi.spyOn(e.worker, 'start').mockImplementation(() => undefined);
    await startEngine(e.cfg, e.pipeline, e.worker);
    expect(e.seats.sweeps).toEqual([]);
    expect(start).toHaveBeenCalledOnce();
  });
});
