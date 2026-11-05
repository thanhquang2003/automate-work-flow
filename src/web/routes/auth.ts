import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { hashPassword, verifyPassword } from '../../security/crypto.js';
import { COOKIE, setSessionCookie } from '../auth.js';
import type { WebDeps } from '../server.js';
import { render } from '../view.js';

type Form = Record<string, string | undefined>;

export function authRoutes(app: FastifyInstance, cfg: Config, { repo }: WebDeps): void {
  const page = (view: string, title: string, data: Record<string, unknown> = {}) => render(view, { mode: cfg.mode, title, flash: data.error as string | undefined }, data);

  app.get('/login', async (_req, reply) => {
    if (cfg.mode === 'local') return reply.redirect('/');
    return reply.type('text/html; charset=utf-8').send(page('login', 'Đăng nhập'));
  });
  app.post('/login', async (req, reply) => {
    if (cfg.mode === 'local') return reply.redirect('/');
    const b = (req.body ?? {}) as Form;
    const u = repo.getUserByUsername((b.username ?? '').trim());
    // verify against a dummy hash when the user is unknown, to keep timing similar
    if (!u || !verifyPassword(b.password ?? '', u.passwordHash)) {
      return reply.code(401).type('text/html; charset=utf-8').send(page('login', 'Đăng nhập', { error: 'Sai tên đăng nhập hoặc mật khẩu.' }));
    }
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
