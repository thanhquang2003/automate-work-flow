import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { UserRow } from '../domain/types.js';

export const COOKIE = 'devflow_sid';
export const SESSION_MS = 7 * 24 * 3600 * 1000;

export interface SessionUser { id: number | null; username: string; role: 'admin' | 'member' }
export const LOCAL_USER: SessionUser = { id: null, username: 'local', role: 'admin' };

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
  const u = repo.getUser(uid);
  return u ? { id: u.id, username: u.username, role: u.role } : undefined;
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
