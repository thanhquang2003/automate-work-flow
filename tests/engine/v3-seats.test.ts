import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Workspace } from '../../src/engine/workspace.js';
import { resolveSeat } from '../../src/engine/seats.js';
import { Pipeline } from '../../src/engine/pipeline.js';
import { git } from '../projects/helpers.js';
import { blockingRun, registerStubs, until, v3Env } from './v3-helpers.js';

beforeEach(() => registerStubs());

describe('v3 seats', () => {
  it('stage runs on the runner seat of its role inside the request worktree, sweeping after each run', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    t.pipeline.start(r.id);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
    const ws = Workspace.forRequest(t.cfg, t.repo, r);
    expect(t.seats.calls).toHaveLength(1);
    expect(t.seats.calls[0]).toMatchObject({ userId: t.se.id, cwd: ws.repoDir });
    expect(t.seats.sweeps).toEqual([[t.p.id, ws.repoDir]]);
    expect(t.repo.listJobs(r.id).find(j => (j.payload as { stage: string }).stage === 'CODEBASE_SCAN')!.seatUserId).toBe(t.se.id);
  });

  it('resolveSeat follows the stage table (local requests have none)', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    expect(resolveSeat(t.repo, r, 'ANALYSIS')).toBe(t.ba.id);
    expect(resolveSeat(t.repo, r, 'DESIGN')).toBe(t.se.id);
    expect(resolveSeat(t.repo, r, 'PLANNING')).toBe(t.dev.id);
    expect(resolveSeat(t.repo, r, 'PLANNING', { part: 'testcases' })).toBe(t.tester.id);
    expect(resolveSeat(t.repo, r, 'DEVELOP', { review: true })).toBe(t.rev.id);
    expect(resolveSeat(t.repo, r, 'TEST')).toBe(t.tester.id);
    expect(resolveSeat(t.repo, r, 'CHANGE')).toBe(t.ba.id);
    expect(resolveSeat(t.repo, r, 'INTAKE')).toBeNull();
    expect(resolveSeat(t.repo, { id: 'REQ-1', projectId: null }, 'ANALYSIS')).toBeNull();
  });

  it('expired seat pauses then resumes', async () => {
    let now = 1_000_000;
    const t = await v3Env({ now: () => now });
    const r = await t.request('ERP-001');
    t.seats.state.set(t.se.id, 'expired');
    t.pipeline.start(r.id);
    await t.worker.drain();
    // Not failed: the stage waits for the seat.
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_seat' });
    expect(t.repo.listStageRuns(r.id).at(-1)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_seat' });
    const parked = t.repo.listJobs(r.id).find(j => j.status === 'paused')!;
    expect(parked.payload).toMatchObject({ awaitSeat: t.se.id });
    expect(parked.runAfter).toBe(now + 10 * 60_000);
    const runs = t.seats.calls.length;
    // 10 minutes later the seat is still expired: re-checked through status(), no Claude run, parked again.
    now += 10 * 60_000;
    await t.worker.drain();
    expect(t.seats.statusChecks).toContain(t.se.id);
    expect(t.seats.calls.length).toBe(runs);
    expect(t.repo.getRequest(r.id)!.status).toBe('awaiting_seat');
    // The user reconnects: the stage runs right away on the same seat.
    t.seats.state.set(t.se.id, 'connected');
    expect(t.pipeline.seatReconnected(t.se.id)).toBe(1);
    expect(t.repo.getRequest(r.id)!.status).toBe('running');
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
    expect(t.seats.calls.at(-1)!.userId).toBe(t.se.id);
    // Waiting for a seat is not a failure: no failed stage run, no exception retry.
    expect(t.repo.listStageRuns(r.id).some(s => s.status === 'failed')).toBe(false);
  });

  it('a role without anyone to run it waits for a seat instead of failing', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    t.repo.setRequestAssignees(r.id, 'SE', []);
    t.pipeline.start(r.id);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_seat' });
    expect(t.seats.calls).toHaveLength(0);
  });

  it('seat rate limit pauses only that seat', async () => {
    let now = 1_000_000;
    const t = await v3Env({ now: () => now });
    const se2 = await t.addMember('se2', ['SE']);
    const a = await t.request('ERP-001');
    const b = await t.request('ERP-002', 'review', { SE: [se2.id] });
    const c = await t.request('ERP-003');
    t.seats.setBehave(call => call.userId === t.se.id
      ? { ok: false, resultText: '', error: 'rate limited', rateLimitedUntil: new Date(now + 60 * 60_000) }
      : { ok: true, resultText: 'ok' });
    t.pipeline.start(a.id);
    t.pipeline.start(b.id);
    await t.worker.drain();
    expect(t.repo.getRequest(a.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'paused' });
    expect(t.repo.getRequest(b.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
    expect(t.pipeline.seatPausedTill(t.se.id)).toBe(now + 60 * 60_000);
    // Another request on the paused seat does not start its Claude job while the seat is paused.
    t.pipeline.start(c.id);
    await t.worker.drain();
    const seCalls = t.seats.calls.filter(x => x.userId === t.se.id).length;
    expect(seCalls).toBe(1);
    expect(t.repo.getRequest(c.id)!.stage).toBe('CODEBASE_SCAN');
    expect(t.repo.listJobs(c.id).some(j => j.status === 'queued')).toBe(true);
    // After the pause both requests of that seat continue.
    now += 61 * 60_000;
    t.seats.setBehave(() => ({ ok: true, resultText: 'ok' }));
    await t.worker.drain();
    expect(t.repo.getRequest(a.id)!.status).toBe('awaiting_approval');
    expect(t.repo.getRequest(c.id)!.status).toBe('awaiting_approval');
  });

  it('per-seat concurrency', async () => {
    const t = await v3Env({ seatConcurrency: 1, maxConcurrentJobs: 4 });
    const se2 = await t.addMember('se2', ['SE']);
    const reqs = [await t.request('ERP-001'), await t.request('ERP-002'), await t.request('ERP-003', 'review', { SE: [se2.id] })];
    const blk = blockingRun();
    t.seats.setBehave(blk.behave);
    for (const r of reqs) t.pipeline.start(r.id);
    await until(t.worker, () => blk.started() >= 2);
    const bySeat = (u: number) => t.seats.calls.filter(c => c.userId === u).length;
    // More ticks do not start a second run on the busy seat.
    for (let i = 0; i < 5; i++) await t.worker.tick();
    // Seat se has two requests but runs one at a time; se2 runs alongside.
    expect(bySeat(t.se.id)).toBe(1);
    expect(bySeat(se2.id)).toBe(1);
    blk.release();
    await until(t.worker, () => bySeat(t.se.id) === 2);
    blk.release();
    await t.worker.drain();
    blk.release();
    await t.worker.drain();
    for (const r of reqs) expect(t.repo.getRequest(r.id)!.status).toBe('awaiting_approval');
  });

  it('parallel requests use separate worktrees', async () => {
    const t = await v3Env();
    const a = await t.request('ERP-001');
    const b = await t.request('ERP-002');
    registerStubs({
      CODEBASE_SCAN: async ctx => {
        await ctx.claude('ROLE: explorer');
        writeFileSync(join(ctx.ws.repoDir, 'shared.txt'), ctx.req.code!);
        await ctx.git.commitPaths(['shared.txt'], `scan ${ctx.req.code}`);
        return { kind: 'next' };
      },
    });
    t.pipeline.start(a.id);
    t.pipeline.start(b.id);
    await t.worker.drain();
    const wa = Workspace.forRequest(t.cfg, t.repo, a);
    const wb = Workspace.forRequest(t.cfg, t.repo, b);
    expect(new Set(t.seats.calls.map(c => c.cwd))).toEqual(new Set([wa.repoDir, wb.repoDir]));
    expect(git(t.p.path, 'show', 'devflow/ERP-001:shared.txt')).toBe('ERP-001');
    expect(git(t.p.path, 'show', 'devflow/ERP-002:shared.txt')).toBe('ERP-002');
    expect(git(t.p.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  });

  it('commit author is responsible user', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    registerStubs({
      CODEBASE_SCAN: async ctx => {
        await ctx.claude('ROLE: explorer');
        mkdirSync(join(ctx.ws.repoDir, 'docs'), { recursive: true });
        writeFileSync(join(ctx.ws.repoDir, 'docs', 'map.md'), '# map');
        await ctx.git.commitPaths(['docs'], 'map');
        return { kind: 'next' };
      },
    });
    t.pipeline.start(r.id);
    await t.worker.drain();
    expect(git(t.p.path, 'log', '-1', '--format=%an <%ae>', 'devflow/ERP-001')).toBe(`${t.se.displayName} <${t.se.email}>`);
  });

  it('seats never run outside the project worktrees', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    registerStubs({ CODEBASE_SCAN: async ctx => { await ctx.claude('ROLE: explorer', { cwd: ctx.ws.projectDir! }); return { kind: 'next' }; } });
    t.pipeline.start(r.id);
    await t.worker.drain();
    expect(t.seats.calls).toHaveLength(0);
    expect(t.repo.getRequest(r.id)!.status).toBe('failed');
    expect(t.repo.listEvents(r.id).some(e => /worktree/.test(e.message))).toBe(true);
  });

  it('a failed post-run sweep stops every job of the project', async () => {
    const t = await v3Env();
    const a = await t.request('ERP-001');
    const b = await t.request('ERP-002');
    t.pipeline.start(a.id);
    await t.worker.drain();
    t.seats.failSweeps();
    t.pipeline.approve(a.id, t.se.id);
    t.pipeline.start(b.id);
    await t.worker.drain();
    expect(t.pipeline.isProjectBlocked(t.p.id)).toMatch(/symlink/);
    for (const r of [a, b]) {
      expect(t.repo.getRequest(r.id)!.status).toBe('needs_human');
      expect(t.repo.listJobs(r.id).some(j => j.status === 'queued' || j.status === 'paused')).toBe(false);
    }
    expect(t.repo.listEvents(a.id).some(e => /dfctl sweep/.test(e.message))).toBe(true);
    expect(t.repo.web.listAudit({ projectId: t.p.id }).some(x => x.action === 'project.sweep_failed')).toBe(true);
  });

  it('a change request during awaiting_seat, all rejected: the stage parks again and resumes after reconnect', async () => {
    let now = 1_000_000;
    const t = await v3Env({ now: () => now });
    const r = await t.request('ERP-001');
    t.seats.state.set(t.se.id, 'expired');
    t.pipeline.start(r.id);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)!.status).toBe('awaiting_seat');
    const cr = t.pipeline.submitChange(r.id, { title: 'cr', description: 'd', kind: 'add', createdBy: t.pm.id });
    expect(cr.interruptedStatus).toBe('awaiting_seat');
    // The parked seat job was superseded; skip the CHANGE analysis and go straight to the PM decision.
    for (const j of t.repo.listJobs(r.id)) if (j.status === 'queued' || j.status === 'paused') t.repo.failJob(j.id, 'test');
    t.repo.updateChangeRequest(r.id, cr.id, { status: 'awaiting_decision' });
    t.repo.updateRequest(r.id, { stage: 'CHANGE', status: 'awaiting_approval' });
    t.pipeline.decideChange(r.id, cr.id, 'reject', 'không', t.pm.id);
    expect(t.repo.getRequest(r.id)!.stage).toBe('CODEBASE_SCAN');
    expect(t.repo.listJobs(r.id).some(j => j.status === 'queued' || j.status === 'paused')).toBe(true);
    await t.worker.drain();
    // Seat still expired: the new job parks again (findable by the re-check and by seatReconnected).
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_seat' });
    t.seats.state.set(t.se.id, 'connected');
    expect(t.pipeline.seatReconnected(t.se.id)).toBe(1);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
  });

  it('server mode refuses the local seat runner unless a test opts in', async () => {
    const t = await v3Env();
    const cfg = { ...t.cfg, mode: 'server' as const };
    expect(() => new Pipeline(cfg, t.repo)).toThrow(/server/i);
    expect(() => new Pipeline(cfg, t.repo, { allowLocalSeatsInServerMode: true })).not.toThrow();
    expect(() => new Pipeline(cfg, t.repo, { seatRunner: t.seats.runner })).not.toThrow();
  });

  it('a rerun while the project is blocked after a failed sweep goes to needs_human, not running without a job', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    t.seats.failSweeps();
    t.pipeline.start(r.id);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)!.status).toBe('needs_human');
    t.pipeline.rerunStage(r.id, 'CODEBASE_SCAN');
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'needs_human' });
    expect(t.repo.listEvents(r.id).at(-1)!.message).toMatch(/dừng/);
  });

  it('a seat run that throws (not a sweep failure) is still swept before the retry', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    let n = 0;
    t.seats.setBehave(() => { if (n++ === 0) throw new Error('sudo exploded'); return { ok: true, resultText: 'ok' }; });
    t.pipeline.start(r.id);
    await t.worker.drain();
    const ws = Workspace.forRequest(t.cfg, t.repo, r);
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
    // One sweep after the failed run (before the retry), one after the successful run.
    expect(t.seats.sweeps).toEqual([[t.p.id, ws.repoDir], [t.p.id, ws.repoDir]]);
  });
});
