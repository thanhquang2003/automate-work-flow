import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import { STAGES, type JobRow, type RequestRow, type RequestStatus, type Stage, type StageRunRow } from '../domain/types.js';
import { runClaude, type RunOpts, type RunResult } from '../claude/runner.js';
import { GitLabClient } from '../gitlab/client.js';
import { Git } from '../gitlab/git.js';
import { bus } from './bus.js';
import { Workspace } from './workspace.js';

export { bus } from './bus.js';
export { Workspace } from './workspace.js';

export interface StageContext {
  cfg: Config;
  repo: Repo;
  req: RequestRow;
  ws: Workspace;
  feedback?: string;
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
const MAX_ATTEMPTS = 2; // one retry after an exception
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

export class Pipeline {
  private controllers = new Map<string, AbortController>();

  constructor(private cfg: Config, private repo: Repo, private deps: PipelineDeps = {}) {}

  now(): number { return (this.deps.now ?? Date.now)(); }

  // ---- public controls ----

  start(reqId: string): void {
    this.mustGet(reqId);
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
    const req = this.expectStatus(reqId, 'awaiting_customer');
    // After the customer answers, ANALYSIS re-evaluates the answers (it may goto BREAKDOWN when clear).
    this.setStatus(reqId, 'ANALYSIS', 'running');
    void req;
    this.enqueue(reqId, 'ANALYSIS');
  }

  cancel(reqId: string): void {
    const req = this.mustGet(reqId);
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
    this.setStatus(reqId, req.stage, 'running');
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'paused') this.repo.pauseJob(j.id, this.now());
  }

  rerunStage(reqId: string, stage: Stage): void {
    this.mustGet(reqId);
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'queued' || j.status === 'paused') this.repo.failJob(j.id, 'superseded by rerun');
    this.setStatus(reqId, stage, 'running');
    this.enqueue(reqId, stage);
  }

  // ---- job execution (called by Worker) ----

  async runJob(job: JobRow): Promise<void> {
    const payload = job.payload as { stage?: Stage; feedback?: string };
    const stage = payload.stage;
    const req0 = job.requestId ? this.repo.getRequest(job.requestId) : undefined;
    if (job.kind !== 'run_stage' || !stage || !req0) { this.repo.failJob(job.id, `Unsupported job ${job.kind}`); return; }
    if (req0.status === 'cancelled') { this.repo.failJob(job.id, 'cancelled'); return; }
    const reqId = req0.id;

    // A stage_run still marked running belongs to a crashed process.
    const prev = this.repo.latestStageRun(reqId, stage);
    if (prev?.status === 'running') this.repo.finishStageRun(prev.id, 'failed', { error: 'interrupted' });

    const userPaused = req0.status === 'paused';
    this.setStatus(reqId, stage, userPaused ? 'paused' : 'running');
    const req = this.mustGet(reqId);
    const run = this.repo.createStageRun(reqId, stage, payload.feedback ?? null);
    const ws = Workspace.for(this.cfg, reqId).ensure();
    const controller = new AbortController();
    this.controllers.set(reqId, controller);
    this.log(reqId, 'info', `Bắt đầu giai đoạn ${stage} (lần ${run.attempt})`);

    let outcome: StageOutcome;
    let thrown: unknown;
    try {
      const reg = registry.get(stage);
      if (reg) outcome = await reg.handler(this.makeContext(req, ws, run, payload.feedback, controller.signal));
      else if (stage === 'INTAKE' || stage === 'DONE') outcome = { kind: 'next' };
      else outcome = { kind: 'fail', error: `Chưa đăng ký xử lý cho giai đoạn ${stage}` };
    } catch (e) {
      if (e instanceof RateLimitError) outcome = { kind: 'retry_later', until: e.until };
      else { thrown = e; outcome = { kind: 'fail', error: '' }; }
    } finally {
      if (this.controllers.get(reqId) === controller) this.controllers.delete(reqId);
    }

    if (this.repo.getRequest(reqId)?.status === 'cancelled') {
      this.repo.finishStageRun(run.id, 'cancelled');
      this.repo.failJob(job.id, 'cancelled');
      return;
    }

    if (thrown !== undefined) {
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      this.repo.finishStageRun(run.id, 'failed', { error: msg });
      this.log(reqId, 'error', `Giai đoạn ${stage} lỗi: ${msg}`);
      if (job.attempts < MAX_ATTEMPTS) {
        this.log(reqId, 'warn', 'Thử lại giai đoạn một lần nữa');
        this.repo.pauseJob(job.id, this.now());
      } else {
        this.repo.failJob(job.id, msg);
        this.setStatus(reqId, stage, 'failed');
      }
      return;
    }

    this.applyOutcome(job, req, run, outcome!, this.repo.getRequest(reqId)?.status === 'paused');
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

  private makeContext(req: RequestRow, ws: Workspace, run: StageRunRow, feedback: string | undefined, signal: AbortSignal): StageContext {
    const reqId = req.id;
    const log = (msg: string, level: 'info' | 'warn' | 'error' = 'info'): void => this.log(reqId, level, msg);
    const gitlab = this.deps.makeGitLab
      ? this.deps.makeGitLab(req)
      : this.cfg.gitlab.url && this.cfg.gitlab.token ? new GitLabClient(this.cfg.gitlab.url, this.cfg.gitlab.token) : undefined;
    const git = this.deps.makeGit ? this.deps.makeGit(req, ws) : new Git(ws.repoDir, { token: this.cfg.gitlab.token || undefined });
    return {
      cfg: this.cfg, repo: this.repo, req, ws, feedback: feedback || undefined, signal, log, gitlab, git,
      claude: async (prompt, extra = {}) => {
        const res = await runClaude(this.cfg, {
          cwd: ws.repoDir,
          addDirs: [ws.root],
          logFile: join(ws.logsDir, `${run.stage}-${run.attempt}.log`),
          signal,
          onEvent: line => log(line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}…` : line),
          prompt,
          ...extra,
        });
        if (res.sessionId) this.repo.setStageRunSession(run.id, res.sessionId);
        if (res.rateLimitedUntil) throw new RateLimitError(res.rateLimitedUntil);
        return res;
      },
    };
  }

  private enqueue(reqId: string, stage: Stage, feedback?: string): void {
    const job = this.repo.enqueueJob(reqId, 'run_stage', feedback ? { stage, feedback } : { stage });
    if (this.repo.getRequest(reqId)?.status === 'paused') this.repo.pauseJob(job.id, FAR_FUTURE);
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
