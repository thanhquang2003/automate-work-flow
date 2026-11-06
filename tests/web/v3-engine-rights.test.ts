import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionError } from '../../src/projects/service.js';
import { Worker } from '../../src/engine/worker.js';
import { blockingRun, registerStubs, until } from '../engine/v3-helpers.js';
import { webEnv } from './v3-helpers.js';

beforeEach(() => registerStubs());
type W = Awaited<ReturnType<typeof webEnv>>;
const mkRequest = (w: W, code: string, assignees?: Parameters<W['svc']['createRequest']>[0]['assignees']) =>
  w.svc.createRequest({ projectId: w.p.id, code, title: 't', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: w.pm.id, ...(assignees ? { assignees } : {}) });
const actions = (w: W, reqId: string) => w.repo.web.listAudit({ requestId: reqId, limit: 100 }).map(a => a.action);

describe('engine entry points enforce rights (not only the web routes)', () => {
  it('submitChange, saveAnswers and resumeAfterCustomer: PM or BA assignee only', async () => {
    const w = await webEnv();
    const r = await mkRequest(w, 'ERP-001');
    const cr = { title: 'c', description: 'd', kind: 'add' as const };
    for (const who of [w.dev.id, w.se.id, w.rev.id, w.tester.id]) {
      expect(() => w.pipeline.submitChange(r.id, cr, who)).toThrow(PermissionError);
      expect(() => w.pipeline.saveAnswers(r.id, [], 'staff', who)).toThrow(PermissionError);
    }
    expect(() => w.pipeline.submitChange(r.id, cr, null)).toThrow(PermissionError);
    expect(w.repo.listChangeRequests(r.id)).toHaveLength(0);
    w.pipeline.submitChange(r.id, cr, w.ba.id);
    expect(actions(w, r.id)).toContain('cr.create');
    // a BA project member who is not an assignee of this request cannot answer
    const ba2 = await w.addMemberVia();
    w.repo.web.setUserCanBePm(ba2.id, false);
    const cur = w.repo.listProjectMembers(w.p.id).map(m => ({ userId: m.userId, roles: m.userId === ba2.id ? ['DEV' as const, 'BA' as const] : m.roles }));
    await w.svc.setMembers(w.p.id, cur, w.pm.id);
    expect(() => w.pipeline.saveAnswers(r.id, [], 'staff', ba2.id)).toThrow(PermissionError);
    w.repo.updateRequest(r.id, { stage: 'CLARIFY', status: 'awaiting_customer' });
    expect(() => w.pipeline.resumeAfterCustomer(r.id, w.dev.id)).toThrow(PermissionError);
    expect(w.repo.getRequest(r.id)!.status).toBe('awaiting_customer');
  });

  it('"Tiếp tục" is audited after success only; a failed resume records a failure row', async () => {
    const w = await webEnv();
    const r = await mkRequest(w, 'ERP-001');
    // wrong state: the resume fails, no success audit
    const bad = await w.post(w.pm.id, `/requests/${r.id}/continue`);
    expect(String(bad.headers.location)).toContain('err=');
    expect(actions(w, r.id)).not.toContain('request.continue');
    expect(actions(w, r.id)).not.toContain('request.continue_failed'); // state check happens before the engine call
    w.repo.updateRequest(r.id, { stage: 'CLARIFY', status: 'awaiting_customer' });
    const ok = await w.post(w.ba.id, `/requests/${r.id}/continue`);
    expect(String(ok.headers.location)).not.toContain('err=');
    expect(actions(w, r.id)).toContain('request.continue');
    expect(w.repo.getRequest(r.id)!.status).toBe('running');
  });

  it('members wiring stops jobs before removal (through POST /projects/:id/members)', async () => {
    const w = await webEnv();
    const se2 = await w.addMemberVia();
    // se2 also holds SE
    const roles = (id: number) => (id === se2.id ? ['DEV' as const, 'SE' as const] : w.repo.getProjectMember(w.p.id, id)!.roles);
    await w.svc.setMembers(w.p.id, w.repo.listProjectMembers(w.p.id).map(m => ({ userId: m.userId, roles: roles(m.userId) })), w.pm.id);
    const r = await mkRequest(w, 'ERP-001', { SE: [w.se.id, se2.id] });
    const order: string[] = [];
    const orig = w.systemOps.setMembers;
    w.systemOps.setMembers = async (id, users) => { order.push('group'); return orig(id, users); };
    const blk = blockingRun();
    w.seats.setBehave(c => {
      if (c.userId !== w.se.id) return { ok: true, resultText: 'ok' };
      c.opts.signal?.addEventListener('abort', () => order.push('run-stopped'), { once: true });
      return blk.behave(c);
    });
    const worker = new Worker(w.cfg, w.repo, w.pipeline);
    w.pipeline.start(r.id);
    await until(worker, () => blk.started() === 1);
    const body: Record<string, string> = {};
    for (const m of w.repo.listProjectMembers(w.p.id)) {
      const keep = m.roles.filter(x => !(m.userId === w.se.id));
      if (keep.length) body[`r_${m.userId}`] = keep[0]!;
    }
    body[`r_${se2.id}`] = 'SE';
    const res = await w.post(w.pm.id, `/projects/${w.p.id}/members`, body);
    expect(String(res.headers.location)).toContain('ok=');
    expect(order[0]).toBe('run-stopped');
    expect(order).toContain('group');
    expect(w.repo.getProjectMember(w.p.id, w.se.id)).toBeUndefined();
    await worker.drain();
    expect(w.seats.calls.map(c => c.userId)).toContain(se2.id);
  });
});

