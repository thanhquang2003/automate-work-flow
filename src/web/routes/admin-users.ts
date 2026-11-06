import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import { SYS_ROLES, type SysRole, type UserRow } from '../../domain/types.js';
import { can, type Action, type Ctx } from '../../security/permissions.js';
import { actorOf, auditWeb, forbidPage } from '../authz.js';
import type { WebDeps } from '../server.js';
import { render, type LayoutData } from '../view.js';

type Body = Record<string, string | undefined>;

/** Admin users page and the "PM của phòng" page of head/deputy. Every write: can(...) then audit_log. */
export function adminUserRoutes(app: FastifyInstance, cfg: Config, { repo, pipeline, projects }: WebDeps): void {
  const layout = (req: FastifyRequest, title: string, extra: Partial<LayoutData> = {}): LayoutData => ({ user: req.user, mode: cfg.mode, title, ...extra });
  const html = (reply: FastifyReply, s: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(s);
  const flashOf = (req: FastifyRequest): Partial<LayoutData> => {
    const q = req.query as { ok?: string; err?: string };
    return { flash: q.err ?? q.ok, flashKind: q.err ? 'error' : 'ok' };
  };
  const go = (reply: FastifyReply, path: string, kind: 'ok' | 'err', msg: string) => reply.redirect(`${path}?${kind}=${encodeURIComponent(msg.slice(0, 300))}`);
  const targetOf = (req: FastifyRequest): UserRow | undefined => repo.web.getUser(Number((req.params as { id: string }).id));
  const ctxOf = (u: UserRow): Ctx => ({ targetUser: { userId: u.id, departmentId: u.departmentId, sysRole: u.sysRole } });
  const isManager = (req: FastifyRequest): boolean => { const a = actorOf(repo, req.user); return !!a && (a.sysRole === 'head' || a.sysRole === 'deputy'); };
  const isAdmin = (req: FastifyRequest): boolean => { const a = actorOf(repo, req.user); return !!a && can(a, 'admin.settings'); };

  const row = (u: UserRow) => ({
    id: u.id, name: u.displayName || u.username, email: u.email ?? u.username, sysRole: u.sysRole, departmentId: u.departmentId,
    canBePm: u.canBePm, disabled: u.disabled,
  });

  // ---- admin: all users ----
  app.get('/admin/users', async (req, reply) => {
    if (!isAdmin(req)) return forbidPage(cfg, req, reply);
    return html(reply, render('admin-users', layout(req, 'Người dùng', flashOf(req)), {
      users: repo.web.listUsers().map(row), departments: repo.web.listDepartments(), SYS_ROLES,
    }));
  });

  /** Runs one admin write: permission via can(), then the change and an audit row. */
  const adminWrite = (name: string, action: Action, fn: (u: UserRow, b: Body, req: FastifyRequest) => string | Promise<string>) => {
    app.post(`/admin/users/:id/${name}`, async (req, reply) => {
      const a = actorOf(repo, req.user);
      const u = targetOf(req);
      if (!a || !u || !can(a, action, ctxOf(u))) return forbidPage(cfg, req, reply);
      let msg: string;
      try { msg = await fn(u, (req.body ?? {}) as Body, req); } catch (e) { return go(reply, '/admin/users', 'err', (e as Error).message); }
      return go(reply, '/admin/users', 'ok', msg);
    });
  };
  adminWrite('sys-role', 'user.setSysRole', (u, b, req) => {
    if (!(SYS_ROLES as readonly string[]).includes(b.sys_role ?? '')) throw new Error('Vai trò hệ thống không hợp lệ.');
    const role = b.sys_role as SysRole;
    if (u.sysRole === 'admin' && role !== 'admin' && repo.web.listUsers().filter(x => x.sysRole === 'admin' && !x.disabled).length <= 1) throw new Error('Không thể hạ quản trị viên cuối cùng.');
    // Department invariant (Global Constraints): cto/admin belong to no department and hold no project role;
    // head/deputy belong to exactly one department. Demoting to member keeps the department.
    const oversight = role === 'cto' || role === 'admin';
    if (oversight && repo.listProjects({ includeArchived: true }).some(p => repo.getProjectMember(p.id, u.id))) {
      throw new Error('Người này đang là thành viên dự án nên không thể chuyển sang CTO/quản trị viên; hãy gỡ khỏi các dự án trước.');
    }
    if ((role === 'head' || role === 'deputy') && u.departmentId === null) {
      throw new Error('Trưởng/phó phòng phải thuộc một phòng; hãy gán phòng cho người này trước.');
    }
    repo.tx(() => {
      repo.web.setUserSysRole(u.id, role);
      if (oversight && u.departmentId !== null) repo.web.setUserDepartment(u.id, null);
    });
    auditWeb(repo, req, 'user.setSysRole', { detail: { userId: u.id, from: u.sysRole, to: role, ...(oversight && u.departmentId !== null ? { departmentCleared: u.departmentId } : {}) } });
    return `Đã đổi vai trò của ${u.email ?? u.username}.`;
  });
  adminWrite('department', 'user.setDepartment', (u, b, req) => {
    const raw = (b.department_id ?? '').trim();
    const d = raw ? repo.web.getDepartment(Number(raw)) : undefined;
    if (raw && !d) throw new Error('Phòng không tồn tại.');
    if (!d && (u.sysRole === 'head' || u.sysRole === 'deputy')) throw new Error('Trưởng/phó phòng phải thuộc một phòng; hãy đổi vai trò trước khi gỡ phòng.');
    if (d && (u.sysRole === 'cto' || u.sysRole === 'admin')) throw new Error('CTO/quản trị viên không thuộc phòng nào.');
    // A project member must keep a department (the project's rule): an empty value must not bypass this.
    if ((d ? d.id : null) !== u.departmentId && repo.listProjects({ includeArchived: true }).some(p => repo.getProjectMember(p.id, u.id))) throw new Error('Người này đang là thành viên dự án nên không thể gỡ hoặc đổi phòng; hãy gỡ khỏi các dự án trước.');
    repo.web.setUserDepartment(u.id, d ? d.id : null);
    auditWeb(repo, req, 'user.setDepartment', { detail: { userId: u.id, departmentId: d?.id ?? null } });
    return `Đã đổi phòng của ${u.email ?? u.username}.`;
  });
  adminWrite('can-pm', 'user.setCanBePm', (u, b, req) => {
    const on = b.value === '1';
    repo.web.setUserCanBePm(u.id, on);
    auditWeb(repo, req, 'user.setCanBePm', { detail: { userId: u.id, canBePm: on } });
    return `Đã cập nhật quyền PM của ${u.email ?? u.username}.`;
  });
  adminWrite('disable', 'user.setSysRole', async (u, b, req) => {
    const off = b.value === '1';
    if (off && req.user?.id === u.id) throw new Error('Không thể tự khóa tài khoản đang đăng nhập.');
    if (off && u.sysRole === 'admin' && repo.web.listUsers().filter(x => x.sysRole === 'admin' && !x.disabled).length <= 1) throw new Error('Không thể khóa quản trị viên cuối cùng.');
    repo.web.setUserDisabled(u.id, off);
    auditWeb(repo, req, 'user.setDisabled', { detail: { userId: u.id, disabled: off } });
    let warn = '';
    if (cfg.mode === 'server') {
      // Like removing a member: the user's running jobs stop and move to the next person of each role (awaited)
      // BEFORE the Linux groups change; then the groups hold only enabled members (re-enabling adds them back).
      if (off) await pipeline.userDisabled(u.id);
      const failed = projects ? await projects.syncUserGroups(u.id) : [];
      for (const f of failed) console.error(`Không đồng bộ được nhóm Linux của dự án #${f.projectId}: ${f.error}`);
      if (failed.length) warn = ` Chưa cập nhật được nhóm Linux của ${failed.length} dự án (sẽ thử lại khi khởi động lại).`;
    }
    return `${off ? 'Đã khóa' : 'Đã mở khóa'} ${u.email ?? u.username}.${warn}`;
  });

  // ---- head/deputy: PM of own department ----
  app.get('/dept/pm', async (req, reply) => {
    const a = actorOf(repo, req.user);
    if (!a || !isManager(req) || a.departmentId === null) return forbidPage(cfg, req, reply);
    const own = repo.web.listUsersByDepartment(a.departmentId).map(row);
    const unassigned = repo.web.listUsers().filter(u => u.departmentId === null && u.sysRole === 'member' && !u.disabled).map(row);
    return html(reply, render('dept-pm', layout(req, 'PM của phòng', flashOf(req)), {
      own, unassigned, department: repo.web.getDepartment(a.departmentId)?.name ?? '',
    }));
  });

  app.post('/dept/pm/:id/can-pm', async (req, reply) => {
    const a = actorOf(repo, req.user);
    const u = targetOf(req);
    if (!a || !u || !can(a, 'user.setCanBePm', ctxOf(u))) return forbidPage(cfg, req, reply);
    const on = ((req.body ?? {}) as Body).value === '1';
    repo.web.setUserCanBePm(u.id, on);
    auditWeb(repo, req, 'user.setCanBePm', { detail: { userId: u.id, canBePm: on } });
    return go(reply, '/dept/pm', 'ok', `${on ? 'Đã cho phép' : 'Đã bỏ quyền'} làm PM: ${u.email ?? u.username}.`);
  });

  app.post('/dept/pm/:id/assign', async (req, reply) => {
    const a = actorOf(repo, req.user);
    const u = targetOf(req);
    if (!a || !u || u.disabled || a.departmentId === null || !can(a, 'user.setDepartment', { ...ctxOf(u), targetDepartmentId: a.departmentId })) return forbidPage(cfg, req, reply);
    repo.web.setUserDepartment(u.id, a.departmentId);
    auditWeb(repo, req, 'user.setDepartment', { detail: { userId: u.id, departmentId: a.departmentId } });
    return go(reply, '/dept/pm', 'ok', `Đã đưa ${u.email ?? u.username} vào phòng của bạn.`);
  });
}
