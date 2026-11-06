import type { Repo } from '../db/repo.js';
import type { JobPayload } from '../engine/pipeline.js';
import type { ProjectRow, RequestRow, TaskRow } from '../domain/types.js';
import { can, GATE_APPROVER } from '../security/permissions.js';

export interface InboxItem { req: RequestRow; project: ProjectRow }
export interface Inbox {
  gates: (InboxItem & { stageLabelKey: string })[];
  crs: (InboxItem & { crIds: string[] })[];
  tasks: (InboxItem & { task: TaskRow })[];
  seats: InboxItem[];
  projects: ProjectRow[];
}

const CLOSED = new Set(['cancelled', 'done']);

/** "Việc của tôi": everything in my projects that waits for me. Pure reads; rights come from can(). */
export function buildInbox(repo: Repo, userId: number): Inbox {
  const out: Inbox = { gates: [], crs: [], tasks: [], seats: [], projects: repo.listProjectsForUser(userId) };
  const u = repo.web.getUser(userId);
  if (!u || u.disabled) return out;
  const parked = new Set<string>();
  for (const j of repo.listJobs()) {
    if (j.status === 'paused' && j.requestId && (j.payload as JobPayload).awaitSeat === userId) parked.add(j.requestId);
  }
  for (const project of out.projects) {
    const roles = repo.getProjectMember(project.id, userId)?.roles ?? [];
    const actor = { userId, sysRole: u.sysRole, departmentId: u.departmentId, canBePm: u.canBePm, projectRoles: roles };
    for (const req of repo.listRequestsByProject(project.id)) {
      if (CLOSED.has(req.status)) continue;
      const item = { req, project };
      const mine = repo.listRequestAssignees(req.id).filter(a => a.userId === userId).map(a => a.role);
      if (req.status === 'awaiting_approval') {
        if (req.stage === 'CHANGE') {
          const ids = repo.listChangeRequests(req.id).filter(c => c.status === 'awaiting_decision').map(c => c.id);
          if (ids.length && can(actor, 'cr.decide', { project })) out.crs.push({ ...item, crIds: ids });
        } else if (Object.hasOwn(GATE_APPROVER, req.stage) && can(actor, { type: 'gate.approve', stage: req.stage }, { project, requestRoles: mine })) {
          out.gates.push({ ...item, stageLabelKey: req.stage });
        }
      }
      if (parked.has(req.id)) out.seats.push(item);
      for (const t of repo.listTasks(req.id)) {
        if (t.assigneeId === userId && t.scopeStatus === 'active' && t.status !== 'done') out.tasks.push({ ...item, task: t });
      }
    }
  }
  return out;
}
