import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RunResult } from '../../src/claude/runner.js';
import { registerStage } from '../../src/engine/pipeline.js';
import { develop } from '../../src/engine/stages/develop.js';
import { done } from '../../src/engine/stages/done.js';
import { Workspace } from '../../src/engine/workspace.js';
import { Git } from '../../src/gitlab/git.js';
import type { TaskRow } from '../../src/domain/types.js';
import { git } from '../projects/helpers.js';
import { outputPaths, roleOf } from './stage-helpers.js';
import { registerStubs, until, v3Env, type SeatCall } from './v3-helpers.js';

const task = (id: string, dependsOn: string[] = [], assigneeId: number | null = null): TaskRow => ({
  id, title: `Task ${id}`, featureId: null, dependsOn, status: 'todo', reviewRounds: 0, branch: null, mrIid: null,
  scopeStatus: 'active', changedByCr: null, assigneeId,
});

/** Developer writes `<task>.txt` + the summary; Reviewer approves. `hold` keeps developer runs open until released. */
function devMock(hold = false) {
  const waiting: (() => void)[] = [];
  const devStarted: string[] = [];
  const behave = (c: SeatCall): RunResult | Promise<RunResult> => {
    const outs = outputPaths(c.prompt);
    if (roleOf(c.prompt) === 'developer') {
      const id = /\*\*Task (T-\d+)/.exec(c.prompt)?.[1] ?? 'fb';
      writeFileSync(join(c.cwd, `${id}.txt`), `${id}\n`);
      for (const o of outs) { mkdirSync(join(o, '..'), { recursive: true }); writeFileSync(o, `Đã làm ${id} đầy đủ theo yêu cầu.`); }
      devStarted.push(id);
      if (hold) return new Promise(res => waiting.push(() => res({ ok: true, resultText: 'ok' })));
      return { ok: true, resultText: 'ok' };
    }
    if (roleOf(c.prompt) === 'reviewer') {
      for (const o of outs) { mkdirSync(join(o, '..'), { recursive: true }); writeFileSync(o, JSON.stringify({ approved: true, comments: [] })); }
    }
    return { ok: true, resultText: 'ok' };
  };
  return { behave, devStarted, release: () => { for (const w of waiting.splice(0)) w(); } };
}

async function atDevelop(t: Awaited<ReturnType<typeof v3Env>>, tasks: TaskRow[]) {
  const r = await t.request('ERP-001');
  t.pipeline.start(r.id);
  await t.worker.drain();
  t.repo.replaceTasks(r.id, tasks);
  for (const x of tasks) if (x.assigneeId) t.repo.setTaskAssignee(r.id, x.id, x.assigneeId);
  return r;
}

beforeEach(() => {
  registerStubs();
  registerStage('DEVELOP', develop, { gate: true });
});
afterEach(() => vi.restoreAllMocks());

