import type { RunOpts, RunResult } from '../../src/claude/runner.js';
import { SeatSweepError, type SeatRunner, type SeatState } from '../../src/claude/seat-runner.js';
import { Pipeline, clearStages, registerStage, type StageHandler } from '../../src/engine/pipeline.js';
import { intake } from '../../src/engine/stages/intake.js';
import { Worker } from '../../src/engine/worker.js';
import type { ProjectRole, Stage, UserRow } from '../../src/domain/types.js';
import { fullProject, mkEnv, mkUser } from '../projects/helpers.js';

export interface SeatCall { userId: number | null; cwd: string; prompt: string; opts: RunOpts }

/**
 * A seat runner double (kind 'sudo': seats and permissions on). Every run is recorded; `behave` decides the
 * result per call (default ok). Seat states default to connected.
 */
export function fakeSeats() {
  const calls: SeatCall[] = [];
  const state = new Map<number, SeatState>();
  const statusChecks: number[] = [];
  const sweeps: [number, string][] = [];
  let sweepFail = false;
  let behave: (c: SeatCall) => Promise<RunResult> | RunResult = () => ({ ok: true, resultText: 'ok' });
  const runner: SeatRunner = {
    kind: 'sudo',
    async run(userId, opts) {
      const c = { userId, cwd: opts.cwd, prompt: opts.prompt, opts };
      calls.push(c);
      if (opts.signal?.aborted) return { ok: false, aborted: true, resultText: '', error: 'aborted' };
      const st = userId !== null ? state.get(userId) : undefined;
      if (st === 'expired') return { ok: false, resultText: '', error: 'Claude login expired', seatError: 'expired' };
      if (st === 'disconnected') return { ok: false, resultText: '', error: 'not logged in', seatError: 'disconnected' };
      return behave(c);
    },
    login() { throw new Error('no login in tests'); },
    async status(userId) { statusChecks.push(userId); return { state: state.get(userId) ?? 'connected' }; },
    async logout() { /* nothing */ },
    async sweepProject(projectId, worktree) {
      sweeps.push([projectId, worktree]);
      if (sweepFail) throw new SeatSweepError(`sweep of project ${projectId} failed: symlink`);
    },
  };
  return {
    runner, calls, state, statusChecks, sweeps,
    setBehave(f: typeof behave) { behave = f; },
    failSweeps(v = true) { sweepFail = v; },
  };
}

/** A run that only ends when its AbortSignal fires (or `release()` is called). */
export function blockingRun() {
  const waiters: (() => void)[] = [];
  let started = 0;
  const behave = (c: SeatCall): Promise<RunResult> => new Promise(res => {
    started++;
    const done = (): void => res({ ok: true, resultText: 'ok' });
    waiters.push(done);
    c.opts.signal?.addEventListener('abort', () => res({ ok: false, aborted: true, resultText: '', error: 'aborted' }), { once: true });
  });
  return { behave, started: () => started, release: () => { for (const w of waiters.splice(0)) w(); } };
}

/** Project with all six roles, a fake seat runner and a pipeline/worker on the project's repo. */
export async function v3Env(o: { now?: () => number; seatConcurrency?: number; maxConcurrentJobs?: number } = {}) {
  const e = mkEnv();
  const f = await fullProject(e);
  e.cfg.seatConcurrency = o.seatConcurrency ?? 1;
  e.cfg.maxConcurrentJobs = o.maxConcurrentJobs ?? 4;
  const seats = fakeSeats();
  const pipeline = new Pipeline(e.cfg, e.repo, { seatRunner: seats.runner, ...(o.now ? { now: o.now } : {}) });
  const worker = new Worker(e.cfg, e.repo, pipeline);
  const addMember = async (name: string, roles: ProjectRole[]): Promise<UserRow> => {
    const u = mkUser(e.repo, `${name}@x.com`);
    const cur = e.repo.listProjectMembers(f.p.id).map(m => ({ userId: m.userId, roles: m.roles }));
    await e.svc.setMembers(f.p.id, [...cur, { userId: u.id, roles }], e.pm.id);
    return u;
  };
  const request = (code: string, runMode: 'auto' | 'review' = 'review', assignees?: Partial<Record<ProjectRole, number[]>>) =>
    e.svc.createRequest({ projectId: f.p.id, code, title: code, description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode, by: e.pm.id, ...(assignees ? { assignees } : {}) });
  return { ...e, ...f, seats, pipeline, worker, addMember, request };
}

const GATES: Stage[] = ['CODEBASE_SCAN', 'ANALYSIS', 'BREAKDOWN', 'DESIGN', 'PLANNING', 'DEVELOP'];

/** Real INTAKE (creates the request worktree), every other stage a stub that runs Claude once (or `over`). */
export function registerStubs(over: Partial<Record<Stage, StageHandler>> = {}): void {
  clearStages();
  registerStage('INTAKE', intake, { gate: false });
  const stages: Stage[] = ['CODEBASE_SCAN', 'ANALYSIS', 'CLARIFY', 'BREAKDOWN', 'DESIGN', 'PLANNING', 'DEVELOP', 'TEST', 'BUGFIX', 'DONE', 'CHANGE'];
  for (const s of stages) {
    const noClaude = s === 'CLARIFY' || s === 'DONE';
    registerStage(s, over[s] ?? (async ctx => { if (!noClaude) await ctx.claude(`ROLE: ${s}`); return { kind: 'next' }; }), { gate: GATES.includes(s) });
  }
}

/** Ticks the worker until `pred` holds (jobs run concurrently up to the limits). */
export async function until(worker: Worker, pred: () => boolean, max = 200): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (pred()) return;
    await worker.tick();
    await new Promise(r => setTimeout(r, 5));
  }
  if (!pred()) throw new Error('condition not reached');
}
