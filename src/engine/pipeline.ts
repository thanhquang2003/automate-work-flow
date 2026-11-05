import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import { STAGES, type JobRow, type RequestRow, type RequestStatus, type Stage, type StageRunRow } from '../domain/types.js';
import { runClaude, type RunOpts, type RunResult } from '../claude/runner.js';
import { GitLabClient } from '../gitlab/client.js';
import { Git } from '../gitlab/git.js';
import { bus } from './bus.js';
import { readProjectInfo } from './stages/common.js';
import { Workspace } from './workspace.js';

export { bus } from './bus.js';
export { Workspace } from './workspace.js';

export interface StageContext {
  cfg: Config;
  repo: Repo;
  req: RequestRow;
  ws: Workspace;
  feedback?: string;
  /** True when this run follows the customer's answers (resumeAfterCustomer). */
  resume: boolean;
  /** Aborted when the request is cancelled. */
  signal: AbortSignal;
  log(msg: string, level?: 'info' | 'warn' | 'error'): void;
  /** Runs Claude in the repo dir. Throws RateLimitError when rate limited (the pipeline turns that into retry_later). */
  claude(prompt: string, extra?: Partial<RunOpts>): Promise<RunResult>;
  gitlab?: GitLabClient;
  git: Git;
}

export type StageOutcome =
  | { kind: 'next' }
  | { kind: 'goto'; stage: Stage }
  | { kind: 'await_customer' }
  | { kind: 'needs_human'; reason: string }
  | { kind: 'retry_later'; until: Date }
  | { kind: 'fail'; error: string };

export type StageHandler = (ctx: StageContext) => Promise<StageOutcome>;

export class RateLimitError extends Error {
  constructor(public until: Date) {
    super(`Rate limited until ${until.toISOString()}`);
    this.name = 'RateLimitError';
  }
}

export class PipelineBusyError extends Error {
  constructor(reqId: string) {
    super(`Request ${reqId} has a stage running`);
    this.name = 'PipelineBusyError';
  }
}

const registry = new Map<Stage, { handler: StageHandler; gate: boolean }>();
export function registerStage(stage: Stage, handler: StageHandler, opts: { gate: boolean }): void {
  registry.set(stage, { handler, gate: opts.gate });
}
export function clearStages(): void { registry.clear(); }

export interface PipelineDeps {
  makeGitLab?: (req: RequestRow) => GitLabClient | undefined;
  makeGit?: (req: RequestRow, ws: Workspace) => Git;
  now?: () => number;
}

const FAR_FUTURE = 8_640_000_000_000_000; // max JS date; paused-by-user jobs never come due
const MAX_EXCEPTION_RETRIES = 1; // one retry after an exception
const MAX_LOG_LINE = 500;

/**
 * Stage that follows `stage` in normal flow, or undefined when finished.
 * CODEBASE_SCAN is skipped for new projects. BUGFIX is only reachable via goto, and loops back to TEST.
 */
export function nextStage(stage: Stage, req: Pick<RequestRow, 'projectKind'>): Stage | undefined {
  if (stage === 'BUGFIX') return 'TEST';
  let i = STAGES.indexOf(stage) + 1;
  while (i < STAGES.length) {
    const s = STAGES[i++];
    if (s === 'BUGFIX') continue;
    if (s === 'CODEBASE_SCAN' && req.projectKind === 'new') continue;
    return s;
  }
  return undefined;
}

/** Reduce a stream-json line to something worth showing: assistant text, tool names, results. Non-JSON lines pass through. */
export function summarizeEvent(line: string): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let o: any;
  try { o = JSON.parse(line); } catch { return line; }
  if (!o || typeof o !== 'object') return line;
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    const parts: string[] = [];
    for (const c of o.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) parts.push(c.text.trim());
      else if (c?.type === 'tool_use') parts.push(`[tool] ${c.name}`);
    }
    return parts.length ? parts.join(' | ') : undefined;
  }
  if (o.type === 'result') return `[result] ${typeof o.result === 'string' ? o.result : ''}`.trim();
  return undefined;
}

