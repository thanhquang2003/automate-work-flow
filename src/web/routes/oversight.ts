import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { ProjectRow } from '../../domain/types.js';
import { ContentError, listRequestLogs, readProjectFile, readRequestLog } from '../../oversight/content.js';
import { listBlockers, listForActor, listPeopleWork, projectForActor, projectProgress } from '../../oversight/summary.js';
import { can, type Actor } from '../../security/permissions.js';
import { actorOf, forbidPage } from '../authz.js';
import type { WebDeps } from '../server.js';
import { render, type LayoutData } from '../view.js';

/**
 * Read-only oversight area for cto, head/deputy (own department) and admin. GET routes only: nothing under
 * /oversight accepts a write. Department scope is applied in listForActor and again on every :id route (404, not
 * 403, for a project outside the actor's scope so its existence is not leaked).
 */
export function oversightRoutes(app: FastifyInstance, cfg: Config, { repo, seatRunner }: WebDeps): void {
  const layout = (req: FastifyRequest, title: string): LayoutData => ({ user: req.user, mode: cfg.mode, title });
  const html = (reply: FastifyReply, s: string, code = 200) =>
    reply.code(code).header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').type('text/html; charset=utf-8').send(s);
  const notFound = (req: FastifyRequest, reply: FastifyReply) =>
    html(reply, render('error', layout(req, 'Không tìm thấy'), { code: 404, message: 'Không tìm thấy trang yêu cầu.' }), 404);

  /** Server mode only; the actor must hold oversight.view (member and every other role get 403). */
  const actorFor = (req: FastifyRequest): Actor | undefined => {
    if (cfg.mode !== 'server') return undefined;
    const a = actorOf(repo, req.user);
    return a && can(a, 'oversight.view') ? a : undefined;
  };
  const gate = async (req: FastifyRequest, reply: FastifyReply): Promise<Actor | undefined> => {
    const a = actorFor(req);
    if (!a) { await forbidPage(cfg, req, reply); return undefined; }
    return a;
  };
  const projectOf = async (req: FastifyRequest, reply: FastifyReply, content = false): Promise<{ actor: Actor; project: ProjectRow } | undefined> => {
    const actor = await gate(req, reply);
    if (!actor) return undefined;
    const project = projectForActor(repo, actor, Number((req.params as { id: string }).id));
    if (!project || (content && !can(actor, 'oversight.content', { project: { departmentId: project.departmentId } }))) { await notFound(req, reply); return undefined; }
    return { actor, project };
  };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const contentFail = (req: FastifyRequest, reply: FastifyReply, e: unknown) => {
    if (!(e instanceof ContentError)) throw e;
    if (e.code === 'bad_path' || e.code === 'bad_ref') return html(reply, render('error', layout(req, 'Yêu cầu không hợp lệ'), { code: 400, message: e.message }), 400);
    return notFound(req, reply); // not_found and forbidden look the same: a secret file is not even confirmed to exist
  };

  app.get('/oversight', async (req, reply) => {
    if (!(await gate(req, reply))) return;
    return reply.redirect('/oversight/projects');
  });

  app.get('/oversight/projects', async (req, reply) => {
    const actor = await gate(req, reply);
    if (!actor) return;
    return html(reply, render('oversight-projects', layout(req, 'Giám sát: dự án'), { projects: listForActor(repo, actor).projects }));
  });

  app.get('/oversight/users', async (req, reply) => {
    const actor = await gate(req, reply);
    if (!actor) return;
    const { users, projects } = listForActor(repo, actor);
    const seat: Record<number, boolean | undefined> = {};
    // connected yes/no only; credentials and account details never leave the seat runner
    if (seatRunner && seatRunner.kind !== 'local') {
      await Promise.all(users.map(async u => { seat[u.id] = await seatRunner.status(u.id).then(s => s.state === 'connected', () => false); }));
    }
    const people = listPeopleWork(repo, users, projects.map(p => repo.getProject(p.id)!));
    return html(reply, render('oversight-users', layout(req, 'Giám sát: người dùng'), { people, seat }));
  });

  app.get('/oversight/blockers', async (req, reply) => {
    const actor = await gate(req, reply);
    if (!actor) return;
    const projects = listForActor(repo, actor).projects.map(p => repo.getProject(p.id)!);
    return html(reply, render('oversight-blockers', layout(req, 'Giám sát: điểm nghẽn'), { blockers: listBlockers(repo, projects) }));
  });

  app.get('/oversight/projects/:id', async (req, reply) => {
    const r = await projectOf(req, reply);
    if (!r) return;
    return html(reply, render('oversight-project', layout(req, `Giám sát: ${r.project.key}`), {
      project: r.project, department: repo.web.getDepartment(r.project.departmentId)?.name ?? '',
      progress: projectProgress(repo, r.project), blockers: listBlockers(repo, [r.project]),
      canContent: can(r.actor, 'oversight.content', { project: { departmentId: r.project.departmentId } }),
    }));
  });

  app.get('/oversight/projects/:id/files', async (req, reply) => {
    const r = await projectOf(req, reply, true);
    if (!r) return;
    const q = req.query as Record<string, unknown>;
    const ref = str(q.ref) || r.project.defaultBranch;
    const path = str(q.path);
    try {
      const result = await readProjectFile(r.project, ref, path, { repo, userId: r.actor.userId });
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      return html(reply, render('oversight-content', layout(req, 'Mã nguồn'), { mode: 'files', project: r.project, heading: 'mã nguồn', ref, path, parent, result }));
    } catch (e) { return contentFail(req, reply, e); }
  });

  app.get('/oversight/projects/:id/docs', async (req, reply) => {
    const r = await projectOf(req, reply, true);
    if (!r) return;
    const docs = repo.listRequestsByProject(r.project.id).filter(x => x.code).map(x => ({ code: x.code!, ref: `devflow/${x.code}`, path: `docs/devflow/${x.code}` }));
    return html(reply, render('oversight-content', layout(req, 'Tài liệu'), { mode: 'docs', project: r.project, heading: 'tài liệu', docs }));
  });

  app.get('/oversight/projects/:id/logs', async (req, reply) => {
    const r = await projectOf(req, reply, true);
    if (!r) return;
    const q = req.query as Record<string, unknown>;
    const ctx = { repo, userId: r.actor.userId };
    try {
      if (str(q.code) && str(q.file)) {
        const log = await readRequestLog(r.project, str(q.code), str(q.file), ctx);
        return html(reply, render('oversight-content', layout(req, 'Log'), { mode: 'log', project: r.project, heading: 'log', code: str(q.code), file: str(q.file), ...log }));
      }
      const logs: { code: string; files: { name: string; size: number }[] }[] = [];
      for (const x of repo.listRequestsByProject(r.project.id)) {
        if (x.code) logs.push({ code: x.code, files: await listRequestLogs(r.project, x.code, ctx).catch(() => []) });
      }
      return html(reply, render('oversight-content', layout(req, 'Log'), { mode: 'logs', project: r.project, heading: 'log', logs }));
    } catch (e) { return contentFail(req, reply, e); }
  });
}
