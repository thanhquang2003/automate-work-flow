import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../../src/claude/runner.js';
import { registerStage } from '../../src/engine/pipeline.js';
import { develop } from '../../src/engine/stages/develop.js';
import type { TaskRow } from '../../src/domain/types.js';
import { outputPaths, roleOf } from './stage-helpers.js';
import { registerStubs, until, v3Env, type SeatCall } from './v3-helpers.js';

/**
 * Task 5 deferred test (final review minor c): a task job (role DEV) makes a reviewer call on the REVIEWER runner's
 * seat. When the PM moves the REVIEWER runner while that call is live (`callMoved`), the run is stopped and the
 * task re-runs; the review then happens on the new reviewer's seat.
 */
beforeEach(() => {
  registerStubs();
  registerStage('DEVELOP', develop, { gate: true });
});
afterEach(() => vi.restoreAllMocks());

describe('reseat triggered by a reviewer call (callMoved)', () => {
  it('moving the REVIEWER runner stops the live review call; the review re-runs on the new reviewer seat', async () => {
    const t = await v3Env({ maxConcurrentJobs: 4 });
    const rev2 = await t.addMember('rev2', ['REVIEWER']);
    const r = await t.request('ERP-001');
    t.pipeline.start(r.id);
    await t.worker.drain();
    const task: TaskRow = { id: 'T-01', title: 'Task T-01', featureId: null, dependsOn: [], status: 'todo', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: 'active', changedByCr: null, assigneeId: t.dev.id };
    t.repo.replaceTasks(r.id, [task]);
    t.repo.setTaskAssignee(r.id, 'T-01', t.dev.id);
    let firstReview: SeatCall | undefined;
    const aborted: number[] = [];
    t.seats.setBehave((c: SeatCall): RunResult | Promise<RunResult> => {
      const outs = outputPaths(c.prompt);
      if (roleOf(c.prompt) === 'developer') {
        writeFileSync(join(c.cwd, 'T-01.txt'), 'T-01\n');
        for (const o of outs) { mkdirSync(join(o, '..'), { recursive: true }); writeFileSync(o, 'Đã làm T-01 đầy đủ theo yêu cầu.'); }
        return { ok: true, resultText: 'ok' };
      }
      if (roleOf(c.prompt) === 'reviewer') {
        if (!firstReview) {
          firstReview = c;
          // The first review blocks until it is stopped.
          return new Promise(res => c.opts.signal?.addEventListener('abort', () => { aborted.push(c.userId!); res({ ok: false, aborted: true, resultText: '', error: 'aborted' }); }, { once: true }));
        }
        for (const o of outs) { mkdirSync(join(o, '..'), { recursive: true }); writeFileSync(o, JSON.stringify({ approved: true, comments: [] })); }
      }
      return { ok: true, resultText: 'ok' };
    });
    t.pipeline.rerunStage(r.id, 'DEVELOP');
    await until(t.worker, () => firstReview !== undefined, 3000);
    expect(firstReview!.userId).toBe(t.rev.id);
    // The task job runs as DEV; the live call is the REVIEWER's: only callMoved can notice the change.
    const taskJob = t.repo.listJobs(r.id).find(j => j.kind === 'run_task' && j.status === 'running')!;
    expect(taskJob.seatUserId).toBe(t.dev.id);
    await t.pipeline.setRunner(r.id, 'REVIEWER', rev2.id, t.pm.id, t.rev.id);
    expect(aborted).toEqual([t.rev.id]);
    await until(t.worker, () => t.repo.getTask(r.id, 'T-01')!.status === 'done', 3000);
    await t.worker.drain();
    const reviews = t.seats.calls.filter(c => roleOf(c.prompt) === 'reviewer');
    expect(reviews.at(-1)!.userId).toBe(rev2.id);
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'awaiting_approval' });
  });
});