export class Pipeline {
  private controllers = new Map<string, AbortController>();
  private gens = new Map<string, number>();

  constructor(private cfg: Config, private repo: Repo, private deps: PipelineDeps = {}) {}

  now(): number { return (this.deps.now ?? Date.now)(); }

  // ---- public controls ----

  start(reqId: string): void {
    this.mustGet(reqId);
    this.bump(reqId);
    this.setStatus(reqId, 'INTAKE', 'running');
    this.enqueue(reqId, 'INTAKE');
  }

  approve(reqId: string): void {
    const req = this.expectStatus(reqId, 'awaiting_approval');
    const n = nextStage(req.stage, req);
    if (!n) { this.setStatus(reqId, req.stage, 'done'); return; }
    this.setStatus(reqId, n, 'running');
    this.enqueue(reqId, n);
  }

  reject(reqId: string, feedback: string): void {
    const req = this.expectStatus(reqId, 'awaiting_approval');
    this.log(reqId, 'info', `Từ chối giai đoạn ${req.stage}: ${feedback}`);
    this.setStatus(reqId, req.stage, 'running');
    this.enqueue(reqId, req.stage, feedback);
  }

  resumeAfterCustomer(reqId: string): void {
    this.expectStatus(reqId, 'awaiting_customer');
    // CLARIFY reruns with ctx.resume=true and decides where to go next (e.g. goto ANALYSIS).
    this.setStatus(reqId, 'CLARIFY', 'running');
    this.enqueue(reqId, 'CLARIFY', undefined, true);
  }

