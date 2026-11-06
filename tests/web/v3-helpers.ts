import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import type { LoginResult, LoginSession } from '../../src/claude/seat-login.js';
import type { SeatState } from '../../src/claude/seat-runner.js';
import { Pipeline } from '../../src/engine/pipeline.js';
import { wireProjects } from '../../src/projects/wire.js';
import { signSession } from '../../src/web/auth.js';
import { buildServer } from '../../src/web/server.js';
import { fakeSeats } from '../engine/v3-helpers.js';
import { fullProject, mkEnv, mkUser } from '../projects/helpers.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

export class FakeLogin extends EventEmitter implements LoginSession {
  url: string | undefined = 'https://claude.ai/login?x=1';
  codes: string[] = [];
  cancelled = false;
  private res!: (r: LoginResult) => void;
  result = new Promise<LoginResult>(r => { this.res = r; });
  sendCode(c: string): void { this.codes.push(c); }
  cancel(): void { this.cancelled = true; this.res({ success: false, reason: 'cancelled' }); }
  finish(r: LoginResult): void { this.res(r); }
}

export const origin = { origin: 'http://localhost:3000', host: 'localhost:3000' };
export const formHdr = { 'content-type': 'application/x-www-form-urlencoded', ...origin };
export const enc = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/** Server-mode web app on a full project (PM, BA, SE, DEV, REVIEWER, TESTER) with a fake seat runner. */
export async function webEnv() {
  const e = mkEnv();
  const f = await fullProject(e);
  const cfg = { ...e.cfg, mode: 'server' as const, secretKey: 'v3-secret', publicBaseUrl: 'http://localhost:3000', google: { clientId: 'c', clientSecret: 's' } };
  const seats = fakeSeats();
  const logins: FakeLogin[] = [];
  const runner = { ...seats.runner, login: () => { const l = new FakeLogin(); logins.push(l); return l; } };
  const pipeline = new Pipeline(cfg, e.repo, { seatRunner: runner });
  const svc = wireProjects({ cfg, repo: e.repo, pipeline, systemOps: e.systemOps });
  const routes: string[] = [];
  const app = await buildServer(cfg, { repo: e.repo, pipeline, seatRunner: runner, projects: svc, routeLog: (m, u) => { routes.push(`${m} ${u}`); } });
  apps.push(app);
  const cookie = (userId: number) => `devflow_sid=${signSession(cfg.secretKey, userId)}`;
  const get = (userId: number, url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookie(userId), host: 'localhost:3000' } });
  const post = (userId: number | null, url: string, body: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: enc(body), headers: { ...formHdr, ...(userId === null ? {} : { cookie: cookie(userId) }) } });
  const addMemberVia = async () => {
    const u = mkUser(e.repo, 'extra@x.com');
    const cur = e.repo.listProjectMembers(f.p.id).map(m => ({ userId: m.userId, roles: m.roles }));
    if (cur.some(m => m.userId === u.id)) return u;
    await svc.setMembers(f.p.id, [...cur, { userId: u.id, roles: ['DEV'] }], e.pm.id);
    return u;
  };
  return { ...e, ...f, addMemberVia, routes, cfg, seats, logins, pipeline, svc, app, get, post, cookie, mkUser: (n: string, o: Parameters<typeof mkUser>[2] = {}) => mkUser(e.repo, `${n}@x.com`, o), seatState: (id: number, s: SeatState) => seats.state.set(id, s) };
}
