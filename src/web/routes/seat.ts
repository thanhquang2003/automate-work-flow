import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { LoginSession } from '../../claude/seat-login.js';
import { auditWeb, forbidPage } from '../authz.js';
import type { WebDeps } from '../server.js';
import { render, type LayoutData } from '../view.js';

interface Attempt { session: LoginSession; state: 'waiting' | 'success' | 'failed'; reason?: string }
const REASONS: Record<string, string> = { timeout: 'Hết thời gian chờ đăng nhập.', cancelled: 'Đã hủy đăng nhập.', failed: 'Đăng nhập không thành công (mã sai hoặc hết hạn).', spawn: 'Không khởi động được tiến trình đăng nhập.' };

/** "Claude của tôi": each person connects their own Claude seat. The pasted code only goes to the login session. */
export function seatRoutes(app: FastifyInstance, cfg: Config, { repo, pipeline, seatRunner }: WebDeps): void {
  const attempts = new Map<number, Attempt>();
  const layout = (req: FastifyRequest, title: string, extra: Partial<LayoutData> = {}): LayoutData => ({ user: req.user, mode: cfg.mode, title, ...extra });
  const html = (reply: FastifyReply, s: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(s);
  const go = (reply: FastifyReply, kind: 'ok' | 'err', msg: string) => reply.redirect(`/seat?${kind}=${encodeURIComponent(msg)}`);
  const uid = (req: FastifyRequest): number | undefined => (req.user?.id ?? undefined);

  app.get('/seat', async (req, reply) => {
    const id = uid(req);
    const q = req.query as { ok?: string; err?: string };
    if (id === undefined || !seatRunner || seatRunner.kind === 'local') {
      return html(reply, render('seat', layout(req, 'Claude của tôi'), { available: false }));
    }
    let status: { state: string; email?: string | undefined; org?: string | undefined } = { state: 'unknown' };
    try { status = await seatRunner.status(id); } catch { /* shown as unknown */ }
    const a = attempts.get(id);
    return html(reply, render('seat', layout(req, 'Claude của tôi', { flash: q.err ?? q.ok, flashKind: q.err ? 'error' : 'ok' }), {
      available: true, status, attempt: a ? { state: a.state, url: a.session.url, reason: a.reason } : undefined,
    }));
  });

  const need = (req: FastifyRequest, reply: FastifyReply): number | undefined => {
    const id = uid(req);
    if (id === undefined || !seatRunner || seatRunner.kind === 'local') { void forbidPage(cfg, req, reply, 'Chế độ này không có phiên Claude riêng.'); return undefined; }
    return id;
  };

  app.post('/seat/connect', async (req, reply) => {
    const id = need(req, reply);
    if (id === undefined) return;
    attempts.get(id)?.session.cancel();
    const session = seatRunner!.login(id);
    const at: Attempt = { session, state: 'waiting' };
    attempts.set(id, at);
    void session.result.then(r => {
      if (attempts.get(id) !== at) return;
      if (r.success) {
        at.state = 'success';
        pipeline.seatReconnected(id);
      } else { at.state = 'failed'; at.reason = REASONS[r.reason ?? 'failed']; }
      auditWeb(repo, req, r.success ? 'seat.login' : 'seat.login_failed', { detail: { reason: r.reason ?? null } });
    });
    return reply.redirect('/seat');
  });

  // The code is handed to the process and dropped: never logged, stored, echoed or put in a redirect.
  app.post('/seat/code', async (req, reply) => {
    const id = need(req, reply);
    if (id === undefined) return;
    const at = attempts.get(id);
    if (!at || at.state !== 'waiting') return go(reply, 'err', 'Chưa có phiên đăng nhập đang chờ mã.');
    const code = String(((req.body ?? {}) as Record<string, unknown>).code ?? '');
    try { at.session.sendCode(code); } catch { return go(reply, 'err', 'Mã không hợp lệ hoặc phiên đã kết thúc.'); }
    return reply.redirect('/seat');
  });

  app.post('/seat/cancel', async (req, reply) => {
    const id = need(req, reply);
    if (id === undefined) return;
    attempts.get(id)?.session.cancel();
    attempts.delete(id);
    return reply.redirect('/seat');
  });

  app.post('/seat/check', async (req, reply) => {
    const id = need(req, reply);
    if (id === undefined) return;
    const s = await seatRunner!.status(id).catch(() => ({ state: 'unknown' }));
    if (s.state === 'connected') pipeline.seatReconnected(id);
    return go(reply, 'ok', 'Đã kiểm tra trạng thái Claude.');
  });

  app.post('/seat/logout', async (req, reply) => {
    const id = need(req, reply);
    if (id === undefined) return;
    attempts.get(id)?.session.cancel();
    attempts.delete(id);
    try { await seatRunner!.logout(id); } catch { return go(reply, 'err', 'Không đăng xuất được Claude.'); }
    auditWeb(repo, req, 'seat.logout');
    return go(reply, 'ok', 'Đã đăng xuất Claude.');
  });

  // Result stream: only a state word, never the code or process output.
  app.get('/seat/events', async (req, reply) => {
    const id = need(req, reply);
    if (id === undefined) return;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    const send = () => {
      const a = attempts.get(id);
      if (!res.writableEnded) res.write(`event: seat\ndata: ${JSON.stringify({ state: a?.state ?? 'none', url: a?.session.url ?? null })}\n\n`);
      return a?.state;
    };
    send();
    const t = setInterval(() => { const s = send(); if (s !== 'waiting' && !res.writableEnded) { clearInterval(t); res.end(); } }, 1000);
    t.unref();
    req.raw.on('close', () => clearInterval(t));
  });
}
