import { describe, it, expect, beforeEach } from 'vitest';
import { setMockHandler, clearMockHandler } from '../../src/claude/mock.js';
import type { RunOpts } from '../../src/claude/runner.js';
import { Pipeline, PipelineBusyError, summarizeEvent, bus, clearStages, registerStage, type StageHandler } from '../../src/engine/pipeline.js';
import { GitLabClient } from '../../src/gitlab/client.js';
import { Worker } from '../../src/engine/worker.js';
import { STAGES, type Stage } from '../../src/domain/types.js';
import { setup, mkReq } from './helpers.js';

const GATES: Stage[] = ['CODEBASE_SCAN', 'ANALYSIS', 'BREAKDOWN', 'DESIGN', 'PLANNING', 'DEVELOP'];
let calls: { stage: Stage; feedback?: string }[];
const next: StageHandler = async () => ({ kind: 'next' });
function registerAll(over: Partial<Record<Stage, StageHandler>> = {}) {
  for (const s of STAGES) {
    registerStage(s, async ctx => { calls.push({ stage: s, feedback: ctx.feedback }); return (over[s] ?? next)(ctx); }, { gate: GATES.includes(s) });
  }
}
beforeEach(() => { clearStages(); calls = []; });

describe('pipeline', () => {
  it('auto mode runs all stages to DONE', async () => {
    registerAll({ CLARIFY: async () => ({ kind: 'goto', stage: 'BREAKDOWN' }), TEST: async () => ({ kind: 'next' }) });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id);
    await worker.drain();
    expect(calls.map(c => c.stage)).toEqual(['INTAKE', 'CODEBASE_SCAN', 'ANALYSIS', 'CLARIFY', 'BREAKDOWN', 'DESIGN', 'PLANNING', 'DEVELOP', 'TEST', 'DONE']);
    expect(repo.getRequest(r.id)!.status).toBe('done');
    expect(repo.getRequest(r.id)!.stage).toBe('DONE');
  });

  it('review mode stops at gate and approve continues', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    pipeline.start(r.id);
    await worker.drain();
    expect(calls.map(c => c.stage)).toEqual(['INTAKE', 'CODEBASE_SCAN']);
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_approval');
    expect(repo.getRequest(r.id)!.stage).toBe('CODEBASE_SCAN');
    pipeline.approve(r.id);
    await worker.drain();
    expect(calls.at(-1)!.stage).toBe('ANALYSIS');
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_approval');
  });

  it('reject reruns stage with feedback', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    pipeline.start(r.id);
    await worker.drain();
    pipeline.reject(r.id, 'làm lại');
    await worker.drain();
    expect(calls.slice(-1)[0]).toEqual({ stage: 'CODEBASE_SCAN', feedback: 'làm lại' });
    expect(repo.latestStageRun(r.id, 'CODEBASE_SCAN')!.feedback).toBe('làm lại');
    expect(repo.latestStageRun(r.id, 'CODEBASE_SCAN')!.attempt).toBe(2);
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_approval');
  });

  it('await_customer then resumeAfterCustomer continues to ANALYSIS', async () => {
    registerAll({ CLARIFY: async ctx => (ctx.resume ? { kind: 'goto', stage: 'ANALYSIS' } : { kind: 'await_customer' }) });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id);
    await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_customer');
    expect(repo.getRequest(r.id)!.stage).toBe('CLARIFY');
    const n = calls.length;
    pipeline.resumeAfterCustomer(r.id);
    await worker.drain();
    expect(calls[n].stage).toBe('CLARIFY');
    expect(calls[n + 1].stage).toBe('ANALYSIS');
  });

  it('retry_later pauses job', async () => {
    let t = 1_000_000;
    let first = true;
    registerAll({ CODEBASE_SCAN: async () => { if (first) { first = false; return { kind: 'retry_later', until: new Date(t + 60_000) }; } return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup({}, () => t);
    const r = mkReq(repo, { runMode: 'review' });
    pipeline.start(r.id);
    await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('paused');
    const job = repo.listJobs(r.id).find(j => j.status === 'paused')!;
    expect(job.runAfter).toBe(t + 60_000);
    await worker.drain();
    expect(calls.filter(c => c.stage === 'CODEBASE_SCAN')).toHaveLength(1);
    t += 61_000;
    await worker.drain();
    expect(calls.filter(c => c.stage === 'CODEBASE_SCAN')).toHaveLength(2);
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_approval');
  });

  it('recovers running stage after restart', async () => {
    registerAll();
    const { repo, pipeline, cfg } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    pipeline.start(r.id);
    const job = repo.claimNextJob(Date.now())!; // simulate crash mid-run
    repo.createStageRun(r.id, 'INTAKE');
    expect(job.status).toBe('running');
    const w2 = new Worker(cfg, repo, pipeline);
    w2.start(); w2.stop();
    await w2.drain();
    expect(calls.map(c => c.stage)).toEqual(['INTAKE', 'CODEBASE_SCAN']);
    const runs = repo.listStageRuns(r.id).filter(s => s.stage === 'INTAKE');
    expect(runs.map(s => s.status)).toEqual(['failed', 'done']);
  });

  it('new project skips CODEBASE_SCAN', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { projectKind: 'new' });
    pipeline.start(r.id);
    await worker.drain();
    expect(calls.some(c => c.stage === 'CODEBASE_SCAN')).toBe(false);
    expect(calls[1].stage).toBe('ANALYSIS');
  });

  it('exception retries once then fails', async () => {
    registerAll({ INTAKE: async () => { throw new Error('boom'); } });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id);
    await worker.drain();
    expect(calls).toHaveLength(2);
    expect(repo.getRequest(r.id)!.status).toBe('failed');
    expect(repo.listStageRuns(r.id).every(s => s.status === 'failed')).toBe(true);
  });

  it('needs_human and fail outcomes set status', async () => {
    registerAll({ INTAKE: async () => ({ kind: 'needs_human', reason: 'x' }) });
    const a = setup(); const r1 = mkReq(a.repo); a.pipeline.start(r1.id); await a.worker.drain();
    expect(a.repo.getRequest(r1.id)!.status).toBe('needs_human');
    clearStages(); calls = []; registerAll({ INTAKE: async () => ({ kind: 'fail', error: 'bad' }) });
    const b = setup(); const r2 = mkReq(b.repo); b.pipeline.start(r2.id); await b.worker.drain();
    expect(b.repo.getRequest(r2.id)!.status).toBe('failed');
    expect(calls.filter(c => c.stage === 'INTAKE')).toHaveLength(1);
  });

  it('cancel aborts running work and marks cancelled', async () => {
    let started!: () => void;
    const s = new Promise<void>(r => { started = r; });
    registerAll({
      INTAKE: async ctx => {
        started();
        await new Promise<void>(res => { ctx.signal.addEventListener('abort', () => res()); });
        return { kind: 'next' };
      },
    });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id);
    await worker.tick();
    await s;
    pipeline.cancel(r.id);
    await worker.idle();
    expect(repo.getRequest(r.id)!.status).toBe('cancelled');
    expect(repo.listJobs(r.id).every(j => j.status === 'failed')).toBe(true);
    expect(calls.map(c => c.stage)).toEqual(['INTAKE']);
  });

  it('pause and resume', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id);
    pipeline.pause(r.id);
    await worker.drain();
    expect(calls).toHaveLength(0);
    expect(repo.getRequest(r.id)!.status).toBe('paused');
    pipeline.resume(r.id);
    await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('done');
  });

  it('rerunStage enqueues that stage', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    pipeline.start(r.id); await worker.drain();
    pipeline.rerunStage(r.id, 'INTAKE'); await worker.drain();
    expect(calls.map(c => c.stage)).toEqual(['INTAKE', 'CODEBASE_SCAN', 'INTAKE', 'CODEBASE_SCAN']);
  });

  it('emits events and status on bus', async () => {
    const evs: unknown[] = []; const sts: unknown[] = [];
    const a = (e: unknown) => evs.push(e); const b = (e: unknown) => sts.push(e);
    bus.on('event', a); bus.on('status', b);
    registerAll({ INTAKE: async ctx => { ctx.log('hello'); return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    pipeline.start(r.id); await worker.drain();
    bus.off('event', a); bus.off('status', b);
    expect(evs).toContainEqual(expect.objectContaining({ requestId: r.id, message: 'hello', level: 'info' }));
    expect(sts).toContainEqual({ requestId: r.id, stage: 'CODEBASE_SCAN', status: 'awaiting_approval' });
    expect(repo.listEvents(r.id).some(e => e.message === 'hello')).toBe(true);
  });

  it('ctx.claude wraps runner, saves session id, writes log file', async () => {
    let seen: RunOpts | undefined;
    setMockHandler(o => { seen = o; o.onEvent?.('x'.repeat(900)); return { ok: true, sessionId: 'sess-1', resultText: 'hi' }; });
    registerAll({ INTAKE: async ctx => { const res = await ctx.claude('hello'); ctx.log(`got=${res.resultText}`); return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    pipeline.start(r.id); await worker.drain();
    clearMockHandler();
    expect(seen!.cwd).toMatch(/repo$/);
    expect(seen!.addDirs).toHaveLength(1);
    expect(seen!.logFile).toMatch(/INTAKE-1\.log$/);
    expect(repo.latestStageRun(r.id, 'INTAKE')!.claudeSessionId).toBe('sess-1');
    expect(repo.listEvents(r.id).some(e => e.message === 'got=hi')).toBe(true);
    expect(Math.max(...repo.listEvents(r.id).map(e => e.message.length))).toBeLessThanOrEqual(501);
  });

  it('rate limited claude result becomes retry_later (paused)', async () => {
    const until = new Date(Date.now() + 3_600_000);
    setMockHandler(() => ({ ok: false, resultText: '', rateLimitedUntil: until }));
    registerAll({ INTAKE: async ctx => { await ctx.claude('hello'); return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id); await worker.drain();
    clearMockHandler();
    expect(repo.getRequest(r.id)!.status).toBe('paused');
    expect(repo.listJobs(r.id)[0]).toMatchObject({ status: 'paused', runAfter: until.getTime() });
  });
  it('rate-limit pause in auto mode continues to DONE without manual resume', async () => {
    let t = 1_000_000; let first = true;
    registerAll({ INTAKE: async () => { if (first) { first = false; return { kind: 'retry_later', until: new Date(t + 60_000) }; } return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup({}, () => t);
    const r = mkReq(repo);
    pipeline.start(r.id); await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('paused');
    t += 61_000;
    await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('done');
  });

  it('rerunStage and resume throw PipelineBusyError while a stage runs; stale outcome ignored', async () => {
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const s = new Promise<void>(r => { started = r; });
    registerAll({ INTAKE: async () => { started(); await gate; return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id); await worker.tick(); await s;
    expect(() => pipeline.rerunStage(r.id, 'ANALYSIS')).toThrow(PipelineBusyError);
    pipeline.pause(r.id);
    expect(() => pipeline.resume(r.id)).toThrow(PipelineBusyError);
    release(); await worker.idle();
    expect(repo.getRequest(r.id)!.status).toBe('paused');
    expect(repo.listJobs(r.id).filter(j => j.status === 'paused')).toHaveLength(1);
  });

  it('errors before the handler (workspace/makeGit) fail the request and finish stage_run', async () => {
    registerAll();
    const { cfg, repo } = setup();
    const { Pipeline } = await import('../../src/engine/pipeline.js');
    const pipeline = new Pipeline(cfg, repo, { makeGit: () => { throw new Error('git broke'); } });
    const worker = new Worker(cfg, repo, pipeline);
    const r = mkReq(repo);
    pipeline.start(r.id); await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('failed');
    expect(repo.listStageRuns(r.id).every(x => x.status === 'failed' && x.error === 'git broke')).toBe(true);
    expect(repo.listStageRuns(r.id)).toHaveLength(2);
  });

  it('resume keeps a later runAfter for non-parked jobs', async () => {
    registerAll();
    const t = 1_000_000;
    const { repo, pipeline } = setup({}, () => t);
    const r = mkReq(repo);
    const j = repo.enqueueJob(r.id, 'run_stage', { stage: 'INTAKE' });
    repo.pauseJob(j.id, t + 5_000);
    repo.updateRequest(r.id, { status: 'paused' });
    pipeline.resume(r.id);
    expect(repo.getJob(j.id)!.runAfter).toBe(t + 5_000);
  });

  it('summarizeEvent keeps assistant text/tool/result and drops noise', () => {
    expect(summarizeEvent(JSON.stringify({ type: 'system', subtype: 'init' }))).toBeUndefined();
    expect(summarizeEvent(JSON.stringify({ type: 'user', message: {} }))).toBeUndefined();
    expect(summarizeEvent(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read' }] } }))).toBe('hi | [tool] Read');
    expect(summarizeEvent(JSON.stringify({ type: 'result', result: 'done' }))).toBe('[result] done');
  });

  it('pause during a throwing handler parks the retry job until resume', async () => {
    let started!: () => void; let release!: () => void; let n = 0;
    const s1 = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { release = r; });
    registerAll({ INTAKE: async () => { if (n++ === 0) { started(); await gate; throw new Error('boom'); } return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    pipeline.start(r.id); await worker.tick(); await s1;
    pipeline.pause(r.id);
    release(); await worker.idle();
    await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('paused');
    expect(n).toBe(1);
    expect(repo.listJobs(r.id).filter(j => j.status === 'paused')).toHaveLength(1);
    pipeline.resume(r.id);
    await worker.drain();
    expect(n).toBe(2);
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_approval');
  });
});

describe('pipeline context', () => {
  it('Git uses the same token as the request GitLab client; Claude runs get STAGE_TIMEOUT_MIN as timeout', async () => {
    const seen: { gitToken?: string; timeoutMs?: number; extraTimeout?: number }[] = [];
    registerAll({
      INTAKE: async ctx => {
        const r1 = await ctx.claude('p1');
        const r2 = await ctx.claude('p2', { timeoutMs: 5 });
        void r1; void r2;
        seen.push({ gitToken: (ctx.git as unknown as { opts: { token?: string } }).opts.token });
        return { kind: 'needs_human', reason: 'stop' };
      },
    });
    const timeouts: (number | undefined)[] = [];
    setMockHandler((o: RunOpts) => { timeouts.push(o.timeoutMs); return { ok: true, resultText: 'ok' }; });
    try {
      const base = setup({ stageTimeoutMin: 7, gitlab: { url: 'http://gl', token: 'shared-tok', defaultGroup: '' } });
      const pipeline = new Pipeline(base.cfg, base.repo, { makeGitLab: () => new GitLabClient('http://gl', 'creator-tok') });
      const worker = new Worker(base.cfg, base.repo, pipeline);
      const r = mkReq(base.repo);
      pipeline.start(r.id);
      await worker.drain();
      expect(seen[0]!.gitToken).toBe('creator-tok');
      expect(timeouts).toEqual([7 * 60_000, 5]); // per-call override still wins

      // No GitLab client → shared token; STAGE_TIMEOUT_MIN=0 → no timeout.
      seen.length = 0; timeouts.length = 0;
      const b = setup({ stageTimeoutMin: 0, gitlab: { url: '', token: 'shared-tok', defaultGroup: '' } });
      const p2 = new Pipeline(b.cfg, b.repo, { makeGitLab: () => undefined });
      const w2 = new Worker(b.cfg, b.repo, p2);
      const r2 = mkReq(b.repo);
      p2.start(r2.id);
      await w2.drain();
      expect(seen[0]!.gitToken).toBe('shared-tok');
      expect(timeouts).toEqual([undefined, 5]);
    } finally { clearMockHandler(); }
  });
});
