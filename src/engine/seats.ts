import type { Repo } from '../db/repo.js';
import type { ProjectRole, RequestRow, Stage } from '../domain/types.js';

/**
 * Stage → role whose seat runs Claude (plan Global Constraints). PLANNING runs DEV (tasks) then TESTER (test
 * cases); DEVELOP/BUGFIX run on the task assignee (fallback: first DEV) and review on the REVIEWER seat.
 * INTAKE, CLARIFY and DONE never run Claude.
 */
export const STAGE_SEAT_ROLE: Partial<Record<Stage, ProjectRole>> = {
  CODEBASE_SCAN: 'SE', ANALYSIS: 'BA', BREAKDOWN: 'BA', DESIGN: 'SE', PLANNING: 'DEV',
  DEVELOP: 'DEV', TEST: 'TESTER', BUGFIX: 'DEV', CHANGE: 'BA',
};

/** The two Claude runs of PLANNING (spec v3 §6b.6): DEV writes tasks, TESTER writes test cases. */
export type PlanningPart = 'tasks' | 'testcases';
export const PLANNING_PARTS: readonly PlanningPart[] = ['tasks', 'testcases'];
export const isPlanningPart = (p: unknown): p is PlanningPart => p === 'tasks' || p === 'testcases';

/** Seat role for one Claude run. */
export function seatRoleFor(stage: Stage, o: { part?: PlanningPart; review?: boolean } = {}): ProjectRole | undefined {
  if (o.review) return 'REVIEWER';
  if (stage === 'PLANNING') return o.part === 'testcases' ? 'TESTER' : 'DEV';
  return STAGE_SEAT_ROLE[stage];
}

/** A seat cannot be used: login expired / never connected, or nobody is assigned to the role. */
export class SeatUnavailableError extends Error {
  constructor(public userId: number | null, public reason: 'expired' | 'disconnected' | 'unassigned', public role?: ProjectRole) {
    super(reason === 'unassigned'
      ? `Chưa có người phụ trách vai ${role ?? '?'} để chạy Claude`
      : `Seat Claude của người dùng #${userId} ${reason === 'expired' ? 'đã hết hạn đăng nhập' : 'chưa kết nối'}`);
    this.name = 'SeatUnavailableError';
  }
}

/** A Claude run ended because its AbortSignal fired (cancel, change request, runner change, member removal). */
export class RunAbortedError extends Error {
  constructor() {
    super('Lần chạy Claude đã bị dừng');
    this.name = 'RunAbortedError';
  }
}

/** Excludes (project, user, role) while a member is being removed or loses a role (before the DB says so). */
export type SeatExclusion = (projectId: number, userId: number, role: ProjectRole) => boolean;

export interface SeatQuery {
  part?: PlanningPart;
  taskId?: string;
  review?: boolean;
  exclude?: SeatExclusion;
}

/** A candidate may run a role when they are a current, enabled project member holding it and not excluded. */
function eligible(repo: Repo, projectId: number, userId: number, role: ProjectRole, exclude?: SeatExclusion): boolean {
  if (exclude?.(projectId, userId, role)) return false;
  const m = repo.getProjectMember(projectId, userId);
  if (!m || !m.roles.includes(role)) return false;
  const u = repo.web.getUser(userId);
  return !!u && !u.disabled;
}

/** Runner of a role: the first assignee by position who is still eligible. */
export function runnerOf(repo: Repo, req: Pick<RequestRow, 'id' | 'projectId'>, role: ProjectRole, exclude?: SeatExclusion): number | null {
  if (req.projectId == null) return null;
  for (const a of repo.listRequestAssignees(req.id, role)) {
    if (eligible(repo, req.projectId, a.userId, role, exclude)) return a.userId;
  }
  return null;
}

/** Task owner: the task's assignee when still an eligible DEV, else the request's DEV runner. */
export function taskSeat(repo: Repo, req: Pick<RequestRow, 'id' | 'projectId'>, taskId: string, exclude?: SeatExclusion): number | null {
  if (req.projectId == null) return null;
  const t = repo.getTask(req.id, taskId);
  const a = t?.assigneeId ?? null;
  if (a !== null && eligible(repo, req.projectId, a, 'DEV', exclude)) return a;
  return runnerOf(repo, req, 'DEV', exclude);
}

/** Task whose feature has the bug BUGFIX works on next (same choice as the BUGFIX stage). */
export function bugfixTaskId(repo: Repo, reqId: string): string | undefined {
  const cancelled = new Set(repo.listTestCases(reqId).filter(tc => tc.scopeStatus === 'cancelled').map(tc => tc.id));
  const bugs = repo.listBugs(reqId).filter(b => (b.status === 'open' || b.status === 'fixing') && !cancelled.has(b.tcId));
  const bug = bugs.find(b => b.status === 'fixing') ?? bugs[0];
  if (!bug) return undefined;
  const feature = repo.getTestCase(reqId, bug.tcId)?.featureId;
  if (!feature) return undefined;
  const tasks = repo.listTasks(reqId).filter(t => t.featureId === feature && t.scopeStatus === 'active');
  return (tasks.find(t => t.assigneeId != null) ?? tasks[0])?.id;
}

/**
 * Seat (user id) that runs Claude for a stage of a project request, or null when nobody can (or the request has
 * no project). Callers decide whether seats apply at all (local mode keeps v2: no seats).
 */
export function resolveSeat(repo: Repo, req: Pick<RequestRow, 'id' | 'projectId'>, stage: Stage, q: SeatQuery = {}): number | null {
  if (req.projectId == null) return null;
  const role = seatRoleFor(stage, q);
  if (!role) return null;
  if (role === 'DEV' && q.taskId) return taskSeat(repo, req, q.taskId, q.exclude);
  if (role === 'DEV' && stage === 'BUGFIX') {
    const t = bugfixTaskId(repo, req.id);
    return t ? taskSeat(repo, req, t, q.exclude) : runnerOf(repo, req, 'DEV', q.exclude);
  }
  return runnerOf(repo, req, role, q.exclude);
}

/** Per-seat concurrency limit (SEAT_CONCURRENCY) for Claude runs, FIFO per seat. */
export class SeatLimiter {
  private active = new Map<number, number>();
  private waiting = new Map<number, (() => void)[]>();

  constructor(private limit: () => number) {}

  count(userId: number): number { return this.active.get(userId) ?? 0; }

  /** Resolves with a release function once the seat has a free slot. Rejects with RunAbortedError on abort. */
  acquire(userId: number, signal?: AbortSignal): Promise<() => void> {
    const release = (): void => {
      const n = (this.active.get(userId) ?? 1) - 1;
      if (n > 0) this.active.set(userId, n); else this.active.delete(userId);
      const q = this.waiting.get(userId);
      const next = q?.shift();
      if (q && !q.length) this.waiting.delete(userId);
      next?.();
    };
    const take = (): (() => void) => {
      this.active.set(userId, this.count(userId) + 1);
      let done = false;
      return () => { if (!done) { done = true; release(); } };
    };
    if (signal?.aborted) return Promise.reject(new RunAbortedError());
    if (this.count(userId) < Math.max(1, this.limit())) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
      const q = this.waiting.get(userId) ?? [];
      const go = (): void => { signal?.removeEventListener('abort', onAbort); resolve(take()); };
      const onAbort = (): void => {
        const i = q.indexOf(go);
        if (i >= 0) q.splice(i, 1);
        reject(new RunAbortedError());
      };
      q.push(go);
      this.waiting.set(userId, q);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
