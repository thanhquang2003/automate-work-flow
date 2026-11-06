import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { PermissionError } from '../../src/engine/pipeline.js';
import { planning } from '../../src/engine/stages/planning.js';
import { registerStage } from '../../src/engine/pipeline.js';
import type { Stage } from '../../src/domain/types.js';
import { blockingRun, registerStubs, until, v3Env } from './v3-helpers.js';

beforeEach(() => registerStubs());

/** Request parked at `stage`'s gate (review mode). */
async function atGate(t: Awaited<ReturnType<typeof v3Env>>, code: string, stage: Stage) {
  const r = await t.request(code);
  t.pipeline.start(r.id);
  await t.worker.drain();
  if (stage !== 'CODEBASE_SCAN') {
    t.pipeline.rerunStage(r.id, stage);
    await t.worker.drain();
  }
  expect(t.repo.getRequest(r.id)).toMatchObject({ stage, status: 'awaiting_approval' });
  return r;
}

const audits = (t: Awaited<ReturnType<typeof v3Env>>, action: string) => t.repo.web.listAudit({ projectId: t.p.id }).filter(a => a.action === action);

describe('v3 approvals', () => {
  it('non-approver approve throws PermissionError and changes nothing', async () => {
    const t = await v3Env();
    const r = await atGate(t, 'ERP-001', 'ANALYSIS');
    for (const who of [t.dev.id, t.se.id, t.tester.id, null]) {
      expect(() => t.pipeline.approve(r.id, who)).toThrow(PermissionError);
      expect(() => t.pipeline.reject(r.id, 'x', who)).toThrow(PermissionError);
    }
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'ANALYSIS', status: 'awaiting_approval' });
    expect(t.repo.listApprovals(r.id)).toEqual([]);
    // The BA of the request approves; PM may approve any gate.
    t.pipeline.approve(r.id, t.ba.id);
    expect(t.repo.getRequest(r.id)!.stage).toBe('CLARIFY');
    expect(t.repo.listApprovals(r.id, 'ANALYSIS')).toMatchObject([{ userId: t.ba.id, decision: 'approve' }]);
    expect(audits(t, 'gate.approve')).toMatchObject([{ userId: t.ba.id, requestId: r.id }]);
  });

  it('a project member who is not assigned to the role on this request cannot approve', async () => {
    const t = await v3Env();
    const ba2 = await t.addMember('ba2', ['BA']);
    const r = await t.request('ERP-001', 'review', { BA: [t.ba.id] });
    t.pipeline.start(r.id);
    await t.worker.drain();
    t.pipeline.rerunStage(r.id, 'ANALYSIS');
    await t.worker.drain();
    expect(() => t.pipeline.approve(r.id, ba2.id)).toThrow(PermissionError);
    t.pipeline.approve(r.id, t.pm.id);
    expect(t.repo.getRequest(r.id)!.stage).toBe('CLARIFY');
  });

  // Global Constraints: DEVELOP's approver is the REVIEWER role (the brief's name says "dev assignee"); any
  // assignee of that role approves, one rejection by any of them returns the step. A DEV cannot approve it.
  it('any dev assignee approves develop gate and one reject returns the step', async () => {
    const t = await v3Env();
    const rev2 = await t.addMember('rev2', ['REVIEWER']);
    const r = await t.request('ERP-001', 'review', { REVIEWER: [t.rev.id, rev2.id] });
    registerStubs({ DEVELOP: async () => ({ kind: 'next' }) });
    t.pipeline.start(r.id);
    await t.worker.drain();
    t.pipeline.rerunStage(r.id, 'DEVELOP');
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'awaiting_approval' });
    expect(() => t.pipeline.approve(r.id, t.dev.id)).toThrow(PermissionError);
    // The second reviewer (not the runner) rejects alone: the step goes back.
    t.pipeline.reject(r.id, 'thiếu test', rev2.id);
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'running' });
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'awaiting_approval' });
    expect(t.repo.latestStageRun(r.id, 'DEVELOP')!.feedback).toBe('thiếu test');
    // Rejections of the previous attempt are cleared when the stage reruns.
    expect(t.repo.listApprovals(r.id, 'DEVELOP')).toEqual([]);
    // One approval by any reviewer suffices.
    t.pipeline.approve(r.id, rev2.id);
    expect(t.repo.getRequest(r.id)!.stage).toBe('TEST');
    expect(audits(t, 'gate.reject')).toMatchObject([{ userId: rev2.id }]);
  });

  it('planning approved by PM only', async () => {
    const t = await v3Env();
    const r = await atGate(t, 'ERP-001', 'PLANNING');
    for (const who of [t.dev.id, t.tester.id, t.ba.id]) {
      expect(() => t.pipeline.approve(r.id, who)).toThrow(PermissionError);
      expect(() => t.pipeline.reject(r.id, 'x', who, 'tasks')).toThrow(PermissionError);
    }
    t.pipeline.approve(r.id, t.pm.id);
    expect(t.repo.getRequest(r.id)!.stage).toBe('DEVELOP');
  });

  it('planning runs tasks on the DEV seat and test cases on the TESTER seat; PM reject with part reruns that part only', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    t.repo.replaceFeatures(r.id, [{ id: 'F-01', code: 'QL', name: 'Quản lý', description: '', typeCode: '', unitTest: true, note: '', kind: 'function', scopeStatus: 'active', changedByCr: null }]);
    registerStubs();
    registerStage('PLANNING', planning, { gate: true });
    const { writeFileSync, mkdirSync } = await import('node:fs');
    t.seats.setBehave(c => {
      const dir = join(c.cwd, 'docs', 'devflow', 'ERP-001');
      mkdirSync(dir, { recursive: true });
      if (/chỉ lập `tasks.json`/.test(c.prompt)) writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'T-01', title: 'API', feature_id: 'F-01', depends_on: [] }] }));
      if (/chỉ lập `testcases.json`/.test(c.prompt)) writeFileSync(join(dir, 'testcases.json'), JSON.stringify({ test_cases: [{ id: 'TC-QL-01', feature_id: 'F-01', purpose: 'p', data: '', steps: '1. a', expected: 'e' }] }));
      return { ok: true, resultText: 'ok' };
    });
    t.pipeline.start(r.id);
    await t.worker.drain();
    t.pipeline.rerunStage(r.id, 'PLANNING');
    const before = t.seats.calls.length;
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'PLANNING', status: 'awaiting_approval' });
    const runs = t.seats.calls.slice(before);
    expect(runs.map(c => c.userId)).toEqual([t.dev.id, t.tester.id]);
    expect(t.repo.listTasks(r.id).map(x => x.id)).toEqual(['T-01']);
    expect(t.repo.listTestCases(r.id).map(x => x.id)).toEqual(['TC-QL-01']);
    // PM rejects the test cases: only the TESTER run happens again.
    t.pipeline.reject(r.id, 'thiếu trường hợp biên', t.pm.id, 'testcases');
    const n = t.seats.calls.length;
    await t.worker.drain();
    const again = t.seats.calls.slice(n);
    expect(again.map(c => c.userId)).toEqual([t.tester.id]);
    expect(again[0]!.prompt).toMatch(/thiếu trường hợp biên/);
    expect(t.repo.listApprovals(r.id, 'PLANNING')).toEqual([]);
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'PLANNING', status: 'awaiting_approval' });
  });

  it('CHANGE decisions are PM only; DONE in review mode waits for the PM', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    t.pipeline.start(r.id);
    await t.worker.drain();
    t.pipeline.rerunStage(r.id, 'DONE');
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DONE', status: 'awaiting_approval' });
    expect(() => t.pipeline.approve(r.id, t.rev.id)).toThrow(PermissionError);
    expect(() => t.pipeline.reject(r.id, 'x', t.pm.id)).toThrow(/DONE/);
    t.pipeline.approve(r.id, t.pm.id);
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DONE', status: 'done' });

    const r2 = await t.request('ERP-002');
    t.repo.updateRequest(r2.id, { stage: 'CHANGE', status: 'awaiting_approval' });
    t.repo.createChangeRequest(r2.id, { title: 'cr', description: 'd', kind: 'add', source: 'staff', createdBy: t.pm.id, status: 'awaiting_decision' });
    expect(() => t.pipeline.decideChange(r2.id, 'CR-01', 'reject', 'no', t.ba.id)).toThrow(PermissionError);
    expect(t.repo.getChangeRequest(r2.id, 'CR-01')!.status).toBe('awaiting_decision');
    t.pipeline.decideChange(r2.id, 'CR-01', 'reject', 'không cần', t.pm.id);
    expect(t.repo.getChangeRequest(r2.id, 'CR-01')!.status).toBe('rejected');
    expect(audits(t, 'cr.decide')).toMatchObject([{ userId: t.pm.id, requestId: r2.id }]);
  });

  it('stages without a gate cannot be approved by anyone', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    t.repo.updateRequest(r.id, { stage: 'TEST', status: 'awaiting_approval' });
    expect(() => t.pipeline.approve(r.id, t.pm.id)).toThrow(PermissionError);
  });

  it('runner change restarts stage on new seat without retry count', async () => {
    const t = await v3Env();
    const se2 = await t.addMember('se2', ['SE']);
    const r = await t.request('ERP-001', 'review', { SE: [t.se.id, se2.id] });
    const blk = blockingRun();
    t.seats.setBehave(c => (c.userId === t.se.id ? blk.behave(c) : { ok: true, resultText: 'ok' }));
    t.pipeline.start(r.id);
    await until(t.worker, () => blk.started() === 1);
    await expect(t.pipeline.setRunner(r.id, 'SE', se2.id, t.dev.id)).rejects.toThrow(PermissionError);
    await t.pipeline.setRunner(r.id, 'SE', se2.id, t.pm.id);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
    expect(t.seats.calls.map(c => c.userId)).toEqual([t.se.id, se2.id]);
    const runs = t.repo.listStageRuns(r.id).filter(s => s.stage === 'CODEBASE_SCAN');
    expect(runs.map(s => s.status)).toEqual(['cancelled', 'done']);
    expect(runs.some(s => s.status === 'failed')).toBe(false);
    // Not counted as an exception retry.
    const jobs = t.repo.listJobs(r.id).filter(j => (j.payload as { stage: string }).stage === 'CODEBASE_SCAN');
    expect(jobs.map(j => (j.payload as { errRetries?: number }).errRetries ?? 0)).toEqual([0, 0]);
    expect(jobs.at(-1)!.seatUserId).toBe(se2.id);
    expect(t.repo.listRequestAssignees(r.id, 'SE').map(a => a.userId)).toEqual([se2.id, t.se.id]);
    expect(audits(t, 'request.runner.set')).toHaveLength(1);
  });

  it('removing member reassigns their running jobs', async () => {
    const t = await v3Env();
    const se2 = await t.addMember('se2', ['SE']);
    const order: string[] = [];
    const origSet = t.systemOps.setMembers;
    t.systemOps.setMembers = async (id, users) => { order.push(`group:${users.join(',')}`); return origSet(id, users); };
    const pipeline = new (t.pipeline.constructor as typeof import('../../src/engine/pipeline.js').Pipeline)(t.cfg, t.repo, { seatRunner: t.seats.runner, members: t.svc });
    t.svc.attachEngine(pipeline);
    const { Worker } = await import('../../src/engine/worker.js');
    const worker = new Worker(t.cfg, t.repo, pipeline);
    const r = await t.request('ERP-001', 'review', { SE: [t.se.id, se2.id] });
    const blk = blockingRun();
    t.seats.setBehave(c => {
      if (c.userId !== t.se.id) return { ok: true, resultText: 'ok' };
      c.opts.signal?.addEventListener('abort', () => order.push('run-stopped'), { once: true });
      return blk.behave(c);
    });
    pipeline.start(r.id);
    await until(worker, () => blk.started() === 1);
    await expect(pipeline.removeMember(t.p.id, t.se.id, t.dev.id)).rejects.toThrow(PermissionError);
    await pipeline.removeMember(t.p.id, t.se.id, t.pm.id);
    // The seat's run was stopped before the OS group changed.
    expect(order[0]).toBe('run-stopped');
    const groups = order.slice(1);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) expect(g.slice('group:'.length).split(',')).not.toContain(String(t.se.id));
    expect(t.repo.getProjectMember(t.p.id, t.se.id)).toBeUndefined();
    await worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
    expect(t.seats.calls.map(c => c.userId)).toEqual([t.se.id, se2.id]);
    expect(t.repo.listStageRuns(r.id).filter(s => s.stage === 'CODEBASE_SCAN').map(s => s.status)).toEqual(['cancelled', 'done']);
  });
});
