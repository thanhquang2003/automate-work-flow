import { dirname, join, resolve } from 'node:path';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import {
  PROJECT_ROLES, STAGES, type ChangeRequestRow, type CrKind, type CrSource, type ImpactOutT, type JobRow, type ProjectRole, type RequestRow,
  type RequestStatus, type Stage, type StageRunRow, type UserRow,
} from '../domain/types.js';
import type { RunOpts, RunResult } from '../claude/runner.js';
import { LocalSeatRunner, SeatSweepError, type SeatRunner } from '../claude/seat-runner.js';
import { GitLabClient } from '../gitlab/client.js';
import { Git } from '../gitlab/git.js';
import { PermissionError } from '../projects/service.js';
import { GATE_APPROVER, can, type Action, type Actor } from '../security/permissions.js';
import { bus } from './bus.js';
import { CrNotAllowedError, applyAcceptedChange, computeReentry, loadImpact, restorePrevious } from './changes.js';
import {
  RunAbortedError, SeatLimiter, SeatUnavailableError, isPlanningPart, resolveSeat, runnerOf, seatRoleFor, type PlanningPart, type SeatExclusion,
} from './seats.js';
import { answeredQuestions, readProjectInfo } from './stages/common.js';
import { Workspace } from './workspace.js';

export { bus } from './bus.js';
export { Workspace } from './workspace.js';
export { PermissionError } from '../projects/service.js';
export { RunAbortedError, SeatUnavailableError, type PlanningPart } from './seats.js';

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
  /**
   * Runs Claude in the repo dir on the job's seat (`seatUserId`). Throws RateLimitError when rate limited (the
   * pipeline turns that into retry_later), SeatUnavailableError when the seat cannot run (→ awaiting_seat) and
   * RunAbortedError when the run was stopped through `signal`.
   */
  claude(prompt: string, extra?: Partial<RunOpts>): Promise<RunResult>;
  /** Same as `claude` on another seat (review seat, PLANNING test cases); `role` names the seat's role. */
  claudeAs(userId: number | null, prompt: string, extra?: Partial<RunOpts>, role?: ProjectRole): Promise<RunResult>;
  /** Current runner of a role on this request (null in local mode or when nobody can run it). */
  seatFor(role: ProjectRole): number | null;
  /** Seat of this job (null in local mode). */
  seatUserId: number | null;
  /** Commit identity of the responsible user (undefined in local mode: git's own identity). */
  actor?: { name: string; email: string };
  /** PLANNING: the part to (re)run; undefined = both. */
  part?: PlanningPart;
  /** DEVELOP task job: the task (or `feedback-N` work item) this job works on, in its own worktree. */
  taskId?: string;
  /** Task jobs: git of the request worktree (integration branch devflow/<code>), for the serialized merge. */
  requestGit?: Git;
  /** Runs `fn` exclusively per key in this process (merges into devflow/<code> are serialized per request). */
  serialize<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Enqueues a task job of this request (DEVELOP dispatcher). */
  enqueueTask(taskId: string, extra?: { feedback?: string }): void;
  /** DEVELOP dispatcher re-entered after a task job (failed/needs-human tasks are not reset then). */
  reentry?: boolean;
  /** Task ids with a queued, parked or running task job. */
  liveTasks(): Set<string>;
  /** Git for another directory (a task worktree) with the same identity and push rules as `git`. */
  makeGit(dir: string): Git;
  gitlab?: GitLabClient;
  git: Git;
  /** Accepted CRs not yet applied (DONE marks them applied), with their CHANGE impact reports. */
  changes: { cr: ChangeRequestRow; impact: ImpactOutT }[];
  /** Current baseline (requests.baseline_version). */
  baseline: number;
}

/** Input of submitChange / proposeChange. */
export interface ChangeInput {
  title: string;
  description: string;
  kind: CrKind;
  createdBy?: number | null;
  source?: CrSource;
}

export type StageOutcome =
  | { kind: 'next' }
  | { kind: 'goto'; stage: Stage }
  | { kind: 'await_customer' }
  | { kind: 'needs_human'; reason: string }
  | { kind: 'retry_later'; until: Date }
  | { kind: 'fail'; error: string }
  /** DEVELOP dispatcher: task jobs are running; the stage stays running and a finished task re-enqueues DEVELOP. */
  | { kind: 'wait' };

export type StageHandler = (ctx: StageContext) => Promise<StageOutcome>;

export class RateLimitError extends Error {
  constructor(public until: Date, public seatUserId: number | null = null) {
    super(`Rate limited until ${until.toISOString()}`);
    this.name = 'RateLimitError';
  }
}

/** The page that sent an approve/reject/decide/runner click showed an older state than the request has now. */
export class StaleActionError extends Error {
  constructor(message = 'Trang đã cũ: trạng thái yêu cầu đã thay đổi. Hãy tải lại trang rồi thao tác lại.') { super(message); this.name = 'StaleActionError'; }
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
  /** Where Claude runs (default: LocalSeatRunner, v2 behaviour). A non-local runner turns on seats and permissions. */
  seatRunner?: SeatRunner;
  /** Project membership writer used by removeMember (ProjectService). */
  members?: { setMembers(projectId: number, members: { userId: number; roles: ProjectRole[] }[], byId: number): Promise<void> };
  /** Re-check interval of a job waiting for a seat (default 10 min). */
  seatRecheckMs?: number;
  /** Tests only: allow the LocalSeatRunner with DEVFLOW_MODE=server (otherwise the constructor throws). */
  allowLocalSeatsInServerMode?: boolean;
}

/** Payload of run_stage / run_task jobs. */
export interface JobPayload {
  stage?: Stage;
  feedback?: string;
  resume?: boolean;
  gen?: number;
  errRetries?: number;
  part?: PlanningPart;
  /** run_task: task id, or `feedback-N` for a DEVELOP gate-feedback work item. */
  taskId?: string;
  /** Parked waiting for this seat (null: nobody assigned to the role). */
  awaitSeat?: number | null;
  /** Role of the seat waited for (may differ from the job's role, e.g. the reviewer). */
  awaitRole?: ProjectRole;
  /** DEVELOP dispatcher re-entry after a task job (no reset of failed tasks). */
  dispatch?: boolean;
}

/** One job being executed by this process. */
interface LiveJob {
  reqId: string;
  projectId: number | null;
  kind: 'stage' | 'dispatch' | 'task';
  payload: JobPayload;
  controller: AbortController;
  /** Seat of the job and the role it was resolved for. */
  seat: number | null;
  role?: ProjectRole;
  /** Seat of the Claude run in progress (may be another role, e.g. the reviewer). */
  call?: { userId: number | null; role?: ProjectRole };
  done: Promise<void>;
}

/** Abort reasons that are not a cancel/change request. */
const RESEAT = Symbol('reseat');
const PROJECT_STOP = Symbol('project-stop');

const SEAT_RECHECK_MS = 10 * 60_000;
const WORKTREE_RE = /[\\/]\.devflow[\\/]worktrees[\\/][^\\/]+$/;

/** The credential a GitLab client was built with ('' for test doubles without one). */
export function gitlabToken(gl: GitLabClient | undefined): string {
  const t = (gl as { token?: unknown } | undefined)?.token;
  return typeof t === 'string' ? t : '';
}

const FAR_FUTURE = 8_640_000_000_000_000; // max JS date; paused-by-user jobs never come due
const MAX_EXCEPTION_RETRIES = 1; // one retry after an exception
const MAX_LOG_LINE = 500;
const BUSY_RETRY_MS = 1000; // a job whose request still has a handler unwinding (after an interrupt) is retried later
const AUTO_ACCEPT_NOTE = 'Tự động chấp nhận';
/** CR statuses of the batch in progress (accepted/rejected CRs also belong to it while baselineFrom is null). */
const OPEN_CR = new Set(['pending', 'analyzing', 'awaiting_decision']);
const MAX_CHANGE_RERUNS = 2; // consecutive CHANGE re-runs for CRs arriving during analysis

/**
 * Stage that follows `stage` in normal flow, or undefined when finished.
 * CODEBASE_SCAN is skipped for new projects. BUGFIX and CHANGE are only reachable via goto/submitChange; BUGFIX loops back to TEST.
 */
