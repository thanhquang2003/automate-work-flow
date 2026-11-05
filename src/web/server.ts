import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { Pipeline } from '../engine/pipeline.js';
import { currentUser, sameOrigin } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { requestRoutes } from './routes/requests.js';
import { ROOT, render } from './view.js';

export interface WebDeps { repo: Repo; pipeline: Pipeline }

const PUBLIC_PREFIXES = ['/static/', '/s/'];
const PUBLIC_PATHS = ['/login', '/setup'];
const MAX_UPLOAD = 50 * 1024 * 1024;

export async function buildServer(cfg: Config, deps: WebDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 210 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: cfg.maxUploadBytes ?? MAX_UPLOAD, files: 30, fields: 50 } });
  await app.register(fastifyStatic, { root: `${ROOT}public`, prefix: '/static/' });

  const server = cfg.mode === 'server';

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    const isPublic = PUBLIC_PREFIXES.some(p => path.startsWith(p)) || PUBLIC_PATHS.includes(path);
    if (req.method === 'POST' && !path.startsWith('/s/') && !sameOrigin(req, server, cfg.publicBaseUrl)) {
      return reply.code(403).type('text/html; charset=utf-8').send(render('error', { mode: cfg.mode, title: 'Bị từ chối' }, { code: 403, message: 'Yêu cầu bị từ chối (sai nguồn gốc).' }));
    }
    if (!server) { req.user = currentUser(cfg, deps.repo, req); return; }
    if (PUBLIC_PREFIXES.some(p => path.startsWith(p))) return;
    if (deps.repo.listUsers().length === 0) { if (path !== '/setup') return reply.redirect('/setup'); return; }
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

  authRoutes(app, cfg, deps);
  requestRoutes(app, cfg, deps);
  return app;
}
