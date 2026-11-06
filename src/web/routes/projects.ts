import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import { PROJECT_ROLES, type ProjectRole, type ProjectRow, type SoftwareType } from '../../domain/types.js';
import { safeWriteFile } from '../../engine/safe-fs.js';
import { Workspace } from '../../engine/workspace.js';
import { PermissionError, ProjectError } from '../../projects/service.js';
import { can } from '../../security/permissions.js';
import { actorOf, auditWeb, forbidPage, statusOfError } from '../authz.js';
import type { WebDeps } from '../server.js';
import { render, type LayoutData } from '../view.js';
import { cleanName } from './requests.js';

const SOFTWARE_TYPES: SoftwareType[] = ['web', 'mobile', 'api', 'background'];
type Body = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '').trim();
const many = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

export function projectRoutes(app: FastifyInstance, cfg: Config, { repo, pipeline, projects }: WebDeps): void {
  const svc = projects!;
  const layout = (req: FastifyRequest, title: string, extra: Partial<LayoutData> = {}): LayoutData => ({ user: req.user, mode: cfg.mode, title, ...extra });
  const html = (reply: FastifyReply, s: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(s);
  const flashOf = (req: FastifyRequest): Partial<LayoutData> => {
    const q = req.query as { ok?: string; err?: string };
    return { flash: q.err ?? q.ok, flashKind: q.err ? 'error' : 'ok' };
  };
  const go = (reply: FastifyReply, path: string, kind: 'ok' | 'err', msg: string) => reply.redirect(`${path}?${kind}=${encodeURIComponent(msg.slice(0, 300))}`);
  const nameOf = (id: number): string => { const u = repo.web.getUser(id); return u ? (u.displayName || u.email || u.username) : `#${id}`; };
  /** The project, only for its members (admin/cto/head oversight views come with the oversight area). */
  const member = (req: FastifyRequest, id: number): { project: ProjectRow; roles: ProjectRole[] } | undefined => {
    const project = repo.getProject(id);
    const actor = actorOf(repo, req.user, id);
    if (!project || !actor || actor.projectRoles.length === 0) return undefined;
    return { project, roles: actor.projectRoles };
  };
  const idOf = (req: FastifyRequest): number => Number((req.params as { id: string }).id);
  const denied = (req: FastifyRequest, reply: FastifyReply, e: unknown) =>
    statusOfError(e) === 403
      ? forbidPage(cfg, req, reply, (e as Error).message)
      : html(reply, render('error', layout(req, 'Lỗi'), { code: statusOfError(e), message: (e as Error).message }), statusOfError(e));

  // ---- list ----
  app.get('/projects', async (req, reply) => {
    const uid = req.user?.id;
    const rows = uid == null ? [] : repo.listProjectsForUser(uid).map(p => ({ ...p, requests: repo.listRequestsByProject(p.id).length }));
    const a = actorOf(repo, req.user);
    return html(reply, render('projects', layout(req, 'Dự án', flashOf(req)), { rows, canCreate: !!a && can(a, 'project.create') }));
  });

  // ---- create ----
  app.get('/projects/new', async (req, reply) => {
    const a = actorOf(repo, req.user);
    if (!a || !can(a, 'project.create')) return forbidPage(cfg, req, reply, 'Chỉ PM (được phòng cho phép) mới tạo được dự án.');
    return html(reply, render('project-new', layout(req, 'Tạo dự án'), { form: {}, roots: cfg.projectRoots }));
  });

  app.post('/projects', async (req, reply) => {
    const a = actorOf(repo, req.user);
    if (!a || !can(a, 'project.create')) return forbidPage(cfg, req, reply, 'Chỉ PM (được phòng cho phép) mới tạo được dự án.');
    const b = (req.body ?? {}) as Body;
    const form = { key: one(b.key).toUpperCase(), name: one(b.name), mode: one(b.mode) || 'new', path: one(b.path), gitlab_project: one(b.gitlab_project) };
    try {
      const p = await svc.createProject({
        mode: form.mode as 'existing' | 'clone' | 'new', key: form.key, name: form.name, path: form.path,
        gitlabProject: form.gitlab_project || null, createdBy: a.userId,
      });
      return reply.redirect(`/projects/${p.id}`);
    } catch (e) {
      if (e instanceof PermissionError) return forbidPage(cfg, req, reply, e.message);
      if (e instanceof ProjectError) return html(reply, render('project-new', layout(req, 'Tạo dự án', { flash: e.message, flashKind: 'error' }), { form, roots: cfg.projectRoots }), 400);
      throw e;
    }
  });

  // ---- project page ----
  app.get('/projects/:id', async (req, reply) => {
    const m = member(req, idOf(req));
    if (!m) return forbidPage(cfg, req, reply, 'Bạn không phải thành viên của dự án này.');
    const { project, roles } = m;
    const isPm = roles.includes('PM');
    const members = repo.listProjectMembers(project.id);
    const inProject = new Set(members.map(x => x.userId));
    // Only people of the project's department can join; people without a department are never offered.
    const candidates = repo.web.listUsersByDepartment(project.departmentId).filter(u => !u.disabled || inProject.has(u.id));
    const rows = candidates.map(u => ({ id: u.id, name: nameOf(u.id), email: u.email ?? u.username, roles: members.find(x => x.userId === u.id)?.roles ?? [] }));
    const requests = repo.listRequestsByProject(project.id).sort((x, y) => y.createdAt - x.createdAt);
    return html(reply, render('project', layout(req, `${project.key} - ${project.name}`, flashOf(req)), {
      project, isPm, rows, requests, ROLES: PROJECT_ROLES, myRoles: roles,
      department: repo.web.getDepartment(project.departmentId)?.name ?? '',
    }));
  });

  app.post('/projects/:id/members', async (req, reply) => {
    const id = idOf(req);
    const m = member(req, id);
    if (!m) return forbidPage(cfg, req, reply, 'Bạn không phải thành viên của dự án này.');
    if (!m.roles.includes('PM')) return forbidPage(cfg, req, reply, 'Chỉ PM của dự án được sửa thành viên.');
    const b = (req.body ?? {}) as Body;
    const list: { userId: number; roles: ProjectRole[] }[] = [];
    for (const [k, v] of Object.entries(b)) {
      const mm = /^r_(\d{1,9})$/.exec(k);
      if (!mm) continue;
      const roles = many(v).filter((r): r is ProjectRole => (PROJECT_ROLES as readonly string[]).includes(r));
      if (roles.length) list.push({ userId: Number(mm[1]), roles });
    }
    try {
      await svc.setMembers(id, list, req.user!.id!);
    } catch (e) {
      if (e instanceof PermissionError || e instanceof ProjectError) return statusOfError(e) === 403 ? forbidPage(cfg, req, reply, e.message) : go(reply, `/projects/${id}`, 'err', e.message);
      throw e;
    }
    return go(reply, `/projects/${id}`, 'ok', 'Đã lưu thành viên và vai trò.');
  });

  // ---- new request ----
  const newRequestPage = (req: FastifyRequest, reply: FastifyReply, project: ProjectRow, form: Record<string, unknown>, extra: Partial<LayoutData> = {}, code = 200) => {
    const members = repo.listProjectMembers(project.id);
    const blocks = PROJECT_ROLES.map(role => ({
      role, people: members.filter(x => x.roles.includes(role)).map(x => ({ id: x.userId, name: nameOf(x.userId) })),
    }));
    return html(reply, render('project-request-new', layout(req, 'Tạo yêu cầu mới', extra), {
      project, form, SOFTWARE_TYPES, blocks, suggestion: repo.suggestRequestCode(project.id),
    }), code);
  };

  app.get('/projects/:id/requests/new', async (req, reply) => {
    const m = member(req, idOf(req));
    if (!m) return forbidPage(cfg, req, reply, 'Bạn không phải thành viên của dự án này.');
    if (!m.roles.includes('PM')) return forbidPage(cfg, req, reply, 'Chỉ PM của dự án được tạo yêu cầu.');
    return newRequestPage(req, reply, m.project, {});
  });

  app.post('/projects/:id/requests', async (req, reply) => {
    const id = idOf(req);
    const m = member(req, id);
    if (!m) return forbidPage(cfg, req, reply, 'Bạn không phải thành viên của dự án này.');
    if (!m.roles.includes('PM')) return forbidPage(cfg, req, reply, 'Chỉ PM của dự án được tạo yêu cầu.');
    if (!req.isMultipart()) return html(reply, render('error', layout(req, 'Lỗi'), { code: 400, message: 'Biểu mẫu phải gửi dạng multipart.' }), 400);
    const fields: Record<string, string[]> = {};
    const tmpDir = join(resolve(cfg.dataDir), 'tmp', randomBytes(8).toString('hex'));
    mkdirSync(tmpDir, { recursive: true });
    const saved: { name: string; tmp: string; size: number }[] = [];
    let tooLarge = false;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') (fields[part.fieldname] ??= []).push(String(part.value));
        else {
          if (!part.filename) { part.file.resume(); continue; }
          const tmp = join(tmpDir, `${saved.length}`);
          await streamPipeline(part.file, createWriteStream(tmp));
          if (part.file.truncated) { tooLarge = true; continue; }
          saved.push({ name: cleanName(part.filename), tmp, size: statSync(tmp).size });
        }
      }
      const f = (k: string) => (fields[k]?.[0] ?? '').trim();
      const form = {
        code: f('code'), title: f('title'), description: f('description'), perf_req: f('perf_req'), nonfunc_req: f('nonfunc_req'),
        run_mode: f('run_mode') || 'review',
        software_types: (fields.software_types ?? []).filter((t): t is SoftwareType => (SOFTWARE_TYPES as string[]).includes(t)),
      };
      const bad = tooLarge ? 'Tệp đính kèm vượt quá 50MB.'
        : !form.title ? 'Vui lòng nhập tiêu đề.'
        : !form.description ? 'Vui lòng nhập mô tả yêu cầu.'
        : !['auto', 'review'].includes(form.run_mode) ? 'Chế độ chạy không hợp lệ.' : '';
      if (bad) return newRequestPage(req, reply, m.project, form, { flash: bad, flashKind: 'error' }, tooLarge ? 413 : 400);
      // Per role: the ticked people in page order; the "runner" radio moves one to the front.
      const assignees: Partial<Record<ProjectRole, number[]>> = {};
      for (const role of PROJECT_ROLES) {
        let ids = (fields[`a_${role}`] ?? []).map(Number).filter(n => Number.isInteger(n) && n > 0);
        const runner = Number(f(`runner_${role}`));
        if (ids.includes(runner)) ids = [runner, ...ids.filter(x => x !== runner)];
        if (ids.length) assignees[role] = ids;
      }
      let row;
      try {
        row = await svc.createRequest({
          projectId: id, code: form.code, title: form.title, description: form.description, perfReq: form.perf_req, nonfuncReq: form.nonfunc_req,
          softwareTypes: form.software_types, runMode: form.run_mode as 'auto' | 'review', assignees, by: req.user!.id!,
        });
      } catch (e) {
        if (e instanceof PermissionError) return forbidPage(cfg, req, reply, e.message);
        if (e instanceof ProjectError) return newRequestPage(req, reply, m.project, form, { flash: e.message, flashKind: 'error' }, 400);
        throw e;
      }
      const ws = Workspace.forRequest(cfg, repo, row).ensure();
      const used = new Set<string>();
      for (const s of saved) {
        let name = s.name;
        for (let i = 2; used.has(name); i++) name = `${i}_${s.name}`;
        used.add(name);
        const dest = join(ws.inputsDir, name);
        safeWriteFile(dest, readFileSync(s.tmp));
        repo.addAttachment(row.id, name, dest, s.size);
      }
      pipeline.start(row.id);
      return reply.redirect(`/requests/${row.id}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  void denied; void auditWeb;
}
