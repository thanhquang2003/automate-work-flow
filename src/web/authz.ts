import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { RequestRow } from '../domain/types.js';
import { PermissionError } from '../projects/service.js';
import { can, type Action, type Actor, type Ctx } from '../security/permissions.js';
import type { SessionUser } from './auth.js';
import { render, type LayoutData } from './view.js';

/** Actor for the logged-in user (fresh from the DB, so a disabled or demoted user loses rights at once). */
export function actorOf(repo: Repo, user: SessionUser | undefined, projectId?: number | null): Actor | undefined {
  if (!user || user.id === null) return undefined;
  const u = repo.web.getUser(user.id);
  if (!u || u.disabled) return undefined;
  const roles = projectId != null ? repo.getProjectMember(projectId, u.id)?.roles ?? [] : [];
  return { userId: u.id, sysRole: u.sysRole, departmentId: u.departmentId, canBePm: u.canBePm, projectRoles: roles };
}

/** What a request-level web action needs. */
export type Need = 'read' | 'member' | 'pm' | Action;

/**
 * Server-side check for one request. Local mode has no accounts and allows everything. A legacy request (no
 * project) can be read by any signed-in user but only changed by an admin. A project request needs membership;
 * writes need the matching right from can().
 */
export function allowedOnRequest(cfg: Config, repo: Repo, user: SessionUser | undefined, r: RequestRow, need: Need): boolean {
  if (cfg.mode === 'local') return true;
  if (!user) return false;
  if (r.projectId == null) {
    if (need === 'read') return true;
    return user.sysRole === 'admin' || user.role === 'admin';
  }
  const actor = actorOf(repo, user, r.projectId);
  const project = repo.getProject(r.projectId);
  if (!actor || !project) return false;
  if (actor.projectRoles.length === 0) return false;
  if (need === 'read' || need === 'member') return true;
  const ctx: Ctx = { project: { departmentId: project.departmentId } };
  if (need === 'pm') return can(actor, 'task.assign', ctx);
  if (typeof need === 'object' && need.type === 'gate.approve') {
    ctx.requestRoles = repo.listRequestAssignees(r.id).filter(a => a.userId === actor.userId).map(a => a.role);
  }
  return can(actor, need, ctx);
}

export const forbidPage = (cfg: Config, req: FastifyRequest, reply: FastifyReply, message = 'Bạn không có quyền thực hiện thao tác này.') => {
  const layout: LayoutData = { user: req.user, mode: cfg.mode, title: 'Bị từ chối' };
  return reply.code(403).type('text/html; charset=utf-8').send(render('error', layout, { code: 403, message }));
};

/** Maps errors thrown by the services to an HTTP status: 403 for rights, 409 for a stale click, 400 otherwise. */
export function statusOfError(e: unknown): number {
  if (e instanceof PermissionError) return 403;
  if (e instanceof Error && e.name === 'StaleActionError') return 409;
  return 400;
}

/** Writes one audit_log row for a web action (the user is the session user, null in local mode). */
export function auditWeb(repo: Repo, req: FastifyRequest, action: string, o: { projectId?: number | null; requestId?: string | null; detail?: unknown } = {}): void {
  repo.web.addAudit({
    projectId: o.projectId ?? null, requestId: o.requestId ?? null, userId: req.user?.id ?? null, action,
    ...(o.detail !== undefined ? { detail: JSON.stringify(o.detail) } : {}),
  });
}
