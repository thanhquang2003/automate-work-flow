import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import { hashPassword, verifyPassword } from '../../security/crypto.js';
import type { DepartmentCode } from '../../domain/types.js';
import { COOKIE, setSessionCookie, signBlob, verifyBlob } from '../auth.js';
import { googleOidcClient, newPkce } from '../oidc.js';
import type { WebDeps } from '../server.js';
import { render } from '../view.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const DUMMY_HASH = hashPassword('devflow-dummy-password');

type Form = Record<string, string | undefined>;

export function authRoutes(app: FastifyInstance, cfg: Config, deps: WebDeps): void {
  const { repo } = deps;
  const sso = cfg.mode === 'server' && cfg.google.clientId !== '';
  const breakglass = sso && cfg.breakglassAdmin !== '';
  const oidc = () => (deps.oidc ??= googleOidcClient(cfg));
  const fails = new Map<string, number[]>();
  const page = (view: string, title: string, data: Record<string, unknown> = {}) => render(view, { mode: cfg.mode, title, flash: data.error as string | undefined }, data);

  const loginPage = (error?: string) => page('login', 'Đăng nhập', { error, sso, breakglass });
  const deny = (reply: FastifyReply, code: number, message: string) =>
    reply.code(code).type('text/html; charset=utf-8').send(render('error', { mode: cfg.mode, title: 'Không đăng nhập được' }, { code, message }));

  app.get('/login', async (_req, reply) => {
    if (cfg.mode === 'local') return reply.redirect('/');
    return reply.type('text/html; charset=utf-8').send(loginPage());
  });

  const passwordLogin = async (req: FastifyRequest, reply: FastifyReply, view: 'login') => {
    const b = (req.body ?? {}) as Form;
    const name = (b.username ?? '').trim();
    const key = `${req.ip}|${name.toLowerCase()}`;
    const now = Date.now();
    const recent = (fails.get(key) ?? []).filter(t => now - t < WINDOW_MS);
    if (recent.length >= MAX_FAILS) {
      return reply.code(429).type('text/html; charset=utf-8').send(page(view, 'Đăng nhập', { error: 'Quá nhiều lần đăng nhập sai, thử lại sau', sso, breakglass }));
    }
    let u = repo.web.getUserByUsername(name);
    // With SSO on, only the configured break-glass admin may use a password.
    if (sso && (name !== cfg.breakglassAdmin || (u && (u.sysRole !== 'admin' || u.disabled)))) u = undefined;
    const okPw = verifyPassword(b.password ?? '', u ? u.passwordHash : DUMMY_HASH);
    if (!u || !okPw) {
      recent.push(now);
      fails.set(key, recent);
      return reply.code(401).type('text/html; charset=utf-8').send(page(view, 'Đăng nhập', { error: 'Sai tên đăng nhập hoặc mật khẩu.', sso, breakglass }));
    }
    fails.delete(key);
    setSessionCookie(cfg, reply, u);
    return reply.redirect('/');
  };

  app.post('/login', async (req, reply) => {
    if (cfg.mode === 'local') return reply.redirect('/');
    if (sso) return reply.callNotFound();
    return passwordLogin(req, reply, 'login');
  });
  app.get('/login/local', async (_req, reply) => {
    if (!breakglass) return reply.callNotFound();
    return reply.type('text/html; charset=utf-8').send(page('login-local', 'Đăng nhập quản trị khẩn cấp'));
  });
  app.post('/login/local', async (req, reply) => {
    if (!breakglass) return reply.callNotFound();
    return passwordLogin(req, reply, 'login');
  });

  // ---- Google SSO ----
  const OIDC_COOKIE = 'devflow_oidc';
  const OIDC_TTL = 10 * 60 * 1000;
  const redirectUri = () => `${cfg.publicBaseUrl.replace(/\/+$/, '')}/auth/google/callback`;

  app.get('/auth/google', async (_req, reply) => {
    if (!sso) return reply.callNotFound();
    const p = await newPkce();
    void reply.setCookie(OIDC_COOKIE, signBlob(cfg.secretKey, { state: p.state, nonce: p.nonce, verifier: p.verifier }, OIDC_TTL), {
      httpOnly: true, sameSite: 'lax', path: '/auth/google', secure: cfg.publicBaseUrl.startsWith('https'), maxAge: OIDC_TTL / 1000,
    });
    const url = await oidc().authUrl({ redirectUri: redirectUri(), state: p.state, nonce: p.nonce, codeChallenge: p.challenge });
    return reply.redirect(url);
  });

  app.get('/auth/google/callback', async (req, reply) => {
    if (!sso) return reply.callNotFound();
    const saved = verifyBlob<{ state: string; nonce: string; verifier: string }>(cfg.secretKey, req.cookies?.[OIDC_COOKIE]);
    void reply.clearCookie(OIDC_COOKIE, { path: '/auth/google' });
    const q = req.query as Record<string, string | undefined>;
    if (!saved || !q.state || q.state !== saved.state || q.error || !q.code) {
      return deny(reply, 400, 'Phiên đăng nhập Google không hợp lệ hoặc đã hết hạn. Hãy thử lại.');
    }
    let claims;
    try {
      claims = await oidc().exchange({ currentUrl: new URL(`${redirectUri()}?${new URLSearchParams(q as Record<string, string>).toString()}`), state: saved.state, nonce: saved.nonce, codeVerifier: saved.verifier });
    } catch {
      return deny(reply, 400, 'Không xác thực được với Google. Hãy thử lại.');
    }
    const email = claims.email.trim().toLowerCase();
    const parts = email.split('@');
    const domain = parts.length === 2 && parts[0] ? parts[1]! : '';
    // An empty allow-list rejects everybody (server mode does not force it to be set).
    if (!claims.emailVerified || !domain || !cfg.allowedEmailDomains.includes(domain)) {
      return deny(reply, 403, 'Email này không được phép đăng nhập (chưa xác minh hoặc không thuộc tên miền cho phép).');
    }
    const bySub = repo.web.getUserByGoogleSub(claims.sub);
    const byEmail = repo.web.getUserByEmail(email);
    const existing = bySub ?? byEmail;
    if (existing?.disabled) return deny(reply, 403, 'Tài khoản đã bị vô hiệu hóa.');
    // never overwrite a different Google identity, never collide with another account's email
    if (byEmail && byEmail.googleSub && byEmail.googleSub !== claims.sub) return deny(reply, 403, 'Email này đã gắn với một tài khoản Google khác.');
    if (bySub && byEmail && bySub.id !== byEmail.id) return deny(reply, 403, 'Email này đã thuộc về tài khoản khác.');
    let result;
    try {
      result = repo.web.upsertGoogleUser({ email, googleSub: claims.sub, displayName: claims.name || email });
    } catch {
      return deny(reply, 403, 'Không tạo được tài khoản cho email này.');
    }
    const { user, created } = result;
    if (created) seedFirstLogin(user.id, email);
    repo.web.addAudit({ userId: user.id, action: created ? 'auth.first_login' : 'auth.login', detail: email });
    try { await deps.systemOps?.provisionUser(user.id); } catch (e) { console.error('provisionUser failed', e); }
    setSessionCookie(cfg, reply, repo.web.getUser(user.id)!);
    return reply.redirect('/');
  });

  /** First login only: an existing user keeps whatever role/department they already have. */
  function seedFirstLogin(userId: number, email: string): void {
    const deptOf = (m: Record<DepartmentCode, string[]>): DepartmentCode | undefined =>
      (Object.keys(m) as DepartmentCode[]).find(c => m[c].includes(email));
    const setDept = (code: DepartmentCode) => { const d = repo.web.getDepartmentByCode(code); if (d) repo.web.setUserDepartment(userId, d.id); };
    if (cfg.adminEmails.includes(email)) { repo.web.setUserSysRole(userId, 'admin'); return; }
    if (cfg.ctoEmails.includes(email)) { repo.web.setUserSysRole(userId, 'cto'); return; }
    const h = deptOf(cfg.headEmails);
    if (h) { repo.web.setUserSysRole(userId, 'head'); setDept(h); return; }
    const d = deptOf(cfg.deputyEmails);
    if (d) { repo.web.setUserSysRole(userId, 'deputy'); setDept(d); }
  }

  app.post('/logout', async (_req, reply) => {
    void reply.clearCookie(COOKIE, { path: '/' });
    return reply.redirect(cfg.mode === 'server' ? '/login' : '/');
  });

  app.get('/setup', async (_req, reply) => {
    if (sso) return reply.callNotFound();
    if (cfg.mode === 'local' || repo.web.listUsers().length > 0) return reply.redirect('/');
    return reply.type('text/html; charset=utf-8').send(page('setup', 'Thiết lập quản trị viên'));
  });
  app.post('/setup', async (req, reply) => {
    if (sso) return reply.callNotFound();
    if (cfg.mode === 'local' || repo.web.listUsers().length > 0) return reply.redirect('/');
    const b = (req.body ?? {}) as Form;
    const username = (b.username ?? '').trim();
    const password = b.password ?? '';
    if (!/^[\w.@-]{3,64}$/.test(username) || password.length < 8) {
      return reply.code(400).type('text/html; charset=utf-8').send(page('setup', 'Thiết lập quản trị viên', { error: 'Tên đăng nhập 3-64 ký tự (chữ, số, . _ - @) và mật khẩu tối thiểu 8 ký tự.' }));
    }
    const u = repo.web.createUser({ username, passwordHash: hashPassword(password), role: 'admin' });
    setSessionCookie(cfg, reply, u);
    return reply.redirect('/');
  });
}
