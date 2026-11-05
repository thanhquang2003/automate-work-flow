import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import {
  STAGES, type ChangeRequestRow, type CrKind, type CrSource, type ImpactOutT, type JobRow, type RequestRow, type RequestStatus, type Stage, type StageRunRow,
} from '../domain/types.js';
import { runClaude, type RunOpts, type RunResult } from '../claude/runner.js';
import { GitLabClient } from '../gitlab/client.js';
import { Git } from '../gitlab/git.js';
import { bus } from './bus.js';
import { CrNotAllowedError, applyAcceptedChange, computeReentry, loadImpact, restorePrevious } from './changes.js';
import { answeredQuestions, readProjectInfo } from './stages/common.js';
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
    if (req.stage === 'CHANGE') throw new Error('Giai đoạn CHANGE được duyệt theo từng yêu cầu thay đổi (decideChange), không dùng Duyệt chung');
    const n = nextStage(req.stage, req);
    if (!n) { this.setStatus(reqId, req.stage, 'done'); return; }
    this.setStatus(reqId, n, 'running');
    this.enqueue(reqId, n);
  }

  reject(reqId: string, feedback: string): void {
    const req = this.expectStatus(reqId, 'awaiting_approval');
    if (req.stage === 'CHANGE') throw new Error('Giai đoạn CHANGE được duyệt theo từng yêu cầu thay đổi (decideChange), không dùng Từ chối chung');
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

  // ---- change requests (spec §4.1, §4.3) ----

  /**
   * Records a CR `pending` and interrupts whatever the request is doing: the running stage is aborted (its outcome is
   * dropped as stale), queued/paused jobs are failed and CHANGE runs. While CHANGE is already running the CR only waits
   * (CHANGE runs again before the decision gate); at the decision gate CHANGE re-runs so it is analysed first.
   */
  submitChange(reqId: string, input: ChangeInput): ChangeRequestRow {
    const req = this.mustGet(reqId);
    if (req.status === 'cancelled') throw new CrNotAllowedError(reqId);
    return this.repo.tx(() => {
      const cr = this.repo.createChangeRequest(reqId, {
        title: input.title, description: input.description, kind: input.kind, source: input.source ?? 'staff', createdBy: input.createdBy ?? null, status: 'pending',
      });
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
  decideChange(reqId: string, crId: string, decision: 'accept' | 'reject', note?: string, decidedBy: number | null = null): ChangeRequestRow {
    const req = this.mustGet(reqId);
    if (req.stage !== 'CHANGE' || req.status !== 'awaiting_approval') {
      throw new Error(`Yêu cầu ${reqId} không ở bước chờ quyết định thay đổi (${req.stage}/${req.status})`);
    }
    this.expectCr(reqId, crId, 'awaiting_decision');
    return this.repo.tx(() => {
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
    const origin = req.stage === 'CHANGE'
      ? this.openBatch(reqId).find(c => c.id !== crId && c.interruptedStage)
      : { interruptedStage: req.stage, interruptedStatus: req.status };
    const cr = this.repo.updateChangeRequest(reqId, crId, {
      interruptedStage: origin?.interruptedStage ?? undefined, interruptedStatus: origin?.interruptedStatus ?? undefined,
    });
    if (req.stage === 'CHANGE' && req.status === 'running') {
      this.log(reqId, 'info', `Tiếp nhận yêu cầu thay đổi ${crId}: ${cr.title} — sẽ phân tích ngay sau lượt phân tích hiện tại`);
      return cr;
    }
    this.bump(reqId);
    for (const j of this.repo.listJobs(reqId)) if (j.status === 'queued' || j.status === 'paused') this.repo.failJob(j.id, 'superseded by change request');
    this.controllers.get(reqId)?.abort();
    this.log(reqId, 'info', req.stage === 'CHANGE'
      ? `Tiếp nhận yêu cầu thay đổi ${crId}: ${cr.title} — phân tích lại tác động`
      : `Tiếp nhận yêu cầu thay đổi ${crId}: ${cr.title} — tạm ngắt giai đoạn ${req.stage}`);
    this.setStatus(reqId, 'CHANGE', 'running');
    this.enqueue(reqId, 'CHANGE');
    return cr;
  }

  /** CRs of the batch currently in progress (not yet finalized by finishChangeDecision). */
  private openBatch(reqId: string): ChangeRequestRow[] {
    return this.repo.listChangeRequests(reqId)
      .filter(c => OPEN_CR.has(c.status) || ((c.status === 'accepted' || c.status === 'rejected') && c.baselineFrom === null));
  }

  /** After CHANGE: gate the analysed CRs, or auto-accept them (auto mode, no remove, effort within the ceiling). */
  private afterChange(job: JobRow, req: RequestRow, run: StageRunRow, userPaused: boolean): void {
    const { repo } = this;
    const ws = Workspace.for(this.cfg, req.id);
    const analysed = repo.listChangeRequests(req.id).filter(c => c.status === 'analyzing');
    const missing = analysed.filter(c => !loadImpact(ws, c.id)).map(c => c.id);
    if (missing.length) {
      this.applyOutcome(job, req, run, { kind: 'fail', error: `Không đọc được báo cáo tác động (impact.json) hợp lệ của ${missing.join(', ')}` }, userPaused);
      return;
    }
    repo.finishStageRun(run.id, 'done');
    repo.finishJob(job.id);
    for (const c of analysed) repo.updateChangeRequest(req.id, c.id, { status: 'awaiting_decision' });
    if (repo.listChangeRequests(req.id).some(c => c.status === 'pending')) {
      this.log(req.id, 'info', 'Có yêu cầu thay đổi mới trong lúc phân tích — phân tích tiếp trước khi quyết định');
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
      if (plan.enqueue) this.enqueue(reqId, plan.stage);
      return;
    }

    const ws = Workspace.for(this.cfg, reqId);
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
    const payload = job.payload as { stage?: Stage; feedback?: string; resume?: boolean; gen?: number; errRetries?: number };
    const stage = payload.stage;
    const req0 = job.requestId ? this.repo.getRequest(job.requestId) : undefined;
    if (job.kind !== 'run_stage' || !stage || !req0) { this.repo.failJob(job.id, `Unsupported job ${job.kind}`); return; }
    const reqId = req0.id;
    const stale = (): boolean => payload.gen !== undefined && payload.gen < (this.gens.get(reqId) ?? 0);
    if (req0.status === 'cancelled') { this.repo.failJob(job.id, 'cancelled'); return; }
    if (stale()) { this.repo.failJob(job.id, 'superseded'); return; }
    // An interrupted handler (submitChange) may still be unwinding: never run two stages of one request at once.
    if (this.controllers.has(reqId)) { this.repo.pauseJob(job.id, this.now() + BUSY_RETRY_MS); return; }

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
      if (stage === 'CHANGE') this.resetAnalyzing(reqId); // leftovers of an interrupted/failed CHANGE run
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
        } else {
          this.setStatus(reqId, stage, 'failed');
          if (stage === 'CHANGE') this.resetAnalyzing(reqId);
        }
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
        if (stage === 'CHANGE') { this.afterChange(job, req, run, userPaused); return; }
        repo.finishStageRun(run.id, 'done');
        repo.finishJob(job.id);
        const n = nextStage(stage, req);
        if (!n) {
          // DONE: the accepted CRs of this round are now delivered.
          for (const c of repo.listChangeRequests(req.id)) {
            if (c.status === 'accepted' && c.baselineTo !== null) repo.updateChangeRequest(req.id, c.id, { status: 'applied' });
          }
          this.setStatus(req.id, stage, 'done');
          this.log(req.id, 'info', 'Hoàn tất yêu cầu');
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
        if (stage === 'CHANGE') this.resetAnalyzing(req.id);
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
    // Git uses the same credential as the API client (the creator's own token when set), else the shared one.
    const token = gitlabToken(gitlab) || this.cfg.gitlab.token || undefined;
    const git = this.deps.makeGit ? this.deps.makeGit(req, ws) : new Git(ws.repoDir, { token, protectedBranch });
    const timeoutMs = this.cfg.stageTimeoutMin > 0 ? this.cfg.stageTimeoutMin * 60_000 : undefined;
    return {
      cfg: this.cfg, repo: this.repo, req, ws, feedback: feedback || undefined, resume, signal, log, gitlab, git,
      changes: this.acceptedChanges(req, ws), baseline: req.baselineVersion,
      claude: async (prompt, extra = {}) => {
        const res = await runClaude(this.cfg, {
          cwd: ws.repoDir,
          addDirs: [ws.root],
          logFile: join(ws.logsDir, `${run.stage}-${run.attempt}.log`),
          signal,
          ...(timeoutMs ? { timeoutMs } : {}),
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