describe('v3 parallel tasks', () => {
  it('independent tasks of two devs run in parallel; merges serialized', async () => {
    const t = await v3Env({ maxConcurrentJobs: 4 });
    const dev2 = await t.addMember('dev2', ['DEV']);
    const r = await atDevelop(t, [task('T-01', [], t.dev.id), task('T-02', [], dev2.id), task('T-03', ['T-01', 'T-02'], t.dev.id)]);
    const m = devMock(true);
    t.seats.setBehave(m.behave);
    // Track merges into devflow/ERP-001: never two at once.
    let active = 0;
    let maxActive = 0;
    const orig = Git.prototype.merge;
    vi.spyOn(Git.prototype, 'merge').mockImplementation(async function (this: Git, branch: string, msg: string) {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(res => setTimeout(res, 150));
      try { return await orig.call(this, branch, msg); } finally { active--; }
    });
    t.pipeline.rerunStage(r.id, 'DEVELOP');
    // Both independent tasks are in their developer runs at the same time, on their own seats and worktrees.
    await until(t.worker, () => m.devStarted.length === 2);
    const ws = Workspace.forRequest(t.cfg, t.repo, r);
    const devCalls = t.seats.calls.filter(c => roleOf(c.prompt) === 'developer');
    expect(new Map(devCalls.map(c => [basename(c.cwd), c.userId]))).toEqual(new Map([['ERP-001-T-01', t.dev.id], ['ERP-001-T-02', dev2.id]]));
    expect(devCalls.every(c => c.cwd !== ws.repoDir)).toBe(true);
    expect(t.repo.getTask(r.id, 'T-03')!.status).toBe('todo'); // waits for its dependencies
    for (let i = 0; i < 100 && t.repo.getTask(r.id, 'T-03')!.status !== 'done'; i++) {
      m.release();
      await t.worker.tick();
      await new Promise(res => setTimeout(res, 20));
    }
    m.release();
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'awaiting_approval' });
    expect(t.repo.listTasks(r.id).map(x => x.status)).toEqual(['done', 'done', 'done']);
    expect(maxActive).toBe(1);
    for (const f of ['T-01.txt', 'T-02.txt', 'T-03.txt']) expect(git(t.p.path, 'show', `devflow/ERP-001:${f}`)).toBe(f.slice(0, 4));
    // T-03 started only after both merges, on its assignee's seat; task worktrees are removed after the merge.
    expect(t.seats.calls.filter(c => roleOf(c.prompt) === 'developer').at(-1)).toMatchObject({ userId: t.dev.id });
    expect(existsSync(ws.taskWorktree('T-01'))).toBe(false);
    expect(git(ws.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('devflow/ERP-001');
    // Merge commits carry the task owner's identity.
    expect(git(t.p.path, 'log', '--merges', '--format=%ae', 'devflow/ERP-001').split('\n').sort()).toEqual([dev2.email, t.dev.email, t.dev.email].sort());
  });

  it('review runs with reviewer seat', async () => {
    const t = await v3Env();
    const r = await atDevelop(t, [task('T-01')]);
    t.seats.setBehave(devMock().behave);
    t.pipeline.rerunStage(r.id, 'DEVELOP');
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'awaiting_approval' });
    const work = t.seats.calls.filter(c => ['developer', 'reviewer'].includes(roleOf(c.prompt)));
    expect(work.map(c => [roleOf(c.prompt), c.userId])).toEqual([['developer', t.dev.id], ['reviewer', t.rev.id]]);
    // The reviewer runs in the task worktree, which is swept after each run.
    const wt = Workspace.forRequest(t.cfg, t.repo, r).taskWorktree('T-01');
    expect(work[1]!.cwd).toBe(wt);
    expect(t.seats.sweeps.filter(([, w]) => w === wt)).toHaveLength(2);
  });

  it('two requests of one project develop in separate worktrees', async () => {
    const t = await v3Env();
    const a = await atDevelop(t, [task('T-01')]);
    const b = await t.request('ERP-002');
    t.pipeline.start(b.id);
    await t.worker.drain();
    t.repo.replaceTasks(b.id, [task('T-01')]);
    t.seats.setBehave(devMock().behave);
    t.pipeline.rerunStage(a.id, 'DEVELOP');
    t.pipeline.rerunStage(b.id, 'DEVELOP');
    await t.worker.drain();
    const cwds = new Set(t.seats.calls.filter(c => roleOf(c.prompt) === 'developer').map(c => basename(c.cwd)));
    expect(cwds).toEqual(new Set(['ERP-001-T-01', 'ERP-002-T-01']));
    expect(git(t.p.path, 'show', 'devflow/ERP-001:T-01.txt')).toBe('T-01');
    expect(git(t.p.path, 'show', 'devflow/ERP-002:T-01.txt')).toBe('T-01');
  });

  it('deliverables committed at DONE', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    registerStage('DONE', done, { gate: false });
    t.pipeline.start(r.id);
    await t.worker.drain();
    const ws = Workspace.forRequest(t.cfg, t.repo, r);
    for (const f of ['TKCT_ERP-001_v1.docx', 'TKDB_ERP-001_v1.docx', 'ULNL_ERP-001_v1.xlsx', 'TestCase_ERP-001_v1.xlsx', 'TestCase_ERP-001_v2.xlsx']) writeFileSync(join(ws.artifactsDir, f), f);
    mkdirSync(join(ws.artifactsDir, 'evidence', 'TC-QL-01'), { recursive: true });
    writeFileSync(join(ws.artifactsDir, 'evidence', 'TC-QL-01', 'a.png'), 'png');
    // A planted link must not be followed into the commit.
    symlinkSync('/etc/hostname', join(ws.artifactsDir, 'evidence', 'TC-QL-01', 'leak.txt'));
    t.pipeline.rerunStage(r.id, 'DONE');
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DONE', status: 'awaiting_approval' });
    const files = git(t.p.path, 'ls-tree', '-r', '--name-only', 'devflow/ERP-001', 'docs/devflow/ERP-001/deliverables').split('\n');
    expect(files.sort()).toEqual([
      'docs/devflow/ERP-001/deliverables/TKCT_ERP-001_v1.docx', 'docs/devflow/ERP-001/deliverables/TKDB_ERP-001_v1.docx',
      'docs/devflow/ERP-001/deliverables/TestCase_ERP-001_v2.xlsx', 'docs/devflow/ERP-001/deliverables/ULNL_ERP-001_v1.xlsx',
      'docs/devflow/ERP-001/deliverables/evidence/TC-QL-01/a.png', 'docs/devflow/ERP-001/deliverables/report.md',
    ].sort());
    t.pipeline.approve(r.id, t.pm.id);
    expect(t.repo.getRequest(r.id)!.status).toBe('done');
  });

  it('the dispatcher never runs git in the request worktree while a task merge holds it', async () => {
    const t = await v3Env({ maxConcurrentJobs: 4 });
    const dev2 = await t.addMember('dev2', ['DEV']);
    const r = await atDevelop(t, [task('T-01', [], t.dev.id), task('T-02', [], dev2.id)]);
    const reqWt = Workspace.forRequest(t.cfg, t.repo, r).repoDir;
    let mergeHeld = false;
    let releaseMerge!: () => void;
    const mergeGate = new Promise<void>(res => { releaseMerge = res; });
    let mergeReached!: () => void;
    const reached = new Promise<void>(res => { mergeReached = res; });
    const violations: string[] = [];
    const origMerge = Git.prototype.merge;
    vi.spyOn(Git.prototype, 'merge').mockImplementation(async function (this: Git, branch: string, msg: string) {
      mergeHeld = true;
      mergeReached();
      await mergeGate;
      try { return await origMerge.call(this, branch, msg); } finally { mergeHeld = false; }
    });
    for (const name of ['currentBranch', 'checkout', 'pull', 'commitPaths'] as const) {
      const orig = Git.prototype[name] as (...a: unknown[]) => Promise<unknown>;
      vi.spyOn(Git.prototype, name).mockImplementation(async function (this: Git, ...a: unknown[]) {
        if (mergeHeld && (this as unknown as { cwd: string }).cwd === reqWt) violations.push(name);
        return orig.apply(this, a);
      } as never);
    }
    const ok = devMock();
    t.seats.setBehave(async c => {
      // T-02's developer waits until T-01 is inside its merge, then fails (no summary): its job ends and the
      // dispatcher re-enters while the merge is still held.
      if (roleOf(c.prompt) === 'developer' && /\*\*Task T-02/.test(c.prompt)) { await reached; return { ok: true, resultText: 'ok' }; }
      return ok.behave(c);
    });
    t.pipeline.rerunStage(r.id, 'DEVELOP');
    await until(t.worker, () => t.repo.getTask(r.id, 'T-02')!.status === 'failed');
    // Let the re-entered dispatcher reach the lock while the merge is held.
    for (let i = 0; i < 20; i++) { await t.worker.tick(); await new Promise(res => setTimeout(res, 10)); }
    expect(t.repo.listJobs(r.id).some(j => j.kind === 'run_stage' && (j.payload as { dispatch?: boolean }).dispatch)).toBe(true);
    releaseMerge();
    await t.worker.drain();
    expect(violations).toEqual([]);
    expect(t.repo.getTask(r.id, 'T-01')!.status).toBe('done');
    expect(git(t.p.path, 'show', 'devflow/ERP-001:T-01.txt')).toBe('T-01');
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'failed' });
  });

  it('a leftover dispatcher re-entry never drags a request that moved on back to the DEVELOP gate', async () => {
    const t = await v3Env();
    const r = await t.request('ERP-001');
    t.pipeline.start(r.id);
    await t.worker.drain();
    // The request is past DEVELOP (waiting at the DONE gate) while a dispatch job queued by a task is still due.
    t.repo.updateRequest(r.id, { stage: 'DONE', status: 'awaiting_approval' });
    const job = t.repo.enqueueJob(r.id, 'run_stage', { stage: 'DEVELOP', dispatch: true }, 0, null);
    await t.worker.drain();
    expect(t.repo.getRequest(r.id)).toMatchObject({ stage: 'DONE', status: 'awaiting_approval' });
    expect(t.repo.getJob(job.id)).toMatchObject({ status: 'failed', lastError: 'superseded' });
    expect(t.repo.listStageRuns(r.id).filter(x => x.stage === 'DEVELOP' && x.status !== 'done')).toEqual([]);
  });
});
