import type { Repo } from '../db/repo.js';
import type { ProjectRole, ProjectRow, RequestRow, UserRow } from '../domain/types.js';
import { PROJECT_ROLES } from '../domain/types.js';
import { MAX_FIX_ATTEMPTS } from '../engine/stages/bugfix.js';
import { buildInbox } from '../web/inbox.js';
import { can, type Actor } from '../security/permissions.js';

/** Read-only summaries for the oversight area. Scoping happens here (and again on each :id route). */

export interface OversightUser {
  id: number; name: string; email: string; sysRole: string; departmentId: number | null; department: string;
  canBePm: boolean; disabled: boolean;
}
export interface OversightProject {
  id: number; key: string; name: string; departmentId: number; department: string; pm: string[];
  members: { role: ProjectRole; names: string[] }[]; requests: number; openRequests: number;
}

const CLOSED = new Set(['done', 'cancelled']);

/** Users and projects `actor` may see: cto/admin both departments, head/deputy their own (can('oversight.view')). */
export function listForActor(repo: Repo, actor: Actor): { users: OversightUser[]; projects: OversightProject[] } {
  const depts = new Map(repo.web.listDepartments().map(d => [d.id, d.name]));
  const nameOf = (id: number): string => { const u = repo.web.getUser(id); return u ? (u.displayName || u.email || u.username) : `#${id}`; };
  const users = repo.web.listUsers()
    .filter(u => can(actor, 'oversight.view', { targetUser: { departmentId: u.departmentId } }))
    .map((u: UserRow): OversightUser => ({
      id: u.id, name: u.displayName || u.username, email: u.email ?? u.username, sysRole: u.sysRole, departmentId: u.departmentId,
      department: u.departmentId != null ? depts.get(u.departmentId) ?? '' : '', canBePm: u.canBePm, disabled: u.disabled,
    }));
  const projects = repo.listProjects()
    .filter(p => can(actor, 'oversight.view', { project: { departmentId: p.departmentId } }))
    .map((p): OversightProject => {
      const members = repo.listProjectMembers(p.id);
      const reqs = repo.listRequestsByProject(p.id);
      return {
        id: p.id, key: p.key, name: p.name, departmentId: p.departmentId, department: depts.get(p.departmentId) ?? '',
        pm: members.filter(m => m.roles.includes('PM')).map(m => nameOf(m.userId)),
        members: PROJECT_ROLES.map(role => ({ role, names: members.filter(m => m.roles.includes(role)).map(m => nameOf(m.userId)) })),
        requests: reqs.length, openRequests: reqs.filter(r => !CLOSED.has(r.status)).length,
      };
    });
  return { users, projects };
}

/** The project when `actor` may oversee it, else undefined (callers answer 404 so existence is not leaked). */
export function projectForActor(repo: Repo, actor: Actor, id: number): ProjectRow | undefined {
  if (!Number.isInteger(id)) return undefined;
  const p = repo.getProject(id);
  return p && can(actor, 'oversight.view', { project: { departmentId: p.departmentId } }) ? p : undefined;
}

export interface ProgressRow { req: RequestRow; tasksTotal: number; tasksDone: number }
export function projectProgress(repo: Repo, project: ProjectRow): ProgressRow[] {
  return repo.listRequestsByProject(project.id).map(req => {
    const tasks = repo.listTasks(req.id).filter(t => t.scopeStatus === 'active');
    return { req, tasksTotal: tasks.length, tasksDone: tasks.filter(t => t.status === 'done').length };
  });
}

export type BlockerKind = 'awaiting_seat' | 'rejected_awaiting_fix' | 'awaiting_customer' | 'cr_awaiting_pm' | 'failed' | 'needs_human' | 'bug_at_cap';
export const BLOCKER_LABELS: Record<BlockerKind, string> = {
  awaiting_seat: 'Chờ người phụ trách kết nối Claude', rejected_awaiting_fix: 'Bị từ chối, đang chờ sửa', awaiting_customer: 'Chờ khách hàng trả lời',
  cr_awaiting_pm: 'Thay đổi yêu cầu chờ PM quyết định', failed: 'Lỗi', needs_human: 'Cần người xử lý', bug_at_cap: 'Bug đã sửa quá số lần cho phép',
};
export interface Blocker { kind: BlockerKind; label: string; projectId: number; projectKey: string; requestId: string; requestCode: string; stage: string; detail: string }

/** Blockers of the given projects. There is no "overdue" concept: only states that need somebody to act. */
export function listBlockers(repo: Repo, projects: ProjectRow[]): Blocker[] {
  const out: Blocker[] = [];
  for (const p of projects) {
    for (const r of repo.listRequestsByProject(p.id)) {
      if (CLOSED.has(r.status)) continue;
      const add = (kind: BlockerKind, detail = '') => out.push({
        kind, label: BLOCKER_LABELS[kind], projectId: p.id, projectKey: p.key, requestId: r.id, requestCode: r.code ?? r.id, stage: r.stage, detail,
      });
      if (r.status === 'awaiting_seat') add('awaiting_seat');
      if (r.status === 'awaiting_customer') add('awaiting_customer');
      if (r.status === 'failed') add('failed');
      if (r.status === 'needs_human') add('needs_human');
      const rejected = repo.listApprovals(r.id, r.stage).some(a => a.decision === 'reject');
      if (rejected && r.status !== 'awaiting_approval') add('rejected_awaiting_fix');
      const crs = repo.listChangeRequests(r.id).filter(c => c.status === 'proposed' || c.status === 'awaiting_decision');
      if (crs.length) add('cr_awaiting_pm', crs.map(c => c.id).join(', '));
      const bugs = repo.listBugs(r.id).filter(b => b.status === 'needs_human' || (b.status === 'open' && b.fixAttempts >= MAX_FIX_ATTEMPTS));
      if (bugs.length) add('bug_at_cap', bugs.map(b => b.tcId).join(', '));
    }
  }
  return out;
}

export interface PersonWork { user: OversightUser; tasks: { requestCode: string; projectKey: string; taskId: string; title: string; status: string }[]; running: number; waitingApproval: number }

/** Per-person work: open tasks assigned, jobs running on their seat, gates and CR decisions waiting for them. */
export function listPeopleWork(repo: Repo, users: OversightUser[], projects: ProjectRow[]): PersonWork[] {
  const ids = new Set(projects.map(p => p.id));
  const running = new Map<number, number>();
  for (const j of repo.listJobs()) {
    if (j.status === 'running' && j.seatUserId != null) running.set(j.seatUserId, (running.get(j.seatUserId) ?? 0) + 1);
  }
  return users.map(user => {
    const inbox = buildInbox(repo, user.id);
    return {
      user,
      tasks: inbox.tasks.filter(t => ids.has(t.project.id)).map(t => ({
        requestCode: t.req.code ?? t.req.id, projectKey: t.project.key, taskId: t.task.id, title: t.task.title, status: t.task.status,
      })),
      running: running.get(user.id) ?? 0,
      waitingApproval: inbox.gates.filter(g => ids.has(g.project.id)).length + inbox.crs.filter(g => ids.has(g.project.id)).length,
    };
  });
}
