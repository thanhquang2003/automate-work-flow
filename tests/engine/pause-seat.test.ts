import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../../src/claude/runner.js';
import { registerStage } from '../../src/engine/pipeline.js';
import { develop } from '../../src/engine/stages/develop.js';
import type { TaskRow } from '../../src/domain/types.js';
import { outputPaths, roleOf } from './stage-helpers.js';
import { registerStubs, until, v3Env, type SeatCall } from './v3-helpers.js';

/** I2 (final review): Pause works on awaiting_seat; one parked task does not flip a request whose other tasks run. */
beforeEach(() => {
  registerStubs();
  registerStage('DEVELOP', develop, { gate: true });
});
afterEach(() => vi.restoreAllMocks());

const task = (id: string, assigneeId: number): TaskRow => ({
  id, title: `Task ${id}`, featureId: null, dependsOn: [], status: 'todo', reviewRounds: 0, branch: null, mrIid: null,
  scopeStatus: 'active', changedByCr: null, assigneeId,
});

describe('pause while waiting for a seat', () => {
  it('pause() on awaiting_seat pauses the request; a reconnect does not start the parked job until resume', async () => {
    let now = 1_000_000;
    const t = await v3Env({ now: () => now });
    const r = await t.request('ERP-001');
    t.seats.state.set(t.se.id, 'expired');
    t.pipeline.start(r.id);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)!.status).toBe('awaiting_seat');
    const before = t.seats.calls.length; // the first attempt met the expired seat
    t.pipeline.pause(r.id);
    expect(t.repo.getRequest(r.id)!.status).toBe('paused');
    // The periodic re-check never fires while paused.
    now += 60 * 60_000;
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)!.status).toBe('paused');
    // The seat reconnects: still paused, no Claude run.
    t.seats.state.set(t.se.id, 'connected');
    t.pipeline.seatReconnected(t.se.id);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)!.status).toBe('paused');
    expect(t.seats.calls).toHaveLength(before);
    // Resume: the parked job runs on the (now connected) seat.
    t.pipeline.resume(r.id);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
    expect(t.seats.calls.at(-1)!.userId).toBe(t.se.id);
  });

  it('a parked task job does not flip the request to awaiting_seat while a sibling task runs', async () => {
    const t = await v3Env({ maxConcurrentJobs: 4 });
    const dev2 = await t.addMember('dev2', ['DEV']);
    const r = await t.request('ERP-001');
    t.pipeline.start(r.id);
    await t.worker.drain();
    t.repo.replaceTasks(r.id, [task('T-01', t.dev.id), task('T-02', dev2.id)]);
    for (const x of ['T-01', 'T-02'] as const) t.repo.setTaskAssignee(r.id, x, x === 'T-01' ? t.dev.id : dev2.id);
    const waiting: (() => void)[] = [];
    let devStarted = 0;
    t.seats.setBehave((c: SeatCall): RunResult | Promise<RunResult> => {
      const outs = outputPaths(c.prompt);
      if (roleOf(c.prompt) === 'developer') {
        const id = /\*\*Task (T-\d+)/.exec(c.prompt)?.[1] ?? 'fb';
        writeFileSync(join(c.cwd, `${id}.txt`), `${id}\n`);
        for (const o of outs) { mkdirSync(join(o, '..'), { recursive: true }); writeFileSync(o, `Đã làm ${id} đầy đủ theo yêu cầu.`); }
        devStarted++;
        return new Promise(res => waiting.push(() => res({ ok: true, resultText: 'ok' })));
      }
      if (roleOf(c.prompt) === 'reviewer') {
        for (const o of outs) { mkdirSync(join(o, '..'), { recursive: true }); writeFileSync(o, JSON.stringify({ approved: true, comments: [] })); }
      }
      return { ok: true, resultText: 'ok' };
    });
    t.seats.state.set(dev2.id, 'expired');
    t.pipeline.rerunStage(r.id, 'DEVELOP');
    const parked = () => t.repo.listJobs(r.id).some(j => j.kind === 'run_task' && j.status === 'paused' && (j.payload as { awaitSeat?: number }).awaitSeat === dev2.id);
    // Generous tick budget: the shared test machine is heavily loaded.
    await until(t.worker, () => devStarted === 1 && parked(), 3000);
    // T-01 is live on dev's seat: the request is running, not awaiting_seat.
    expect(t.repo.getRequest(r.id)!.status).toBe('running');
    // The PM pauses: honoured now (running), and the parked job never starts afterwards.
    t.pipeline.pause(r.id);
    expect(t.repo.getRequest(r.id)!.status).toBe('paused');
    t.seats.state.set(dev2.id, 'connected');
    t.pipeline.seatReconnected(dev2.id);
    for (let i = 0; i < 20; i++) { await t.worker.tick(); await new Promise(res => setTimeout(res, 5)); }
    expect(devStarted).toBe(1);
    for (let i = 0; i < 50 && waiting.length === 0; i++) await new Promise(res => setTimeout(res, 5));
    for (const w of waiting.splice(0)) w();
    await t.worker.idle();
    expect(t.repo.getRequest(r.id)!.status).toBe('paused');
  });

  it('when only seat-parked task jobs are left the request shows awaiting_seat', async () => {
    const t = await v3Env({ maxConcurrentJobs: 4 });
    const dev2 = await t.addMember('dev2', ['DEV']);
    const r = await t.request('ERP-001');
    t.pipeline.start(r.id);
    await t.worker.drain();
    t.repo.replaceTasks(r.id, [task('T-02', dev2.id)]);
    t.repo.setTaskAssignee(r.id, 'T-02', dev2.id);
    t.seats.state.set(dev2.id, 'expired');
    t.pipeline.rerunStage(r.id, 'DEVELOP');
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'awaiting_seat' });
  });
});
