import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { SysRole, UserRow } from '../domain/types.js';

export const COOKIE = 'devflow_sid';
export const SESSION_MS = 7 * 24 * 3600 * 1000;

export interface SessionUser {
  id: number | null; username: string; role: 'admin' | 'member';
  sysRole?: SysRole; departmentId?: number | null; canBePm?: boolean;
}
export const LOCAL_USER: SessionUser = { id: null, username: 'local', role: 'admin', sysRole: 'admin', departmentId: null, canBePm: true };

declare module 'fastify' {
  interface FastifyRequest { user?: SessionUser }
}

const mac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex');

export function signSession(secret: string, uid: number, now = Date.now()): string {
  const exp = now + SESSION_MS;
  return `${uid}.${exp}.${mac(secret, `${uid}.${exp}`)}`;
}

/** Returns the user id when the cookie value is authentic and unexpired. */
export function verifySession(secret: string, value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(value);
  if (!m) return undefined;
  const expected = Buffer.from(mac(secret, `${m[1]}.${m[2]}`), 'hex');
  const given = Buffer.from(m[3]!, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  if (Number(m[2]) < now) return undefined;
  return Number(m[1]);
}

export function setSessionCookie(cfg: Config, reply: FastifyReply, user: UserRow): void {
  void reply.setCookie(COOKIE, signSession(cfg.secretKey, user.id), {
    httpOnly: true, sameSite: 'lax', path: '/', secure: cfg.publicBaseUrl.startsWith('https'), maxAge: SESSION_MS / 1000,
  });
}

export function currentUser(cfg: Config, repo: Repo, req: FastifyRequest): SessionUser | undefined {
  if (cfg.mode === 'local') return LOCAL_USER;
  const uid = verifySession(cfg.secretKey, req.cookies?.[COOKIE]);
  if (uid === undefined) return undefined;
  const u = repo.web.getUser(uid);
  if (!u || u.disabled) return undefined;
  return { id: u.id, username: u.email ?? u.username, role: u.role, sysRole: u.sysRole, departmentId: u.departmentId, canBePm: u.canBePm };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * DNS-rebinding defence for local mode (no login): the Host header must name the loopback interface
 * (any port), or the explicit non-wildcard address DevFlow was bound to via HOST.
 */
export function isLocalHostHeader(host: string | undefined, boundHost = ''): boolean {
  if (!host) return false;
  let name: string;
  try { name = new URL(`http://${host}`).hostname.toLowerCase(); } catch { return false; }
  if (LOOPBACK_HOSTS.has(name)) return true;
  const bound = boundHost.trim().toLowerCase();
  if (!bound || bound === '0.0.0.0' || bound === '::' || bound === '[::]') return false;
  return name === bound || name === `[${bound}]`;
}

/** CSRF defence in depth: a POST must come from the same host (Origin, else Referer). */
export function sameOrigin(req: FastifyRequest, required: boolean, publicBaseUrl = ''): boolean {
  const src = (req.headers.origin as string | undefined) || (req.headers.referer as string | undefined);
  if (!src) return !required;
  try {
    const h = new URL(src).host;
    if (h === req.headers.host) return true;
    return publicBaseUrl !== '' && h === new URL(publicBaseUrl).host;
  } catch { return false; }
}

/** Short-lived signed blob (HMAC) used for the OIDC state cookie. */
export function signBlob(secret: string, data: object, ttlMs: number, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: now + ttlMs })).toString('base64url');
  return `${body}.${mac(secret, body)}`;
}
export function verifyBlob<T extends object>(secret: string, value: string | undefined, now = Date.now()): T | undefined {
  if (!value) return undefined;
  const [body, sig] = value.split('.');
  if (!body || !sig || !/^[0-9a-f]{64}$/.test(sig)) return undefined;
  const a = Buffer.from(mac(secret, body), 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { exp?: number };
    return typeof o.exp === 'number' && o.exp >= now ? o : undefined;
  } catch { return undefined; }
}