  cancel(reqId: string): void {
    const req = this.mustGet(reqId);
    this.bump(reqId);
    this.setStatus(reqId, req.stage, 'cancelled');
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'queued' || j.status === 'paused') this.repo.failJob(j.id, 'cancelled');
    this.controllers.get(reqId)?.abort();
    this.log(reqId, 'warn', 'Yêu cầu đã bị hủy');
  }

  pause(reqId: string): void {
    const req = this.mustGet(reqId);
    if (req.status === 'cancelled' || req.status === 'done') return;
    this.setStatus(reqId, req.stage, 'paused');
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'queued' || j.status === 'paused') this.repo.pauseJob(j.id, FAR_FUTURE);
  }

  resume(reqId: string): void {
    const req = this.expectStatus(reqId, 'paused');
    if (this.controllers.has(reqId)) throw new PipelineBusyError(reqId);
    this.setStatus(reqId, req.stage, 'running');
    const now = this.now();
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'paused') this.repo.pauseJob(j.id, j.runAfter >= FAR_FUTURE ? now : Math.max(j.runAfter, now));
  }

  rerunStage(reqId: string, stage: Stage): void {
    this.mustGet(reqId);
    if (this.controllers.has(reqId)) throw new PipelineBusyError(reqId);
    this.bump(reqId);
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'queued' || j.status === 'paused') this.repo.failJob(j.id, 'superseded by rerun');
    this.setStatus(reqId, stage, 'running');
    this.enqueue(reqId, stage);
  }

  // ---- job execution (called by Worker) ----

  async runJob(job: JobRow): Promise<void> {
    const payload = job.payload as { stage?: Stage; feedback?: string; resume?: boolean; gen?: number; errRetries?: number };
    const stage = payload.stage;
    const req0 = job.requestId ? this.repo.getRequest(job.requestId) : undefined;
    if (job.kind !== 'run_stage' || !stage || !req0) { this.repo.failJob(job.id, `Unsupported job ${job.kind}`); return; }
    const reqId = req0.id;
    const stale = (): boolean => payload.gen !== undefined && payload.gen < (this.gens.get(reqId) ?? 0);
    if (req0.status === 'cancelled') { this.repo.failJob(job.id, 'cancelled'); return; }
    if (stale()) { this.repo.failJob(job.id, 'superseded'); return; }

    let run: StageRunRow | undefined;
    const controller = new AbortController();
    this.controllers.set(reqId, controller);
    let outcome: StageOutcome | undefined;
    let thrown: unknown;
    try {
      // A stage_run still marked running belongs to a crashed process.
      const prev = this.repo.latestStageRun(reqId, stage);
      if (prev?.status === 'running') this.repo.finishStageRun(prev.id, 'failed', { error: 'interrupted' });
      // A claimed job always runs; a user pause is detected only after the handler returns.
      this.setStatus(reqId, stage, 'running');
      const req = this.repo.getRequest(reqId)!;
      run = this.repo.createStageRun(reqId, stage, payload.feedback ?? null);
      const ws = Workspace.for(this.cfg, reqId).ensure();
      this.log(reqId, 'info', `Bắt đầu giai đoạn ${stage} (lần ${run.attempt})`);
      const reg = registry.get(stage);
      if (reg) outcome = await reg.handler(this.makeContext(req, ws, run, payload.feedback, !!payload.resume, controller.signal));
      else if (stage === 'INTAKE' || stage === 'DONE') outcome = { kind: 'next' };
      else outcome = { kind: 'fail', error: `Chưa đăng ký xử lý cho giai đoạn ${stage}` };
    } catch (e) {
      if (e instanceof RateLimitError) outcome = { kind: 'retry_later', until: e.until };
      else thrown = e;
    } finally {
      if (this.controllers.get(reqId) === controller) this.controllers.delete(reqId);
    }

    if (this.repo.getRequest(reqId)?.status === 'cancelled' || stale()) {
      if (run) this.repo.finishStageRun(run.id, 'cancelled');
      this.repo.failJob(job.id, stale() ? 'superseded' : 'cancelled');
      return;
    }

    if (thrown !== undefined) {
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      if (run) this.repo.finishStageRun(run.id, 'failed', { error: msg });
      this.log(reqId, 'error', `Giai đoạn ${stage} lỗi: ${msg}`);
      this.repo.tx(() => {
        this.repo.failJob(job.id, msg);
        if ((payload.errRetries ?? 0) < MAX_EXCEPTION_RETRIES) {
          this.log(reqId, 'warn', 'Thử lại giai đoạn một lần nữa');
          const retry = this.repo.enqueueJob(reqId, 'run_stage', { ...payload, errRetries: (payload.errRetries ?? 0) + 1 }, this.now());
          this.parkIfPaused(reqId, retry.id);
        } else this.setStatus(reqId, stage, 'failed');
      });
      return;
    }

    const req = this.repo.getRequest(reqId)!;
    const userPaused = req.status === 'paused';
    this.repo.tx(() => this.applyOutcome(job, req, run!, outcome!, userPaused));
  }

  // ---- internals ----

  private applyOutcome(job: JobRow, req: RequestRow, run: StageRunRow, o: StageOutcome, userPaused: boolean): void {
    const { repo } = this;
    const stage = run.stage;
    switch (o.kind) {
      case 'next': {
        repo.finishStageRun(run.id, 'done');
        repo.finishJob(job.id);
        const n = nextStage(stage, req);
        if (!n) { this.setStatus(req.id, stage, 'done'); this.log(req.id, 'info', 'Hoàn tất yêu cầu'); return; }
        if (registry.get(stage)?.gate && req.runMode === 'review') {
          this.setStatus(req.id, stage, 'awaiting_approval');
          this.log(req.id, 'info', `Chờ duyệt giai đoạn ${stage}`);
          return;
        }
        this.setStatus(req.id, n, userPaused ? 'paused' : 'running');
        this.enqueue(req.id, n);
        return;
      }
      case 'goto':
        repo.finishStageRun(run.id, 'done');
        repo.finishJob(job.id);
        this.setStatus(req.id, o.stage, userPaused ? 'paused' : 'running');
        this.enqueue(req.id, o.stage);
        return;
      case 'await_customer':
        repo.finishStageRun(run.id, 'done');
        repo.finishJob(job.id);
        this.setStatus(req.id, stage, 'awaiting_customer');
        return;
      case 'needs_human':
        repo.finishStageRun(run.id, 'needs_human', { error: o.reason });
        repo.finishJob(job.id);
        this.log(req.id, 'warn', `Cần can thiệp thủ công: ${o.reason}`);
        this.setStatus(req.id, stage, 'needs_human');
        return;
      case 'retry_later':
        repo.finishStageRun(run.id, 'paused');
        repo.pauseJob(job.id, o.until.getTime());
        this.log(req.id, 'warn', `Tạm dừng đến ${o.until.toISOString()}`);
        this.setStatus(req.id, stage, 'paused');
        return;
      case 'fail':
        repo.finishStageRun(run.id, 'failed', { error: o.error });
        repo.failJob(job.id, o.error);
        this.log(req.id, 'error', `Giai đoạn ${stage} thất bại: ${o.error}`);
        this.setStatus(req.id, stage, 'failed');
        return;
    }
  }

  private makeContext(req: RequestRow, ws: Workspace, run: StageRunRow, feedback: string | undefined, resume: boolean, signal: AbortSignal): StageContext {
    const reqId = req.id;
    const log = (msg: string, level: 'info' | 'warn' | 'error' = 'info'): void => this.log(reqId, level, msg);
    const gitlab = this.deps.makeGitLab
      ? this.deps.makeGitLab(req)
      : this.cfg.gitlab.url && this.cfg.gitlab.token ? new GitLabClient(this.cfg.gitlab.url, this.cfg.gitlab.token) : undefined;
    // The project's default branch (from INTAKE's project.json) is never pushed to.
    const protectedBranch = readProjectInfo(ws)?.defaultBranch;
    const git = this.deps.makeGit ? this.deps.makeGit(req, ws) : new Git(ws.repoDir, { token: this.cfg.gitlab.token || undefined, protectedBranch });
    return {
      cfg: this.cfg, repo: this.repo, req, ws, feedback: feedback || undefined, resume, signal, log, gitlab, git,
      claude: async (prompt, extra = {}) => {
        const res = await runClaude(this.cfg, {
          cwd: ws.repoDir,
          addDirs: [ws.root],
          logFile: join(ws.logsDir, `${run.stage}-${run.attempt}.log`),
          signal,
          onEvent: line => { const t = summarizeEvent(line); if (t) log(t.length > MAX_LOG_LINE ? `${t.slice(0, MAX_LOG_LINE)}…` : t); },
          prompt,
          ...extra,
        });
        if (res.sessionId) this.repo.setStageRunSession(run.id, res.sessionId);
        if (res.rateLimitedUntil) throw new RateLimitError(res.rateLimitedUntil);
        return res;
      },
    };
  }

  private bump(reqId: string): void { this.gens.set(reqId, (this.gens.get(reqId) ?? 0) + 1); }

  private enqueue(reqId: string, stage: Stage, feedback?: string, resume = false): void {
    const payload: Record<string, unknown> = { stage, gen: this.gens.get(reqId) ?? 0 };
    if (feedback) payload.feedback = feedback;
    if (resume) payload.resume = true;
    const job = this.repo.enqueueJob(reqId, 'run_stage', payload);
    this.parkIfPaused(reqId, job.id);
  }

  /** A user-paused request never gets new work claimed until resume(). */
  private parkIfPaused(reqId: string, jobId: number): void {
    if (this.repo.getRequest(reqId)?.status === 'paused') this.repo.pauseJob(jobId, FAR_FUTURE);
  }

  private setStatus(reqId: string, stage: Stage, status: RequestStatus): void {
    this.repo.updateRequest(reqId, { stage, status });
    bus.emit('status', { requestId: reqId, stage, status });
  }

  private log(reqId: string, level: string, message: string): void {
    const e = this.repo.addEvent(reqId, level, message);
    bus.emit('event', { requestId: reqId, id: e.id, ts: e.ts, level, message });
  }

  private mustGet(reqId: string): RequestRow {
    const r = this.repo.getRequest(reqId);
    if (!r) throw new Error(`Request not found: ${reqId}`);
    return r;
  }

  private expectStatus(reqId: string, status: RequestStatus): RequestRow {
    const r = this.mustGet(reqId);
    if (r.status !== status) throw new Error(`Request ${reqId} is ${r.status}, expected ${status}`);
    return r;
  }
}
