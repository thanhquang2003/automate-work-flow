import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeatSweepError } from '../../src/claude/seat-runner.js';
import { clearStages } from '../../src/engine/pipeline.js';
import { startEngine } from '../../src/engine/startup.js';
import { fullProject } from '../projects/helpers.js';
import { registerStubs, v3Env } from './v3-helpers.js';

afterEach(() => clearStages());

/** I1 (final review): after a crash/restart every project is swept before the worker runs any requeued job. */
describe('startup sweep (server mode)', () => {
  async function env() {
    registerStubs();
    const e = await v3Env();
    e.cfg.mode = 'server';
    const { p: p2 } = await fullProject(e, 'CRM');
    const p3 = await e.svc.createProject({ mode: 'new', key: 'OLD', name: 'OLD', path: join(e.root, 'old'), createdBy: e.pm.id });
    e.repo.setProjectArchived(p3.id, true);
    for (const wt of ['R1', 'R1-T-01']) mkdirSync(join(e.p.path, '.devflow', 'worktrees', wt), { recursive: true });
    mkdirSync(join(p2.path, '.devflow', 'worktrees', 'C1'), { recursive: true });
    mkdirSync(join(p3.path, '.devflow', 'worktrees', 'Z1'), { recursive: true });
    return { ...e, p2, p3 };
  }

  it('sweeps every worktree of every non-archived project before the worker starts', async () => {
    const e = await env();
    const order: string[] = [];
    const sweep = e.seats.runner.sweepProject.bind(e.seats.runner);
    e.seats.runner.sweepProject = async (id, wt) => { order.push(`sweep:${id}`); await sweep(id, wt); };
    const start = vi.spyOn(e.worker, 'start').mockImplementation(() => { order.push('worker.start'); });
    await startEngine(e.cfg, e.pipeline, e.worker);
    expect(start).toHaveBeenCalledOnce();
    expect(order.at(-1)).toBe('worker.start');
    expect(e.seats.sweeps.map(([id, wt]) => [id, wt]).sort()).toEqual([
      [e.p.id, join(e.p.path, '.devflow', 'worktrees', 'R1')],
      [e.p.id, join(e.p.path, '.devflow', 'worktrees', 'R1-T-01')],
      [e.p2.id, join(e.p2.path, '.devflow', 'worktrees', 'C1')],
    ].sort());
    expect(e.pipeline.isProjectBlocked(e.p.id)).toBeUndefined();
    expect(e.pipeline.isProjectBlocked(e.p2.id)).toBeUndefined();
  });

  it('a failing sweep blocks only that project (requeued job is refused, request needs_human); others keep running', async () => {
    const e = await env();
    const r1 = await e.request('R1');
    const r2 = await e.svc.createRequest({ projectId: e.p2.id, code: 'C1', title: 'C1', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: e.pm.id });
    e.pipeline.start(r1.id);
    e.pipeline.start(r2.id);
    // Simulate a crash mid-run: the jobs were left `running`.
    for (const r of [r1, r2]) for (const j of e.repo.listJobs(r.id)) e.repo.db.prepare("update jobs set status='running' where id=?").run(j.id);
    const sweep = e.seats.runner.sweepProject.bind(e.seats.runner);
    e.seats.runner.sweepProject = async (id, wt) => {
      if (id === e.p.id) throw new SeatSweepError('symlink in .git/refs');
      await sweep(id, wt);
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(e.worker, 'start').mockImplementation(() => { e.repo.resetRunningJobs(); });
    await startEngine(e.cfg, e.pipeline, e.worker);
    expect(e.pipeline.isProjectBlocked(e.p.id)).toContain('symlink in .git/refs');
    expect(e.pipeline.isProjectBlocked(e.p2.id)).toBeUndefined();
    expect(errors.mock.calls.flat().join(' ')).toContain(`#${e.p.id}`);
    expect(e.repo.web.listAudit({ projectId: e.p.id }).some(a => a.action === 'project.sweep_failed')).toBe(true);
    // The requeued job of the blocked project never runs Claude; the other project's does.
    await e.worker.drain();
    expect(e.repo.getRequest(r1.id)!.status).toBe('needs_human');
    expect(e.seats.calls.some(c => c.cwd.startsWith(e.p.path))).toBe(false);
    expect(e.seats.calls.some(c => c.cwd.startsWith(e.p2.path))).toBe(true);
    errors.mockRestore();
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
