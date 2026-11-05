import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Repo } from '../db/repo.js';
import { bus } from '../engine/bus.js';

const HEARTBEAT_MS = 20_000;

/** Server-sent events: last 200 stored events, then live 'event' and 'status' messages. */
export function streamEvents(repo: Repo, req: FastifyRequest, reply: FastifyReply, reqId: string): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (name: string, data: unknown, id?: number) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const lastId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
  const all = repo.listEvents(reqId, Number.isFinite(lastId) && lastId > 0 ? lastId : 0);
  for (const e of all.slice(-200)) send('log', { id: e.id, ts: e.ts, level: e.level, message: e.message }, e.id);
  const onEvent = (e: { requestId: string; id: number; ts: number; level: string; message: string }) => {
    if (e.requestId === reqId) send('log', { id: e.id, ts: e.ts, level: e.level, message: e.message }, e.id);
  };
  const onStatus = (s: { requestId: string; stage: string; status: string }) => {
    if (s.requestId === reqId) send('status', { stage: s.stage, status: s.status });
  };
  bus.on('event', onEvent);
  bus.on('status', onStatus);
  const hb = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, HEARTBEAT_MS);
  const cleanup = () => {
    clearInterval(hb);
    bus.off('event', onEvent);
    bus.off('status', onStatus);
    if (!res.writableEnded) res.end();
  };
  req.raw.on('close', cleanup);
  res.on('close', cleanup);
  res.write(': connected\n\n');
}
