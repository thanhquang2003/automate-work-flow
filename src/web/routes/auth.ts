import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { hashPassword, verifyPassword } from '../../security/crypto.js';
import { COOKIE, setSessionCookie } from '../auth.js';
import type { WebDeps } from '../server.js';
import { render } from '../view.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const DUMMY_HASH = hashPassword('devflow-dummy-password');

type Form = Record<string, string | undefined>;

export function authRoutes(app: FastifyInstance, cfg: Config, { repo }: WebDeps): void {
  const fails = new Map<string, number[]>();
  const page = (view: string, title: string, data: Record<string, unknown> = {}) => render(view, { mode: cfg.mode, title, flash: data.error as string | undefined }, data);

  app.get('/login', async (_req, reply) => {
    if (cfg.mode === 'local') return reply.redirect('/');
    return reply.type('text/html; charset=utf-8').send(page('login', 'Đăng nhập'));
  });
  app.post('/login', async (req, reply) => {
    if (cfg.mode === 'local') return reply.redirect('/');
    const b = (req.body ?? {}) as Form;
    const name = (b.username ?? '').trim();
    const key = `${req.ip}|${name.toLowerCase()}`;
    const now = Date.now();
    const recent = (fails.get(key) ?? []).filter(t => now - t < WINDOW_MS);
    if (recent.length >= MAX_FAILS) {
      return reply.code(429).type('text/html; charset=utf-8').send(page('login', 'Đăng nhập', { error: 'Quá nhiều lần đăng nhập sai, thử lại sau' }));
    }
    const u = repo.getUserByUsername(name);
    const okPw = verifyPassword(b.password ?? '', u ? u.passwordHash : DUMMY_HASH);
    if (!u || !okPw) {
      recent.push(now);
      fails.set(key, recent);
      return reply.code(401).type('text/html; charset=utf-8').send(page('login', 'Đăng nhập', { error: 'Sai tên đăng nhập hoặc mật khẩu.' }));
    }
    fails.delete(key);
    setSessionCookie(cfg, reply, u);
    return reply.redirect('/');
  });
  app.post('/logout', async (_req, reply) => {
    void reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect(cfg.mode === 'server' ? '/login' : '/');
  });

  app.get('/setup', async (_req, reply) => {
    if (cfg.mode === 'local' || repo.listUsers().length > 0) return reply.redirect('/');
    return reply.type('text/html; charset=utf-8').send(page('setup', 'Thiết lập quản trị viên'));
  });
  app.post('/setup', async (req, reply) => {
    if (cfg.mode === 'local' || repo.listUsers().length > 0) return reply.redirect('/');
    const b = (req.body ?? {}) as Form;
    const username = (b.username ?? '').trim();
    const password = b.password ?? '';
    if (!/^[\w.@-]{3,64}$/.test(username) || password.length < 8) {
      return reply.code(400).type('text/html; charset=utf-8').send(page('setup', 'Thiết lập quản trị viên', { error: 'Tên đăng nhập 3-64 ký tự (chữ, số, . _ - @) và mật khẩu tối thiểu 8 ký tự.' }));
    }
    const u = repo.createUser({ username, passwordHash: hashPassword(password), role: 'admin' });
    setSessionCookie(cfg, reply, u);
    return reply.redirect('/');
  });
}
