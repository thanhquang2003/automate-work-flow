import { PROJECT_ROLES, SYS_ROLES, type ProjectRole, type Stage, type SysRole } from '../domain/types.js';

/** Who is acting. `projectRoles` are the actor's roles in `ctx.project` (empty when not a member / no project). */
export interface Actor {
  userId: number;
  sysRole: SysRole;
  departmentId: number | null;
  canBePm: boolean;
  projectRoles: ProjectRole[];
}

export interface Ctx {
  /** The project the action targets. */
  project?: { departmentId: number | null };
  /** The user an admin/department action targets. */
  targetUser?: { departmentId: number | null; sysRole?: SysRole };
  /** For `user.setDepartment`: the department the user is being moved to. */
  targetDepartmentId?: number | null;
  /** For `project.members.edit`: department of every user in the proposed member list. */
  memberDepartmentIds?: (number | null)[];
  /** Roles the actor holds on the specific request (assignees). Defaults to the project roles. */
  requestRoles?: ProjectRole[];
}

export type Action =
  | 'project.create' | 'project.members.edit' | 'request.create' | 'task.assign' | 'cr.decide'
  | 'user.setCanBePm' | 'user.setSysRole' | 'user.setDepartment'
  | 'oversight.view' | 'oversight.content' | 'admin.settings'
  | { type: 'gate.approve'; stage: Stage; part?: string };

/**
 * Role whose assignees may approve each gate. `null` = PM only (PLANNING, DONE, CHANGE).
 * Stages absent from the map (INTAKE, TEST, BUGFIX) have no approval gate: nobody can approve them.
 */
export const GATE_APPROVER: Partial<Record<Stage, ProjectRole | null>> = {
  CODEBASE_SCAN: 'SE', ANALYSIS: 'BA', CLARIFY: 'BA', BREAKDOWN: 'BA', DESIGN: 'SE',
  PLANNING: null, DEVELOP: 'REVIEWER', CHANGE: null, DONE: null,
};

const validSys = (r: unknown): r is SysRole => (SYS_ROLES as readonly string[]).includes(r as string);
const validRoles = (rs: unknown): ProjectRole[] =>
  Array.isArray(rs) ? rs.filter((r): r is ProjectRole => (PROJECT_ROLES as readonly string[]).includes(r as string)) : [];

/** A user can join a project only if they have a department and it is the project's department. */
export function canBeProjectMember(userDepartmentId: number | null, projectDepartmentId: number | null): boolean {
  return userDepartmentId !== null && projectDepartmentId !== null && userDepartmentId === projectDepartmentId;
}

/** Pure, server-side permission check. Unknown roles or actions deny. */
export function can(actor: Actor, action: Action, ctx: Ctx = {}): boolean {
  if (!actor || !validSys(actor.sysRole)) return false;
  const sys = actor.sysRole;
  const roles = validRoles(actor.projectRoles);
  const isPm = roles.includes('PM');
  const manager = sys === 'head' || sys === 'deputy';
  const ownDept = (d: number | null | undefined) => actor.departmentId !== null && d === actor.departmentId;
  const type = typeof action === 'string' ? action : action.type;

  switch (type) {
    case 'project.create':
      return actor.canBePm && actor.departmentId !== null;
    case 'project.members.edit': {
      if (!isPm) return false;
      const pd = ctx.project?.departmentId ?? null;
      return (ctx.memberDepartmentIds ?? []).every(d => canBeProjectMember(d, pd));
    }
    case 'request.create':
    case 'task.assign':
      return isPm;
    case 'cr.decide':
      return isPm;
    case 'gate.approve': {
      if (typeof action === 'string') return false;
      if (!Object.hasOwn(GATE_APPROVER, action.stage)) return false;
      if (isPm) return true;
      const approver = GATE_APPROVER[action.stage];
      if (!approver) return false;
      const held = ctx.requestRoles ? roles.filter(r => ctx.requestRoles!.includes(r)) : roles;
      return held.includes(approver);
    }
    case 'user.setSysRole':
    case 'admin.settings':
      return sys === 'admin';
    case 'user.setCanBePm':
      if (sys === 'admin') return true;
      return manager && ownDept(ctx.targetUser?.departmentId);
    case 'user.setDepartment':
      if (sys === 'admin') return true;
      // head/deputy only pull unassigned users into their own department
      return manager && ctx.targetUser?.departmentId === null && ctx.targetUser.sysRole === 'member' && ownDept(ctx.targetDepartmentId);
    case 'oversight.view':
    case 'oversight.content': {
      if (sys === 'admin' || sys === 'cto') return true;
      if (!manager || actor.departmentId === null) return false;
      const target = ctx.project ? ctx.project.departmentId : ctx.targetUser ? ctx.targetUser.departmentId : undefined;
      return target === undefined ? true : ownDept(target);
    }
    default:
      return false;
  }
}