export function nextStage(stage: Stage, req: Pick<RequestRow, 'projectKind'>): Stage | undefined {
  if (stage === 'BUGFIX') return 'TEST';
  let i = STAGES.indexOf(stage) + 1;
  while (i < STAGES.length) {
    const s = STAGES[i++];
    if (s === 'BUGFIX' || s === 'CHANGE') continue;
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
  private gens = new Map<string, number>();
  /** Pending CR ids when the current CHANGE run started (a CR still pending afterwards that was in here was skipped). */
  private changeSnapshot = new Map<string, Set<string>>();
  /** Consecutive CHANGE re-runs caused by CRs arriving during analysis. */
  private changeReruns = new Map<string, number>();
  /** First time a job was deferred because an interrupted handler of its request was still unwinding. */
  private busySince = new Map<number, number>();
  /** Jobs executing in this process, by job id. */
  private live = new Map<number, LiveJob>();
  /** Per-seat rate-limit pause (only that seat's jobs wait). */
  private seatPausedUntil = new Map<number, number>();
  /** Members being removed / losing roles: excluded from seat resolution until the DB says so. */
  private exclusions: { projectId: number; userId: number; roles: Set<ProjectRole> }[] = [];
  /** Projects whose git dirs failed dfctl's sweep: every job stops until an admin clears it. */
  private blockedProjects = new Map<number, string>();
  private locks = new Map<string, Promise<unknown>>();
  readonly seatRunner: SeatRunner;
  private limiter: SeatLimiter;

  constructor(private cfg: Config, private repo: Repo, private deps: PipelineDeps = {}) {
    this.seatRunner = deps.seatRunner ?? new LocalSeatRunner(cfg);
    // Never fall back silently to the service account's Claude in server mode.
    if (cfg.mode === 'server' && this.seatRunner.kind === 'local' && !deps.allowLocalSeatsInServerMode) {
      throw new Error('Server mode needs the seat runner (createSeatRunner): Claude must run on each person\'s seat, not as the DevFlow service account');
    }
    this.limiter = new SeatLimiter(() => this.cfg.seatConcurrency ?? 1);
  }

  now(): number { return (this.deps.now ?? Date.now)(); }

  /** Late-bound membership writer (ProjectService) so removeMember also changes the OS group. */
  attachMembers(members: NonNullable<PipelineDeps['members']>): void { this.deps.members = members; }

  /**
   * Identifies the gate a request waits at: stage plus the number of its latest run. A page embeds it in its
   * approve/reject/decide forms; once the request moved on (rejected and re-run, CR, another approver acted) the
   * token no longer matches and the click is refused.
   */
  gateToken(req: Pick<RequestRow, 'id' | 'stage'>): string {
    return `${req.stage}:${this.repo.latestStageRun(req.id, req.stage)?.id ?? 0}`;
  }

  private checkToken(req: RequestRow, expect: string | undefined): void {
    if (expect !== undefined && expect !== this.gateToken(req)) throw new StaleActionError();
  }

  /**
   * Seats and engine-side permission checks apply. Tied to the seat runner, not to DEVFLOW_MODE: index.ts gives
   * server mode the sudo runner (createSeatRunner); local mode (and tests that only need server-mode web
   * behaviour) keep v2 behaviour with the LocalSeatRunner.
   */
  get multiUser(): boolean { return this.seatRunner.kind !== 'local'; }

  // ---- public controls ----

  start(reqId: string): void {
    this.mustGet(reqId);
    this.bump(reqId);
    this.setStatus(reqId, 'INTAKE', 'running');
    this.enqueue(reqId, 'INTAKE');
  }

  /**
   * Approves the gate the request waits at. In multi-user mode `by` must be allowed by can(gate.approve): PM for
   * any gate, else an assignee of the gate's role on this request (one approval suffices). PLANNING, CHANGE and
   * DONE are PM only; INTAKE/TEST/BUGFIX have no gate. DONE (v3 review mode) finishes the request.
   */
  approve(reqId: string, by?: number | null, part?: string, expect?: string): void {
    const req = this.expectStatus(reqId, 'awaiting_approval');
    this.checkToken(req, expect);
    if (part !== undefined && !(req.stage === 'PLANNING' && isPlanningPart(part))) throw new Error(`Phần không hợp lệ: ${part}`);
    if (req.stage === 'CHANGE') throw new Error('Giai đoạn CHANGE được duyệt theo từng yêu cầu thay đổi (decideChange), không dùng Duyệt chung');
    this.requireGate(req, by, part);
    this.repo.tx(() => {
      if (by != null) {
        this.repo.addApproval({ requestId: reqId, stage: req.stage, part, userId: by, decision: 'approve' });
        this.audit(req, by, 'gate.approve', { stage: req.stage, part });
        this.log(reqId, 'info', `${this.userName(by)} duyệt giai đoạn ${req.stage}`);
      }
      if (req.stage === 'DONE') { this.finishRequest(req.id, 'DONE'); return; }
      const n = nextStage(req.stage, req);
      if (!n) { this.setStatus(reqId, req.stage, 'done'); return; }
      this.setStatus(reqId, n, 'running');
      this.enqueue(reqId, n);
    });
  }

  /**
   * Returns the step: the stage reruns with the feedback. One rejection by any allowed approver suffices.
   * PLANNING: `part` ('tasks' | 'testcases') reruns only that part (PM chooses; none = both).
   */
  reject(reqId: string, feedback: string, by?: number | null, part?: string, expect?: string): void {
    const req = this.expectStatus(reqId, 'awaiting_approval');
    this.checkToken(req, expect);
    if (req.stage === 'CHANGE') throw new Error('Giai đoạn CHANGE được duyệt theo từng yêu cầu thay đổi (decideChange), không dùng Từ chối chung');
    if (req.stage === 'DONE') throw new Error('Không thể từ chối bước chốt DONE: hãy gửi yêu cầu thay đổi (CR) hoặc chạy lại giai đoạn cần làm lại');
    if (part !== undefined && !(req.stage === 'PLANNING' && isPlanningPart(part))) throw new Error(`Phần không hợp lệ: ${part}`);
    this.requireGate(req, by, part);
    this.repo.tx(() => {
      if (by != null) {
        this.repo.addApproval({ requestId: reqId, stage: req.stage, part, userId: by, decision: 'reject' });
        this.audit(req, by, 'gate.reject', { stage: req.stage, part, feedback });
      }
      this.log(reqId, 'info', `Từ chối giai đoạn ${req.stage}${part ? ` (phần ${part})` : ''}: ${feedback}`);
      this.setStatus(reqId, req.stage, 'running');
      this.enqueue(reqId, req.stage, feedback, false, isPlanningPart(part) ? { part } : {});
    });
  }

  /**
   * `by`: undefined = trusted internal call (the customer's survey answered); a number or null is a person:
   * multi-user mode then needs can(clarify.write) (PM or BA assignee of the request). Audited after success.
   */
  resumeAfterCustomer(reqId: string, by?: number | null): void {
    const req = this.expectStatus(reqId, 'awaiting_customer');
    if (by !== undefined) this.requireRequestRight(req, by, 'clarify.write', 'tiếp tục yêu cầu đang chờ khách hàng');
    // CLARIFY reruns with ctx.resume=true and decides where to go next (e.g. goto ANALYSIS).
    this.repo.tx(() => {
      this.setStatus(reqId, 'CLARIFY', 'running');
      this.enqueue(reqId, 'CLARIFY', undefined, true);
      if (by != null) this.audit(req, by, 'request.continue', {});
    });
  }

  /** Staff answers to the CLARIFY questions (form or Excel import): PM or BA assignee. One audit row per call. */
  saveAnswers(reqId: string, answers: { qid: string; answer: string }[], source: 'staff' | 'excel', by?: number | null): number {
    const req = this.mustGet(reqId);
    if (by !== undefined) this.requireRequestRight(req, by, 'clarify.write', 'trả lời câu hỏi làm rõ');
    const latest = this.repo.latestAnswers(reqId);
    let saved = 0;
    this.repo.tx(() => {
      for (const a of answers) {
        if (latest.get(a.qid) === a.answer) continue;
        this.repo.saveAnswer(reqId, a.qid, a.answer, source);
        saved++;
      }
      if (by != null) this.audit(req, by, source === 'excel' ? 'answers.import' : 'answer.save', { count: saved, qids: answers.map(a => a.qid).slice(0, 50) });
    });
    return saved;
  }

  cancel(reqId: string): void {
    const req = this.mustGet(reqId);
    this.bump(reqId);
    this.setStatus(reqId, req.stage, 'cancelled');
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'queued' || j.status === 'paused') this.repo.failJob(j.id, 'cancelled');
    this.abortRequest(reqId);
    for (const c of this.repo.listChangeRequests(reqId)) {
      if (['proposed', 'pending', 'analyzing', 'awaiting_decision'].includes(c.status)) {
        this.repo.updateChangeRequest(reqId, c.id, { status: 'rejected', decisionNote: 'Hủy yêu cầu', decidedAt: this.now() });
      }
    }
    this.log(reqId, 'warn', 'Yêu cầu đã bị hủy');
  }

  pause(reqId: string): void {
    const req = this.mustGet(reqId);
    // Only work in progress can be paused; waiting states (awaiting_*, needs_human, failed, done) are left as they are.
    if (req.status !== 'running' && req.status !== 'paused') return;
    this.setStatus(reqId, req.stage, 'paused');
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'queued' || j.status === 'paused') this.repo.pauseJob(j.id, FAR_FUTURE);
  }

  resume(reqId: string): void {
    const req = this.expectStatus(reqId, 'paused');
    if (this.busy(reqId)) throw new PipelineBusyError(reqId);
    this.setStatus(reqId, req.stage, 'running');
    const now = this.now();
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'paused') this.repo.pauseJob(j.id, j.runAfter >= FAR_FUTURE ? now : Math.max(j.runAfter, now));
  }

  rerunStage(reqId: string, stage: Stage): void {
    this.mustGet(reqId);
    if (this.busy(reqId)) throw new PipelineBusyError(reqId);
    this.bump(reqId);
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'queued' || j.status === 'paused') this.repo.failJob(j.id, 'superseded by rerun');
    this.setStatus(reqId, stage, 'running');
    this.enqueue(reqId, stage);
  }

  // ---- seats (spec v3 §5.2, delta §5b.3/§5b.9) ----

  /**
   * The user's seat is connected again: jobs parked for it run now (the request leaves awaiting_seat).
   * Called by the seat page after a successful login. Returns the number of jobs woken.
   */
  seatReconnected(userId: number): number {
    const now = this.now();
    let n = 0;
    for (const j of this.repo.listJobs()) {
      const p = j.payload as JobPayload;
      if (j.status !== 'paused' || p.awaitSeat !== userId || !j.requestId) continue;
      this.repo.pauseJob(j.id, now);
      n++;
      const req = this.repo.getRequest(j.requestId);
      if (req?.status === 'awaiting_seat') this.setStatus(req.id, req.stage, 'running');
    }
    return n;
  }

  /**
   * PM moves `userId` to the head of `role` on a request (the runner). A job of that role running on another
   * seat is stopped (not a failure, no retry counted) and the same stage re-runs on the new seat; queued and
   * seat-waiting jobs switch seats. Resolves once a stopped run has ended.
   */
  async setRunner(reqId: string, role: ProjectRole, userId: number, by?: number | null, expectRunner?: number | null): Promise<void> {
    const req = this.mustGet(reqId);
    // Stale click: the page was drawn when somebody else (or nobody) was the runner.
    if (expectRunner !== undefined && (this.repo.listRequestAssignees(reqId, role)[0]?.userId ?? null) !== expectRunner) throw new StaleActionError();
    if (!PROJECT_ROLES.includes(role)) throw new Error(`Vai trò không hợp lệ: ${String(role)}`);
    if (this.multiUser) {
      this.require(req, by, 'task.assign', 'đổi người phụ trách');
      if (req.projectId == null || !this.repo.getProjectMember(req.projectId, userId)?.roles.includes(role)) {
        throw new PermissionError(`Người dùng #${userId} không giữ vai ${role} trong dự án.`);
      }
    }
    const cur = this.repo.listRequestAssignees(reqId, role).map(a => a.userId);
    this.repo.tx(() => {
      this.repo.setRequestAssignees(reqId, role, [userId, ...cur.filter(u => u !== userId)]);
      this.audit(req, by ?? null, 'request.runner.set', { role, userId, before: cur });
      this.log(reqId, 'info', `Người chạy vai ${role}: ${this.userName(userId)}`);
    });
    await Promise.allSettled(await this.reseatRequest(reqId));
  }

  /** PM or the DEV runner of the request gives a task to a DEV of the project (null = back to the DEV runner). */
  async assignTask(reqId: string, taskId: string, userId: number | null, by?: number | null): Promise<void> {
    const req = this.mustGet(reqId);
    if (!this.repo.getTask(reqId, taskId)) throw new Error(`Không tìm thấy task ${taskId}`);
    if (this.multiUser) {
      const actor = this.actorFor(req, by);
      const devRunner = runnerOf(this.repo, req, 'DEV');
      if (!actor || !(can(actor, 'task.assign') || (devRunner !== null && devRunner === actor.userId))) {
        throw new PermissionError('Chỉ PM hoặc Dev đứng đầu danh sách của yêu cầu được giao task.');
      }
      if (userId !== null && (req.projectId == null || !this.repo.getProjectMember(req.projectId, userId)?.roles.includes('DEV'))) {
        throw new PermissionError(`Người dùng #${userId} không phải Dev của dự án.`);
      }
    }
    this.repo.tx(() => {
      this.repo.setTaskAssignee(reqId, taskId, userId);
      this.audit(req, by ?? null, 'task.assign', { taskId, userId });
      this.log(reqId, 'info', `Giao task ${taskId} cho ${userId === null ? 'Dev phụ trách' : this.userName(userId)}`);
    });
    await Promise.allSettled(await this.reseatRequest(reqId));
  }

  /**
   * PM removes a member: their running jobs in the project are stopped and re-run on the next person of the same
   * role (awaited), and only then the membership (and the OS group, via `deps.members`) changes.
   */
  async removeMember(projectId: number, userId: number, by?: number | null): Promise<void> {
    const project = this.repo.getProject(projectId);
    if (!project) throw new Error(`Không tìm thấy dự án #${projectId}`);
    if (this.multiUser) {
      const u = by != null ? this.repo.web.getUser(by) : undefined;
      const actor: Actor | undefined = u && !u.disabled
        ? { userId: u.id, sysRole: u.sysRole, departmentId: u.departmentId, canBePm: u.canBePm, projectRoles: this.repo.getProjectMember(projectId, u.id)?.roles ?? [] }
        : undefined;
      if (!actor || !can(actor, 'project.members.edit', { project: { departmentId: project.departmentId }, memberDepartmentIds: [] })) {
        throw new PermissionError('Chỉ PM của dự án được gỡ thành viên.');
      }
    }
    const members = this.repo.listProjectMembers(projectId);
    if (!members.some(m => m.userId === userId)) return;
    const rest = members.filter(m => m.userId !== userId).map(m => ({ userId: m.userId, roles: m.roles }));
    if (this.deps.members) {
      // ProjectService.setMembers calls beforeMembersRemoved (below) before touching the DB and the group.
      await this.deps.members.setMembers(projectId, rest, by ?? userId);
      return;
    }
    await this.beforeMembersRemoved(projectId, [{ userId, roles: [...PROJECT_ROLES] }]);
    try {
      this.repo.tx(() => {
        this.repo.removeProjectMember(projectId, userId);
        this.repo.removeRequestAssigneeEverywhere(userId, projectId);
        this.repo.web.addAudit({ projectId, userId: by ?? null, action: 'project.member.remove', detail: JSON.stringify({ userId }) });
      });
    } finally {
      this.afterMembersChanged(projectId);
    }
  }

  /**
   * Hook for ProjectService.setMembers, called before the DB and the OS group change: the leaving users (or lost
   * roles) are excluded from seat resolution and their jobs in the project are stopped and moved to the next
   * person of the role; resolves once every stopped run has ended.
   */
  async beforeMembersRemoved(projectId: number, changes: { userId: number; roles: ProjectRole[] }[]): Promise<void> {
    for (const c of changes) if (c.roles.length) this.exclusions.push({ projectId, userId: c.userId, roles: new Set(c.roles) });
    const reqs = this.repo.listRequestsByProject(projectId).map(r => r.id);
    const stopped = (await Promise.all(reqs.map(id => this.reseatRequest(id)))).flat();
    await Promise.allSettled(stopped);
  }

  /** Hook for ProjectService.setAssignees: running/queued jobs follow the new order of assignees. */
  async assigneesChanged(reqId: string): Promise<void> {
    await Promise.allSettled(this.reseatRequest(reqId));
  }

  /** Hook for ProjectService.setMembers after the DB commit (or a failure): exclusions of that project are dropped. */
  afterMembersChanged(projectId: number): void {
    this.exclusions = this.exclusions.filter(e => e.projectId !== projectId);
  }

  /** Admin cleared a project after a failed dfctl sweep: its jobs may run again. */
  clearProjectBlock(projectId: number): void {
    this.blockedProjects.delete(projectId);
  }

  /** Reason a project is stopped after a failed sweep, if it is. */
  isProjectBlocked(projectId: number): string | undefined { return this.blockedProjects.get(projectId); }

  /** True when a job may start now (worker: per-seat concurrency and per-seat rate limit). */
  canStart(job: JobRow): boolean {
    if (!this.multiUser || job.seatUserId == null) return true;
    if (this.seatPausedTill(job.seatUserId) !== undefined) return false;
    let n = 0;
    for (const l of this.live.values()) if (l.seat === job.seatUserId) n++;
    return n < Math.max(1, this.cfg.seatConcurrency ?? 1);
  }

  /** Seat paused by a rate limit until this time (ms), if any. */
  seatPausedTill(userId: number): number | undefined {
    const t = this.seatPausedUntil.get(userId);
    return t !== undefined && t > this.now() ? t : undefined;
  }

  // ---- change requests (spec §4.1, §4.3) ----

  /**
   * Records a CR `pending` and interrupts whatever the request is doing: the running stage is aborted (its outcome is
   * dropped as stale), queued/paused jobs are failed and CHANGE runs. While CHANGE is already running the CR only waits
   * (CHANGE runs again before the decision gate); at the decision gate CHANGE re-runs so it is analysed first.
   */
  submitChange(reqId: string, input: ChangeInput, by?: number | null): ChangeRequestRow {
    const req = this.mustGet(reqId);
    if (by !== undefined) this.requireRequestRight(req, by, 'cr.create', 'tạo yêu cầu thay đổi (chỉ PM hoặc BA)');
    if (req.status === 'cancelled') throw new CrNotAllowedError(reqId);
    return this.repo.tx(() => {
      const cr = this.repo.createChangeRequest(reqId, {
        title: input.title, description: input.description, kind: input.kind, source: input.source ?? 'staff', createdBy: input.createdBy ?? null, status: 'pending',
      });
      if (by != null) this.audit(req, by, 'cr.create', { crId: cr.id });
      return this.startChange(req, cr.id);
    });
  }

  /** A customer proposal: stored `proposed`, no effect on the pipeline until staff accepts it. */
  proposeChange(reqId: string, input: ChangeInput): ChangeRequestRow {
    const req = this.mustGet(reqId);
    if (req.status === 'cancelled') throw new CrNotAllowedError(reqId);
    const cr = this.repo.createChangeRequest(reqId, {
      title: input.title, description: input.description, kind: input.kind, source: input.source ?? 'customer', createdBy: input.createdBy ?? null, status: 'proposed',
    });
    this.log(reqId, 'info', `Có đề xuất thay đổi ${cr.id}: ${cr.title}`);
    return cr;
  }

  /** Staff takes a proposal in: it becomes `pending` and is handled like submitChange. */
  acceptProposal(reqId: string, crId: string): ChangeRequestRow {
    const req = this.mustGet(reqId);
    if (req.status === 'cancelled') throw new CrNotAllowedError(reqId);
    this.expectCr(reqId, crId, 'proposed');
    return this.repo.tx(() => {
      this.repo.updateChangeRequest(reqId, crId, { status: 'pending' });
      return this.startChange(req, crId);
    });
  }

  rejectProposal(reqId: string, crId: string, note: string, decidedBy: number | null = null): ChangeRequestRow {
    const req = this.mustGet(reqId);
    this.expectCr(reqId, crId, 'proposed');
    // baselineFrom marks the CR as decided outside any CHANGE batch.
    const cr = this.repo.updateChangeRequest(reqId, crId, {
      status: 'rejected', decisionNote: note, decidedBy, decidedAt: this.now(), baselineFrom: req.baselineVersion,
    });
    this.log(reqId, 'info', `Từ chối đề xuất thay đổi ${crId}: ${note}`);
    return cr;
  }

  /** Decision on one analysed CR. When the last CR of the batch is decided, the batch is applied (or the request restored). */
  decideChange(reqId: string, crId: string, decision: 'accept' | 'reject', note?: string, decidedBy: number | null = null, expect?: string): ChangeRequestRow {
    const req = this.mustGet(reqId);
    this.checkToken(req, expect);
    if (req.stage !== 'CHANGE' || req.status !== 'awaiting_approval') {
      throw new Error(`Yêu cầu ${reqId} không ở bước chờ quyết định thay đổi (${req.stage}/${req.status})`);
    }
    this.expectCr(reqId, crId, 'awaiting_decision');
    if (this.multiUser) this.require(req, decidedBy, 'cr.decide', 'quyết định yêu cầu thay đổi');
    return this.repo.tx(() => {
      if (decidedBy != null) this.audit(req, decidedBy, 'cr.decide', { crId, decision, note });
      this.repo.updateChangeRequest(reqId, crId, {
        status: decision === 'accept' ? 'accepted' : 'rejected', decidedBy, decidedAt: this.now(), decisionNote: note ?? null,
      });
      this.log(reqId, 'info', `${decision === 'accept' ? 'Chấp nhận' : 'Từ chối'} yêu cầu thay đổi ${crId}${note ? `: ${note}` : ''}`);
      if (!this.repo.listChangeRequests(reqId).some(c => c.status === 'awaiting_decision')) this.finishChangeDecision(reqId, false);
      return this.repo.getChangeRequest(reqId, crId)!;
    });
  }

  private startChange(req: RequestRow, crId: string): ChangeRequestRow {
    const reqId = req.id;
    // The first CR of a batch records where the request was; later CRs of the same batch copy it.
    const jobs = this.repo.listJobs(reqId);
    const origin = req.stage === 'CHANGE'
      ? this.openBatch(reqId).find(c => c.id !== crId && c.interruptedStage)
      : { interruptedStage: req.stage, interruptedStatus: req.status, interruptedRunAfter: this.parkedRunAfter(req, jobs) };
    const cr = this.repo.updateChangeRequest(reqId, crId, {
      interruptedStage: origin?.interruptedStage ?? undefined, interruptedStatus: origin?.interruptedStatus ?? undefined,
      interruptedRunAfter: origin?.interruptedRunAfter ?? undefined,
    });
    const liveJob = this.busy(reqId) || jobs.some(j => j.status === 'queued' || j.status === 'paused' || j.status === 'running');
    if (req.stage === 'CHANGE' && req.status === 'running' && liveJob) {
      this.log(reqId, 'info', `Tiếp nhận yêu cầu thay đổi ${crId}: ${cr.title} — sẽ phân tích ngay sau lượt phân tích hiện tại`);
      return cr;
    }
    this.bump(reqId);
    for (const j of jobs) if (j.status === 'queued' || j.status === 'paused') this.repo.failJob(j.id, 'superseded by change request');
    this.abortRequest(reqId);
    this.log(reqId, 'info', req.stage === 'CHANGE'
      ? `Tiếp nhận yêu cầu thay đổi ${crId}: ${cr.title} — phân tích lại tác động`
      : `Tiếp nhận yêu cầu thay đổi ${crId}: ${cr.title} — tạm ngắt giai đoạn ${req.stage}`);
    this.setStatus(reqId, 'CHANGE', 'running');
    this.enqueue(reqId, 'CHANGE');
    return cr;
  }

  /** When a paused request is interrupted: run_after of its parked job (earliest), so a restore can keep a rate-limit pause. */
  private parkedRunAfter(req: RequestRow, jobs: JobRow[]): number | undefined {
    if (req.status !== 'paused') return undefined;
    const times = jobs.filter(j => j.status === 'paused').map(j => j.runAfter);
    return times.length ? Math.min(...times) : undefined;
  }

  /** CRs of the batch currently in progress (not yet finalized by finishChangeDecision). */
  private openBatch(reqId: string): ChangeRequestRow[] {
    return this.repo.listChangeRequests(reqId)
      .filter(c => OPEN_CR.has(c.status) || ((c.status === 'accepted' || c.status === 'rejected') && c.baselineFrom === null));
  }

  /** After CHANGE: gate the analysed CRs, or auto-accept them (auto mode, no remove, effort within the ceiling). */
  private afterChange(job: JobRow, req: RequestRow, run: StageRunRow, userPaused: boolean): void {
    const { repo } = this;
    const ws = Workspace.forRequest(this.cfg, this.repo, req);
    const analysed = repo.listChangeRequests(req.id).filter(c => c.status === 'analyzing');
    const missing = analysed.filter(c => !loadImpact(ws, c.id)).map(c => c.id);
    const fail = (error: string): void => this.applyOutcome(job, req, run, { kind: 'fail', error }, userPaused);
    if (missing.length) { fail(`Không đọc được báo cáo tác động (impact.json) hợp lệ của ${missing.join(', ')}`); return; }
    const atStart = this.changeSnapshot.get(req.id);
    this.changeSnapshot.delete(req.id);
    const pending = repo.listChangeRequests(req.id).filter(c => c.status === 'pending');
    // Pending at the start and still pending: the CHANGE handler skipped it — re-running would loop forever.
    const stuck = atStart ? pending.filter(c => atStart.has(c.id)) : [];
    if (stuck.length) { fail(`Giai đoạn phân tích thay đổi không xử lý yêu cầu thay đổi ${stuck.map(c => c.id).join(', ')}`); return; }
    if (pending.length) {
      const reruns = this.changeReruns.get(req.id) ?? 0;
      if (reruns >= MAX_CHANGE_RERUNS) {
        fail(`Liên tục có yêu cầu thay đổi mới trong lúc phân tích (${pending.map(c => c.id).join(', ')}) — đã phân tích lại ${MAX_CHANGE_RERUNS} lần, hãy chạy lại giai đoạn phân tích thay đổi`);
        return;
      }
      this.changeReruns.set(req.id, reruns + 1);
    } else this.changeReruns.delete(req.id);
    repo.finishStageRun(run.id, 'done');
    repo.finishJob(job.id);
    for (const c of analysed) repo.updateChangeRequest(req.id, c.id, { status: 'awaiting_decision' });
    if (pending.length) {
      this.log(req.id, 'info', `Có yêu cầu thay đổi mới trong lúc phân tích (${pending.map(c => c.id).join(', ')}) — phân tích tiếp trước khi quyết định`);
      this.setStatus(req.id, 'CHANGE', userPaused ? 'paused' : 'running');
      this.enqueue(req.id, 'CHANGE');
      return;
    }
    const waiting = repo.listChangeRequests(req.id).filter(c => c.status === 'awaiting_decision');
    const needsHuman = req.runMode === 'review' || waiting.some(c => {
      const i = loadImpact(ws, c.id);
      return !i || i.scope.remove.length > 0 || i.effort_delta_mh > this.cfg.crAutoAcceptMaxMh;
    });
    if (waiting.length && needsHuman) {
      this.setStatus(req.id, 'CHANGE', 'awaiting_approval');
      this.log(req.id, 'info', `Chờ quyết định cho yêu cầu thay đổi ${waiting.map(c => c.id).join(', ')}`);
      return;
    }
    for (const c of waiting) {
      repo.updateChangeRequest(req.id, c.id, { status: 'accepted', decidedBy: null, decidedAt: this.now(), decisionNote: AUTO_ACCEPT_NOTE });
    }
    if (waiting.length) this.log(req.id, 'info', `Tự động chấp nhận yêu cầu thay đổi ${waiting.map(c => c.id).join(', ')}`);
    this.finishChangeDecision(req.id, userPaused);
  }

  /**
   * Every CR of the batch is decided: rejected ones are closed (their unanswered questions dropped); accepted ones are
   * applied to the scope, each bumping the baseline, and the request re-enters the computed stage. When none is
   * accepted the request goes back to exactly where it was before the first CR. Runs inside the caller's transaction.
   */
  private finishChangeDecision(reqId: string, userPaused: boolean): void {
    const { repo } = this;
    const req = this.mustGet(reqId);
    const batch = repo.listChangeRequests(reqId).filter(c => (c.status === 'accepted' || c.status === 'rejected') && c.baselineFrom === null);
    const origin = batch.find(c => c.interruptedStage && c.interruptedStatus);
    const accepted = batch.filter(c => c.status === 'accepted');
    let v = req.baselineVersion;

    const answered = new Set(answeredQuestions(repo, reqId).map(a => a.id));
    for (const c of batch.filter(x => x.status === 'rejected')) {
      repo.updateChangeRequest(reqId, c.id, { baselineFrom: v });
      const drop = repo.listQuestions(reqId).filter(q => q.why.startsWith(`[${c.id}]`) && !answered.has(q.id)).map(q => q.id);
      if (drop.length) repo.deleteQuestions(reqId, drop);
    }

    if (!accepted.length) {
      if (!origin) {
        this.log(reqId, 'warn', 'Không xác định được trạng thái trước khi có yêu cầu thay đổi — cần can thiệp thủ công');
        this.setStatus(reqId, 'CHANGE', 'needs_human');
        return;
      }
      const plan = restorePrevious(origin.interruptedStage!, origin.interruptedStatus!);
      const status = plan.status === 'running' && userPaused ? 'paused' : plan.status;
      this.log(reqId, 'info', `Không chấp nhận thay đổi nào — quay lại giai đoạn ${plan.stage}`);
      this.setStatus(reqId, plan.stage, status);
      const ra = origin.interruptedRunAfter;
      // A rate-limit pause keeps its due time (the worker resumes it); a user pause stays parked until resume().
      if (plan.enqueue && status === 'paused' && ra !== null && ra < FAR_FUTURE) this.enqueueAt(reqId, plan.stage, ra);
      else if (plan.enqueue) this.enqueue(reqId, plan.stage);
      return;
    }

    const ws = Workspace.forRequest(this.cfg, this.repo, this.repo.getRequest(reqId)!);
    const impacts = accepted.map(c => {
      const i = loadImpact(ws, c.id);
      if (!i) throw new Error(`Không đọc được báo cáo tác động (impact.json) hợp lệ của ${c.id}`);
      return i;
    });
    accepted.forEach((c, k) => {
      applyAcceptedChange(repo, req, c, impacts[k]!);
      repo.updateChangeRequest(reqId, c.id, { baselineFrom: v, baselineTo: v + 1 });
      v++;
    });
    const hasNewMust = impacts.some(i => i.questions.some(q => q.priority === 'must' && !answered.has(q.id)));
    const reentry = computeReentry(impacts, hasNewMust, origin?.interruptedStage ?? 'TEST');
    const newIteration = origin?.interruptedStatus === 'done';
    repo.updateRequest(reqId, { baselineVersion: v, clarifyRound: 0, iteration: req.iteration + (newIteration ? 1 : 0) });
    this.log(reqId, 'info', `Áp dụng thay đổi ${accepted.map(c => c.id).join(', ')}: phiên bản yêu cầu v${v}${newIteration ? `, vòng lặp ${req.iteration + 1}` : ''} — quay lại giai đoạn ${reentry}`);
    this.setStatus(reqId, reentry, userPaused ? 'paused' : 'running');
    this.enqueue(reqId, reentry);
  }

  /** CRs left `analyzing` by a failed or interrupted CHANGE go back to `pending` so the next CHANGE analyses them. */
  private resetAnalyzing(reqId: string): void {
    for (const c of this.repo.listChangeRequests(reqId)) if (c.status === 'analyzing') this.repo.updateChangeRequest(reqId, c.id, { status: 'pending' });
  }

  /** Accepted, not yet applied CRs with their impact reports (StageContext.changes). */
  private acceptedChanges(req: RequestRow, ws: Workspace): { cr: ChangeRequestRow; impact: ImpactOutT }[] {
    const out: { cr: ChangeRequestRow; impact: ImpactOutT }[] = [];
    for (const cr of this.repo.listChangeRequests(req.id)) {
      if (cr.status !== 'accepted' || cr.baselineTo === null) continue;
      const impact = loadImpact(ws, cr.id);
      if (impact) out.push({ cr, impact });
      else this.log(req.id, 'warn', `Không đọc được báo cáo tác động của ${cr.id}, bỏ qua`);
    }
    return out;
  }

  private expectCr(reqId: string, crId: string, status: ChangeRequestRow['status']): ChangeRequestRow {
    const cr = this.repo.getChangeRequest(reqId, crId);
    if (!cr) throw new Error(`Không tìm thấy yêu cầu thay đổi ${reqId}/${crId}`);
    if (cr.status !== status) throw new Error(`Yêu cầu thay đổi ${crId} đang ở trạng thái ${cr.status}, cần ${status}`);
    return cr;
  }

  // ---- job execution (called by Worker) ----

  async runJob(job: JobRow): Promise<void> {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    try { await this.execJob(job, done); } finally { resolve(); }
  }

  private async execJob(job: JobRow, done: Promise<void>): Promise<void> {
    const payload: JobPayload = { ...(job.payload as JobPayload) };
    const stage = payload.stage;
    const isTask = job.kind === 'run_task';
    const req0 = job.requestId ? this.repo.getRequest(job.requestId) : undefined;
    if ((job.kind !== 'run_stage' && !isTask) || !stage || !req0 || (isTask && !payload.taskId)) { this.repo.failJob(job.id, `Unsupported job ${job.kind}`); return; }
    const reqId = req0.id;
    const stale = (): boolean => payload.gen !== undefined && payload.gen < (this.gens.get(reqId) ?? 0);
    if (req0.status === 'cancelled') { this.repo.failJob(job.id, 'cancelled'); return; }
    if (stale()) { this.repo.failJob(job.id, 'superseded'); return; }
    const blocked = req0.projectId != null ? this.blockedProjects.get(req0.projectId) : undefined;
    if (blocked) {
      // A rerun / resume while the project is stopped: never leave the request `running` without a job.
      this.repo.failJob(job.id, `Dự án đang bị dừng: ${blocked}`);
      if (req0.status !== 'done' && req0.status !== 'needs_human') {
        this.log(reqId, 'error', `Dự án đang bị dừng sau khi kiểm tra an toàn (dfctl sweep) thất bại — admin cần kiểm tra: ${blocked}`);
        this.setStatus(reqId, isTask ? req0.stage : stage, 'needs_human');
      }
      return;
    }
    const kind: LiveJob['kind'] = isTask ? 'task' : this.isDispatcher(req0, stage) ? 'dispatch' : 'stage';
    // An interrupted handler (submitChange) may still be unwinding: never run two stages of one request at once
    // (task jobs of one request run in parallel). Gives up after STAGE_TIMEOUT_MIN (no limit when 0).
    if (this.busyFor(reqId, kind)) {
      const now = this.now();
      const since = this.busySince.get(job.id);
      if (since === undefined) {
        this.busySince.set(job.id, now);
        if (kind === 'stage') this.log(reqId, 'info', `Chờ giai đoạn bị ngắt dừng hẳn trước khi chạy ${stage}`);
      } else if (this.cfg.stageTimeoutMin > 0 && now - since > this.cfg.stageTimeoutMin * 60_000) {
        this.busySince.delete(job.id);
        const msg = `Giai đoạn bị ngắt không dừng sau ${this.cfg.stageTimeoutMin} phút — không thể chạy ${stage}`;
        this.repo.failJob(job.id, msg);
        this.log(reqId, 'error', msg);
        this.setStatus(reqId, isTask ? req0.stage : stage, 'failed');
        return;
      }
      this.repo.pauseJob(job.id, now + BUSY_RETRY_MS);
      return;
    }
    this.busySince.delete(job.id);

    const role = this.multiUser ? this.jobRole(req0, payload, isTask) : undefined;
    const seat = role ? this.seatOf(req0, payload, isTask) : null;
    if (role && seat !== job.seatUserId) this.repo.setJobSeat(job.id, seat);
    const controller = new AbortController();
    const live: LiveJob = { reqId, projectId: req0.projectId ?? null, kind, payload, controller, seat, role, done };
    this.live.set(job.id, live);

    let run: StageRunRow | undefined;
    let outcome: StageOutcome | undefined;
    let thrown: unknown;
    let seatErr: SeatUnavailableError | undefined;
    try {
      // A job waiting for a seat (or one nobody can run) checks the seat before doing anything.
      if (role && (seat === null || payload.awaitSeat !== undefined)) {
        const checkRole = payload.awaitRole && payload.awaitRole !== role ? payload.awaitRole : role;
        const checkSeat = checkRole === role ? seat : this.seatForRole(req0, checkRole);
        const usable = checkSeat !== null && await this.seatUsable(checkSeat);
        if (!usable) {
          this.live.delete(job.id);
          if (this.repo.getRequest(reqId)?.status === 'cancelled' || stale()) { this.repo.failJob(job.id, 'cancelled'); return; }
          this.parkForSeat(job, req0, payload, checkSeat, checkRole);
          return;
        }
        delete payload.awaitSeat;
        delete payload.awaitRole;
        this.repo.setJobPayload(job.id, payload);
        this.log(reqId, 'info', `Seat của ${this.userName(checkSeat!)} sẵn sàng — chạy tiếp ${isTask ? payload.taskId : stage}`);
      }
      if (!isTask) {
        // A stage_run still marked running belongs to a crashed process.
        const prev = this.repo.latestStageRun(reqId, stage);
        if (prev?.status === 'running') this.repo.finishStageRun(prev.id, 'failed', { error: 'interrupted' });
        // A claimed job always runs; a user pause is detected only after the handler returns.
        this.setStatus(reqId, stage, 'running');
        if (stage === 'CHANGE') { // leftovers of an interrupted/failed CHANGE run go back to pending
          this.resetAnalyzing(reqId);
          this.changeSnapshot.set(reqId, new Set(this.repo.listChangeRequests(reqId).filter(c => c.status === 'pending').map(c => c.id)));
        }
        // Approvals belong to one attempt of the gate: a rerun starts with none.
        if (!payload.dispatch) this.repo.clearApprovals(reqId, stage);
      } else if (this.repo.getRequest(reqId)?.status === 'awaiting_seat') {
        this.setStatus(reqId, req0.stage, 'running');
      }
      const req = this.repo.getRequest(reqId)!;
      if (!isTask) run = this.repo.createStageRun(reqId, stage, payload.feedback ?? null);
      const ws = Workspace.forRequest(this.cfg, this.repo, req).ensure();
      this.log(reqId, 'info', isTask
        ? `Bắt đầu ${payload.taskId}${seat !== null ? ` (seat ${this.userName(seat)})` : ''}`
        : `Bắt đầu giai đoạn ${stage} (lần ${run!.attempt})${seat !== null ? ` — seat ${this.userName(seat)}` : ''}`);
      const reg = registry.get(stage);
      if (reg) outcome = await reg.handler(this.makeContext(req, ws, run, payload, live));
      else if (stage === 'INTAKE' || stage === 'DONE') outcome = { kind: 'next' };
      else outcome = { kind: 'fail', error: `Chưa đăng ký xử lý cho giai đoạn ${stage}` };
    } catch (e) {
      if (e instanceof RateLimitError) {
        outcome = { kind: 'retry_later', until: e.until };
        if (e.seatUserId != null) this.seatPausedUntil.set(e.seatUserId, e.until.getTime());
      } else if (e instanceof SeatUnavailableError) seatErr = e;
      else thrown = e;
    } finally {
      this.live.delete(job.id);
    }

    const reason: unknown = controller.signal.aborted ? controller.signal.reason : undefined;
    if (this.repo.getRequest(reqId)?.status === 'cancelled' || stale()) {
      if (run) this.repo.finishStageRun(run.id, 'cancelled');
      this.repo.failJob(job.id, stale() ? 'superseded' : 'cancelled');
      return;
    }
    if (thrown instanceof SeatSweepError) {
      if (run) this.repo.finishStageRun(run.id, 'failed', { error: thrown.message });
      this.repo.failJob(job.id, thrown.message);
      if (req0.projectId != null) this.stopProject(req0.projectId, thrown.message);
      return;
    }
    if (reason === PROJECT_STOP) {
      if (run) this.repo.finishStageRun(run.id, 'failed', { error: 'project stopped' });
      this.repo.failJob(job.id, 'project stopped');
      return;
    }
    // Runner changed / member removed while this ran: same attempt again on the new seat, not a failure or retry.
    if (reason === RESEAT && (thrown !== undefined || seatErr || outcome?.kind === 'fail' || outcome?.kind === 'needs_human')) {
      if (run) this.repo.finishStageRun(run.id, 'cancelled', { error: 'đổi người chạy' });
      this.repo.failJob(job.id, 'reseat');
      const next: JobPayload = { ...payload };
      delete next.awaitSeat;
      delete next.awaitRole;
      const req = this.repo.getRequest(reqId)!;
      const nj = this.repo.enqueueJob(reqId, job.kind, next, 0, this.seatOf(req, next, isTask));
      this.parkIfPaused(reqId, nj.id);
      if (!isTask && req.status !== 'paused') this.setStatus(reqId, stage, 'running');
      this.log(reqId, 'info', `Đổi người chạy: ${isTask ? payload.taskId : `giai đoạn ${stage}`} chạy lại bằng seat mới (không tính là lỗi)`);
      return;
    }
    if (seatErr) {
      if (run) this.repo.finishStageRun(run.id, 'awaiting_seat', { error: seatErr.message });
      this.parkForSeat(job, req0, payload, seatErr.userId, seatErr.role ?? role);
      return;
    }

    if (thrown !== undefined) {
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      if (run) this.repo.finishStageRun(run.id, 'failed', { error: msg });
      this.log(reqId, 'error', `${isTask ? payload.taskId : `Giai đoạn ${stage}`} lỗi: ${msg}`);
      this.repo.tx(() => {
        this.repo.failJob(job.id, msg);
        if ((payload.errRetries ?? 0) < MAX_EXCEPTION_RETRIES) {
          this.log(reqId, 'warn', isTask ? `Thử lại ${payload.taskId} một lần nữa` : 'Thử lại giai đoạn một lần nữa');
          const retry = this.repo.enqueueJob(reqId, job.kind, { ...payload, errRetries: (payload.errRetries ?? 0) + 1 }, this.now(), seat);
          this.parkIfPaused(reqId, retry.id);
        } else if (isTask) {
          if (this.repo.getTask(reqId, payload.taskId!)) this.repo.updateTask(reqId, payload.taskId!, { status: 'failed' });
          this.enqueueDispatch(reqId);
        } else {
          this.setStatus(reqId, stage, 'failed');
          if (stage === 'CHANGE') { this.resetAnalyzing(reqId); this.changeReruns.delete(reqId); }
        }
      });
      return;
    }

    const req = this.repo.getRequest(reqId)!;
    const userPaused = req.status === 'paused';
    if (isTask) { this.repo.tx(() => this.applyTaskOutcome(job, req, payload, outcome!)); return; }
    this.repo.tx(() => this.applyOutcome(job, req, run!, outcome!, userPaused));
  }

  // ---- internals ----

  /** DEVELOP of a project-rooted request only dispatches task jobs (no Claude, no seat). */
  private isDispatcher(req: Pick<RequestRow, 'projectId' | 'code'>, stage: Stage): boolean {
    return stage === 'DEVELOP' && req.projectId != null && !!req.code;
  }

  /** Role whose seat a job runs on (undefined: no Claude, e.g. INTAKE, DONE, the DEVELOP dispatcher). */
  private jobRole(req: RequestRow, p: JobPayload, isTask: boolean): ProjectRole | undefined {
    if (isTask) return 'DEV';
    if (!p.stage || this.isDispatcher(req, p.stage)) return undefined;
    return seatRoleFor(p.stage, { part: p.part });
  }

  private readonly excluded: SeatExclusion = (projectId, userId, role) =>
    this.exclusions.some(e => e.projectId === projectId && e.userId === userId && e.roles.has(role));

  /** Seat of a job in multi-user mode (null: none needed, or nobody can run it). */
  private seatOf(req: RequestRow, p: JobPayload, isTask: boolean): number | null {
    if (!this.multiUser || !p.stage || !this.jobRole(req, p, isTask)) return null;
    return resolveSeat(this.repo, req, p.stage, { part: p.part, taskId: isTask ? p.taskId : undefined, exclude: this.excluded });
  }

  private seatForRole(req: RequestRow, role: ProjectRole): number | null {
    return this.multiUser ? runnerOf(this.repo, req, role, this.excluded) : null;
  }

  /** A seat may run when its login is connected (or its state cannot be read: the run itself will tell). */
  private async seatUsable(userId: number): Promise<boolean> {
    try {
      const st = await this.seatRunner.status(userId);
      return st.state === 'connected' || st.state === 'unknown';
    } catch { return true; }
  }

  /** Parks a job until its seat is usable: re-checked every 10 min and on seatReconnected(). */
  private parkForSeat(job: JobRow, req: RequestRow, payload: JobPayload, seat: number | null, role: ProjectRole | undefined): void {
    const first = payload.awaitSeat === undefined;
    const p: JobPayload = { ...payload, awaitSeat: seat, ...(role ? { awaitRole: role } : {}) };
    this.repo.setJobPayload(job.id, p);
    const cur = this.repo.getRequest(req.id)!;
    // A user-paused request keeps its pause (resume() wakes it); otherwise re-check periodically.
    this.repo.pauseJob(job.id, cur.status === 'paused' ? FAR_FUTURE : this.now() + (this.deps.seatRecheckMs ?? SEAT_RECHECK_MS));
    if (first) {
      const who = seat === null ? `chưa có người phụ trách vai ${role ?? '?'}` : `seat Claude của ${this.userName(seat)} chưa kết nối hoặc đã hết hạn`;
      this.log(req.id, 'warn', `${job.kind === 'run_task' ? payload.taskId : `Giai đoạn ${payload.stage}`}: ${who} — chờ kết nối lại (tự kiểm tra mỗi 10 phút)`);
    }
    if (cur.status !== 'paused' && cur.status !== 'cancelled') this.setStatus(req.id, job.kind === 'run_task' ? cur.stage : payload.stage!, 'awaiting_seat');
  }

  /** Re-evaluates the seats of a request's jobs; returns the `done` promises of runs stopped for a reseat. */
  private reseatRequest(reqId: string): Promise<void>[] {
    if (!this.multiUser) return [];
    const req = this.repo.getRequest(reqId);
    if (!req) return [];
    const stopped: Promise<void>[] = [];
    for (const l of this.live.values()) {
      if (l.reqId !== reqId || !l.role || l.controller.signal.aborted) continue;
      const want = this.seatOf(req, l.payload, l.kind === 'task');
      const call = l.call;
      const callMoved = !!call?.role && call.role !== l.role && this.seatForRole(req, call.role) !== call.userId;
      if (want !== l.seat || callMoved) {
        l.controller.abort(RESEAT);
        stopped.push(l.done);
      }
    }
    const now = this.now();
    for (const j of this.repo.listJobs(reqId)) {
      if ((j.status !== 'queued' && j.status !== 'paused') || this.live.has(j.id)) continue;
      const p = j.payload as JobPayload;
      const isTask = j.kind === 'run_task';
      if (!p.stage || !this.jobRole(req, p, isTask)) continue;
      const want = this.seatOf(req, p, isTask);
      if (want !== j.seatUserId) this.repo.setJobSeat(j.id, want);
      // A job waiting for a seat re-checks right away with the new person.
      if (p.awaitSeat !== undefined && j.status === 'paused' && j.runAfter < FAR_FUTURE) this.repo.pauseJob(j.id, now);
    }
    return stopped;
  }

  /** A failed dfctl sweep: every job of the project stops until an admin clears it (clearProjectBlock). */
  private stopProject(projectId: number, msg: string): void {
    const text = `Kiểm tra an toàn thư mục dự án (dfctl sweep) thất bại — DevFlow dừng mọi việc của dự án cho đến khi admin kiểm tra: ${msg}`;
    this.blockedProjects.set(projectId, msg);
    this.repo.web.addAudit({ projectId, action: 'project.sweep_failed', detail: msg });
    for (const r of this.repo.listRequestsByProject(projectId)) {
      for (const l of this.live.values()) if (l.reqId === r.id) l.controller.abort(PROJECT_STOP);
      for (const j of this.repo.listJobs(r.id)) if (j.status === 'queued' || j.status === 'paused') this.repo.failJob(j.id, 'project stopped');
      if (r.status !== 'done' && r.status !== 'cancelled') {
        this.log(r.id, 'error', text);
        this.setStatus(r.id, r.stage, 'needs_human');
      }
    }
  }

  private applyTaskOutcome(job: JobRow, req: RequestRow, p: JobPayload, o: StageOutcome): void {
    const { repo } = this;
    switch (o.kind) {
      case 'retry_later':
        repo.pauseJob(job.id, o.until.getTime());
        this.log(req.id, 'warn', `${p.taskId}: tạm dừng đến ${o.until.toISOString()} (giới hạn subscription của seat)`);
        return;
      case 'fail':
        repo.failJob(job.id, o.error);
        this.log(req.id, 'error', `${p.taskId} thất bại: ${o.error}`);
        this.enqueueDispatch(req.id);
        return;
      case 'needs_human':
        repo.finishJob(job.id);
        this.log(req.id, 'warn', `Cần can thiệp thủ công: ${o.reason}`);
        this.enqueueDispatch(req.id);
        return;
      default:
        repo.finishJob(job.id);
        this.enqueueDispatch(req.id);
    }
  }

  /** DEVELOP dispatcher re-entry after a task job (same generation; never resets failed tasks). */
  private enqueueDispatch(reqId: string): void {
    this.enqueue(reqId, 'DEVELOP', undefined, false, { dispatch: true });
  }

  /** Request finished: accepted CRs of this round are delivered. */
  private finishRequest(reqId: string, stage: Stage): void {
    for (const c of this.repo.listChangeRequests(reqId)) {
      if (c.status === 'accepted' && c.baselineTo !== null) this.repo.updateChangeRequest(reqId, c.id, { status: 'applied' });
    }
    this.setStatus(reqId, stage, 'done');
    this.log(reqId, 'info', 'Hoàn tất yêu cầu');
  }

  private applyOutcome(job: JobRow, req: RequestRow, run: StageRunRow, o: StageOutcome, userPaused: boolean): void {
    const { repo } = this;
    const stage = run.stage;
    if (stage === 'CHANGE' && o.kind !== 'next') { this.resetAnalyzing(req.id); this.changeReruns.delete(req.id); }
    switch (o.kind) {
      case 'next': {
        if (stage === 'CHANGE') { this.afterChange(job, req, run, userPaused); return; }
        repo.finishStageRun(run.id, 'done');
        repo.finishJob(job.id);
        const n = nextStage(stage, req);
        if (!n) {
          // v3 review mode: the PM signs off DONE (spec v3 §5.4); auto mode and legacy requests finish directly.
          if (stage === 'DONE' && req.runMode === 'review' && req.projectId != null) {
            this.setStatus(req.id, stage, 'awaiting_approval');
            this.log(req.id, 'info', 'Chờ PM chốt hoàn tất yêu cầu');
            return;
          }
          this.finishRequest(req.id, stage);
          return;
        }
        if (registry.get(stage)?.gate && req.runMode === 'review') {
          this.setStatus(req.id, stage, 'awaiting_approval');
          this.log(req.id, 'info', `Chờ duyệt giai đoạn ${stage}`);
          return;
        }
        this.setStatus(req.id, n, userPaused ? 'paused' : 'running');
        this.enqueue(req.id, n);
        return;
      }
      case 'wait': {
        repo.finishStageRun(run.id, 'done');
        repo.finishJob(job.id);
        // Only task jobs waiting for a seat are left: show the request as awaiting_seat (a blocker).
        const tasks = repo.listJobs(req.id).filter(j => j.kind === 'run_task' && ['queued', 'paused', 'running'].includes(j.status));
        const waitingSeat = tasks.length > 0 && tasks.every(j => j.status === 'paused' && (j.payload as JobPayload).awaitSeat !== undefined);
        this.setStatus(req.id, stage, userPaused ? 'paused' : waitingSeat ? 'awaiting_seat' : 'running');
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

  /** Git for a directory with the responsible user's identity (multi-user mode) and the request's push rules. */
  private gitFor(req: RequestRow, ws: Workspace, dir: string, actor: { name: string; email: string } | undefined, gitlab: GitLabClient | undefined): Git {
    if (this.deps.makeGit && dir === ws.repoDir) return this.deps.makeGit(req, ws);
    // The project's default branch (from INTAKE's project.json) is never pushed to.
    const protectedBranch = readProjectInfo(ws)?.defaultBranch;
    // Git uses the same credential as the API client (the creator's own token when set), else the shared one.
    const token = gitlabToken(gitlab) || this.cfg.gitlab.token || undefined;
    return new Git(dir, {
      mode: this.cfg.mode, token, protectedBranch, onWarn: m => this.log(req.id, 'warn', m),
      ...(actor ? { authorName: actor.name, authorEmail: actor.email } : {}),
    });
  }

  /** Commit identity of a seat user (Google name/e-mail); undefined in local mode. */
  private identity(userId: number | null): { name: string; email: string } | undefined {
    if (!this.multiUser || userId === null) return undefined;
    const u = this.repo.web.getUser(userId);
    if (!u) return undefined;
    return { name: u.displayName || u.email || u.username, email: u.email ?? `user-${u.id}@devflow.invalid` };
  }

  private makeContext(req: RequestRow, ws: Workspace, run: StageRunRow | undefined, payload: JobPayload, live: LiveJob): StageContext {
    const reqId = req.id;
    const signal = live.controller.signal;
    const multi = this.multiUser;
    const log = (msg: string, level: 'info' | 'warn' | 'error' = 'info'): void => this.log(reqId, level, msg);
    const gitlab = this.deps.makeGitLab
      ? this.deps.makeGitLab(req)
      : this.cfg.gitlab.url && this.cfg.gitlab.token ? new GitLabClient(this.cfg.gitlab.url, this.cfg.gitlab.token) : undefined;
    const actor = this.identity(live.seat);
    const timeoutMs = this.cfg.stageTimeoutMin > 0 ? this.cfg.stageTimeoutMin * 60_000 : undefined;
    const isTask = live.kind === 'task';
    const logName = run ? `${run.stage}-${run.attempt}` : `${payload.stage}-${payload.taskId}-${this.now()}`;

    const claudeAs = async (userId: number | null, prompt: string, extra: Partial<RunOpts> = {}, role?: ProjectRole): Promise<RunResult> => {
      const w = ctx.ws;
      const cwd = extra.cwd ?? w.repoDir;
      if (multi) {
        if (userId === null) throw new SeatUnavailableError(null, 'unassigned', role);
        const until = this.seatPausedTill(userId);
        if (until !== undefined) throw new RateLimitError(new Date(until), userId);
        // dfctl only runs seats inside <project>/.devflow/worktrees/<x>.
        if (!w.projectDir || !isWorktreeOf(w.projectDir, cwd)) throw new Error(`Seat Claude chỉ chạy trong worktree của dự án (.devflow/worktrees/<x>), không chạy tại ${cwd}`);
      }
      const release = multi ? await this.limiter.acquire(userId!, signal) : undefined;
      live.call = { userId, role };
      let res: RunResult;
      try {
        res = await this.seatRunner.run(multi ? userId : null, {
          cwd,
          addDirs: [w.root],
          logFile: join(w.logsDir, `${logName}.log`),
          signal,
          ...(timeoutMs ? { timeoutMs } : {}),
          onEvent: line => { const t = summarizeEvent(line); if (t) log(t.length > MAX_LOG_LINE ? `${t.slice(0, MAX_LOG_LINE)}…` : t); },
          prompt,
          ...extra,
        });
      } catch (e) {
        // The run may have touched the worktree before failing: sweep before any retry or git on it. A failed
        // sweep surfaces as SeatSweepError (hard stop) instead of the original error.
        if (multi && req.projectId != null && !(e instanceof SeatSweepError)) await this.seatRunner.sweepProject(req.projectId, cwd);
        throw e;
      } finally {
        live.call = undefined;
        release?.();
      }
      // DevFlow runs git on this worktree next: the project's git dirs are swept first (dfctl waits for the
      // worktree lock, so this also covers aborted and timed-out runs). Throws SeatSweepError (hard stop).
      if (multi && req.projectId != null) await this.seatRunner.sweepProject(req.projectId, cwd);
      // Aborted is not a failure: the pipeline decides (cancel, change request, reseat).
      if (res.aborted) throw new RunAbortedError();
      if (res.sessionId && run) this.repo.setStageRunSession(run.id, res.sessionId);
      if (res.rateLimitedUntil) throw new RateLimitError(res.rateLimitedUntil, multi ? userId : null);
      if (res.seatError) throw new SeatUnavailableError(userId, res.seatError, role);
      return res;
    };

    const ctx: StageContext = {
      cfg: this.cfg, repo: this.repo, req, ws, feedback: payload.feedback || undefined, resume: !!payload.resume, signal, log, gitlab,
      git: this.gitFor(req, ws, ws.repoDir, actor, gitlab),
      changes: this.acceptedChanges(req, ws), baseline: req.baselineVersion,
      seatUserId: live.seat,
      actor,
      part: payload.part,
      reentry: !!payload.dispatch,
      taskId: isTask ? payload.taskId : undefined,
      requestGit: isTask ? this.gitFor(req, ws, ws.repoDir, actor, gitlab) : undefined,
      claude: (prompt, extra) => claudeAs(live.seat, prompt, extra, live.role),
      claudeAs,
      seatFor: role => this.seatForRole(req, role),
      serialize: (key, fn) => this.serialize(key, fn),
      enqueueTask: (taskId, extra = {}) => {
        const p: JobPayload = { stage: 'DEVELOP', taskId, gen: this.gens.get(reqId) ?? 0, ...(extra.feedback ? { feedback: extra.feedback } : {}) };
        const job = this.repo.enqueueJob(reqId, 'run_task', p, 0, this.seatOf(this.repo.getRequest(reqId)!, p, true));
        this.parkIfPaused(reqId, job.id);
      },
      liveTasks: () => new Set(this.repo.listJobs(reqId)
        .filter(j => j.kind === 'run_task' && ['queued', 'paused', 'running'].includes(j.status))
        .map(j => (j.payload as JobPayload).taskId ?? '').filter(Boolean)),
      makeGit: dir => this.gitFor(req, ws, dir, actor, gitlab),
    };
    return ctx;
  }

  /** Runs `fn` after every earlier holder of `key` (in this process). */
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const p = prev.catch(() => undefined).then(fn);
    const tail = p.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return p;
  }

  /** Any job of the request executing in this process. */
  private busy(reqId: string): boolean {
    for (const l of this.live.values()) if (l.reqId === reqId) return true;
    return false;
  }

  /** Stage jobs wait for everything; the dispatcher waits for stage jobs and itself; task jobs only for stage jobs. */
  private busyFor(reqId: string, kind: LiveJob['kind']): boolean {
    for (const l of this.live.values()) {
      if (l.reqId !== reqId) continue;
      if (kind === 'stage' || l.kind === 'stage' || (kind === 'dispatch' && l.kind === 'dispatch')) return true;
    }
    return false;
  }

  /** Stops every run of the request (cancel / change request). */
  private abortRequest(reqId: string): void {
    for (const l of this.live.values()) if (l.reqId === reqId) l.controller.abort();
  }

  // ---- permissions (multi-user mode) ----

  private actorFor(req: RequestRow, by: number | null | undefined): Actor | undefined {
    if (by == null) return undefined;
    const u: UserRow | undefined = this.repo.web.getUser(by);
    if (!u || u.disabled) return undefined;
    const roles = req.projectId != null ? this.repo.getProjectMember(req.projectId, u.id)?.roles ?? [] : [];
    return { userId: u.id, sysRole: u.sysRole, departmentId: u.departmentId, canBePm: u.canBePm, projectRoles: roles };
  }

  private projectCtx(req: RequestRow): { departmentId: number | null } | undefined {
    const p = req.projectId != null ? this.repo.getProject(req.projectId) : undefined;
    return p ? { departmentId: p.departmentId } : undefined;
  }

  /** Throws PermissionError unless `by` may do `action` on the request's project. */
  private require(req: RequestRow, by: number | null | undefined, action: Action, what: string): void {
    const actor = this.actorFor(req, by);
    const project = this.projectCtx(req);
    if (!actor || !project || !can(actor, action, { project })) throw new PermissionError(`Bạn không có quyền ${what}.`);
  }

  /** Like require, with the actor's assignee roles on this request (multi-user mode only). */
  private requireRequestRight(req: RequestRow, by: number | null | undefined, action: Action, what: string): void {
    if (!this.multiUser) return;
    const actor = this.actorFor(req, by);
    const project = this.projectCtx(req);
    const requestRoles = this.repo.listRequestAssignees(req.id).filter(a => a.userId === by).map(a => a.role);
    if (!actor || !project || !can(actor, action, { project, requestRoles })) throw new PermissionError(`Bạn không có quyền ${what}.`);
  }

  /** Gate approve/reject: PM, or an assignee of the gate's role on this request (multi-user mode only). */
  private requireGate(req: RequestRow, by: number | null | undefined, part: string | undefined): void {
    if (!this.multiUser) return;
    if (!Object.hasOwn(GATE_APPROVER, req.stage)) throw new PermissionError(`Giai đoạn ${req.stage} không có bước duyệt.`);
    const actor = this.actorFor(req, by);
    const project = this.projectCtx(req);
    const requestRoles = this.repo.listRequestAssignees(req.id).filter(a => a.userId === by).map(a => a.role);
    if (!actor || !project || !can(actor, { type: 'gate.approve', stage: req.stage, ...(part ? { part } : {}) }, { project, requestRoles })) {
      throw new PermissionError(`Bạn không có quyền duyệt hoặc từ chối giai đoạn ${req.stage} của yêu cầu này.`);
    }
  }

  private audit(req: RequestRow, by: number | null, action: string, detail: unknown): void {
    this.repo.web.addAudit({ projectId: req.projectId ?? null, requestId: req.id, userId: by, action, detail: JSON.stringify(detail) });
  }

  private userName(id: number): string {
    const u = this.repo.web.getUser(id);
    return u ? (u.displayName || u.email || u.username) : `#${id}`;
  }

  private bump(reqId: string): void { this.gens.set(reqId, (this.gens.get(reqId) ?? 0) + 1); }

  private enqueue(reqId: string, stage: Stage, feedback?: string, resume = false, extra: Partial<JobPayload> = {}): void {
    const payload: JobPayload = { stage, gen: this.gens.get(reqId) ?? 0, ...extra };
    if (feedback) payload.feedback = feedback;
    if (resume) payload.resume = true;
    const req = this.repo.getRequest(reqId);
    const job = this.repo.enqueueJob(reqId, 'run_stage', payload, 0, req ? this.seatOf(req, payload, false) : null);
    this.parkIfPaused(reqId, job.id);
  }

  /** Enqueues a stage job that stays parked until `runAfter` (restored rate-limit pause). */
  private enqueueAt(reqId: string, stage: Stage, runAfter: number): void {
    const payload: JobPayload = { stage, gen: this.gens.get(reqId) ?? 0 };
    const req = this.repo.getRequest(reqId);
    const job = this.repo.enqueueJob(reqId, 'run_stage', payload, 0, req ? this.seatOf(req, payload, false) : null);
    this.repo.pauseJob(job.id, runAfter);
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

/** `cwd` is exactly `<projectDir>/.devflow/worktrees/<name>`. */
function isWorktreeOf(projectDir: string, cwd: string): boolean {
  const c = resolve(cwd);
  return WORKTREE_RE.test(c) && dirname(c) === join(resolve(projectDir), '.devflow', 'worktrees');
}