describe('assignee order changes need the stale token', () => {
  it('up/down/remove/first without or with a stale expect_runner are refused', async () => {
    const w = await webEnv();
    const dev2 = await w.addMemberVia();
    const r = await mkRequest(w, 'ERP-001', { DEV: [w.dev.id, dev2.id] });
    const url = `/requests/${r.id}/assignees`;
    const order = () => w.repo.listRequestAssignees(r.id, 'DEV').map(a => a.userId);
    for (const op of ['up', 'down', 'remove', 'first']) {
      const missing = await w.post(w.pm.id, url, { role: 'DEV', user: String(dev2.id), op });
      expect(missing.statusCode, `${op} without token`).toBe(409);
      const stale = await w.post(w.pm.id, url, { role: 'DEV', user: String(dev2.id), op, expect_runner: String(dev2.id) });
      expect(stale.statusCode, `${op} with stale token`).toBe(409);
      expect(order()).toEqual([w.dev.id, dev2.id]);
    }
    const ok = await w.post(w.pm.id, url, { role: 'DEV', user: String(dev2.id), op: 'up', expect_runner: String(w.dev.id) });
    expect(ok.statusCode).toBe(302);
    expect(order()).toEqual([dev2.id, w.dev.id]);
  });

  it('changing the runner stops the running run before the answer returns', async () => {
    const w = await webEnv();
    const dev2 = await w.addMemberVia();
    const se2 = dev2; // second person, also SE
    const cur = w.repo.listProjectMembers(w.p.id).map(m => ({ userId: m.userId, roles: m.userId === se2.id ? ['DEV' as const, 'SE' as const] : m.roles }));
    await w.svc.setMembers(w.p.id, cur, w.pm.id);
    const r = await mkRequest(w, 'ERP-001', { SE: [w.se.id, se2.id] });
    const blk = blockingRun();
    let stopped = false;
    w.seats.setBehave(c => {
      if (c.userId !== w.se.id) return { ok: true, resultText: 'ok' };
      c.opts.signal?.addEventListener('abort', () => { stopped = true; }, { once: true });
      return blk.behave(c);
    });
    const worker = new Worker(w.cfg, w.repo, w.pipeline);
    w.pipeline.start(r.id);
    await until(worker, () => blk.started() === 1);
    const res = await w.post(w.pm.id, `/requests/${r.id}/assignees`, { role: 'SE', user: String(se2.id), op: 'first', expect_runner: String(w.se.id) });
    expect(res.statusCode).toBe(302);
    expect(stopped).toBe(true);
    await worker.drain();
  });
});

describe('seat login follow-up failure', () => {
  it('a throwing wake-up does not become an unhandled rejection', async () => {
    const w = await webEnv();
    const seen: unknown[] = [];
    const onRej = (e: unknown) => { seen.push(e); };
    process.on('unhandledRejection', onRej);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(w.pipeline, 'seatReconnected').mockImplementation(() => { throw new Error('boom'); });
    await w.post(w.dev.id, '/seat/connect');
    w.logins[0]!.finish({ success: true });
    await new Promise(r => setTimeout(r, 50));
    process.off('unhandledRejection', onRej);
    expect(seen).toEqual([]);
    expect(err).toHaveBeenCalled();
    expect((await w.get(w.dev.id, '/seat')).statusCode).toBe(200);
    vi.restoreAllMocks();
  });
});
