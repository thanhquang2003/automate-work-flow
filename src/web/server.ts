import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { SeatRunner } from '../claude/seat-runner.js';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Pipeline } from '../engine/pipeline.js';
import { wireProjects } from '../projects/wire.js';
import type { ProjectService } from '../projects/service.js';
import { currentUser, isLocalHostHeader, sameOrigin } from './auth.js';
import type { OidcClient } from './oidc.js';
import { adminRoutes } from './routes/admin.js';
import { adminUserRoutes } from './routes/admin-users.js';
import { projectRoutes } from './routes/projects.js';
import { seatRoutes } from './routes/seat.js';
import { authRoutes } from './routes/auth.js';
import { changeRoutes } from './routes/changes.js';
import { questionRoutes } from './routes/questions.js';
import { requestRoutes } from './routes/requests.js';
import { surveyRoutes } from './routes/survey.js';
import { ROOT, render } from './view.js';

export interface SystemOpsLike { provisionUser(userId: number): Promise<void> | void }
export interface WebDeps {
  repo: Repo; pipeline: Pipeline; oidc?: OidcClient; systemOps?: SystemOpsLike;
  /** v3 (Task 4): seat runner for the "Claude của tôi" page (login/status/logout); used by Task 6. */
  seatRunner?: SeatRunner;
  /** v3 (Task 6): project service joined to the pipeline (index.ts). Built here with no-op system ops when absent. */
  projects?: ProjectService;
}

const PUBLIC_PREFIXES = ['/static/', '/s/'];
const PUBLIC_PATHS = ['/login', '/login/local', '/setup', '/auth/google', '/auth/google/callback'];
const MAX_UPLOAD = 50 * 1024 * 1024;

export async function buildServer(cfg: Config, deps: WebDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: cfg.trustProxy as boolean, /* hop count is supported at runtime by proxy-addr */ bodyLimit: 210 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: cfg.maxUploadBytes ?? MAX_UPLOAD, files: 30, fields: 50 } });
  await app.register(fastifyStatic, { root: `${ROOT}public`, prefix: '/static/' });

  const server = cfg.mode === 'server';

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    const isPublic = PUBLIC_PREFIXES.some(p => path.startsWith(p)) || PUBLIC_PATHS.includes(path);
    // Local mode has no login: a page on another site that rebinds its DNS name to 127.0.0.1 must not reach us.
    if (!server && !isLocalHostHeader(req.headers.host, cfg.host)) {
      return reply.code(403).type('text/html; charset=utf-8').send(render('error', { mode: cfg.mode, title: 'Bị từ chối' }, { code: 403, message: 'Yêu cầu bị từ chối (tên máy không hợp lệ).' }));
    }
    if (req.method === 'POST' && !path.startsWith('/s/') && !sameOrigin(req, server, cfg.publicBaseUrl)) {
      return reply.code(403).type('text/html; charset=utf-8').send(render('error', { mode: cfg.mode, title: 'Bị từ chối' }, { code: 403, message: 'Yêu cầu bị từ chối (sai nguồn gốc).' }));
    }
    if (!server) { req.user = currentUser(cfg, deps.repo, req); return; }
    if (PUBLIC_PREFIXES.some(p => path.startsWith(p))) return;
    if (!cfg.google.clientId && deps.repo.web.listUsers().length === 0) { if (path !== '/setup') return reply.redirect('/setup'); return; }
    req.user = currentUser(cfg, deps.repo, req);
    if (!req.user && !isPublic) return reply.redirect('/login');
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).type('text/html; charset=utf-8').send(render('error', { user: req.user, mode: cfg.mode, title: 'Không tìm thấy' }, { code: 404, message: 'Không tìm thấy trang yêu cầu.' }));
  });
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const code = err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    const message = code === 413 ? 'Tệp đính kèm vượt quá 50MB.' : code >= 500 ? 'Lỗi máy chủ nội bộ.' : err.message;
    if (code >= 500) console.error(err);
    reply.code(code).type('text/html; charset=utf-8').send(render('error', { user: req.user, mode: cfg.mode, title: 'Lỗi' }, { code, message }));
  });

  // One ProjectService joined to the pipeline both ways (index.ts passes its own with the real system ops).
  const projects = deps.projects ?? wireProjects({ cfg, repo: deps.repo, pipeline: deps.pipeline });
  const d: WebDeps = { ...deps, projects };
  authRoutes(app, cfg, d);
  requestRoutes(app, cfg, d);
  changeRoutes(app, cfg, d);
  questionRoutes(app, cfg, d);
  adminRoutes(app, cfg, d);
  projectRoutes(app, cfg, d);
  seatRoutes(app, cfg, d);
  adminUserRoutes(app, cfg, d);
  surveyRoutes(app, cfg, deps);
  return app;
}
