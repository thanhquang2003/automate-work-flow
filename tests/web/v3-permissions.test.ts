import { describe, expect, it } from 'vitest';
import { PermissionError } from '../../src/projects/service.js';
import { webEnv } from './v3-helpers.js';

async function atGate(w: Awaited<ReturnType<typeof webEnv>>, stage: 'ANALYSIS' | 'PLANNING' = 'ANALYSIS') {
  const r = await w.svc.createRequest({ projectId: w.p.id, code: `ERP-00${stage === 'PLANNING' ? 2 : 1}`, title: 't', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: w.pm.id });
  w.repo.updateRequest(r.id, { stage, status: 'awaiting_approval' });
  return w.repo.getRequest(r.id)!;
}

describe('v3 web permissions', () => {
  it('writes land in audit_log', async () => {
    const w = await webEnv();
    const r = await atGate(w);
    await w.post(w.pm.id, `/requests/${r.id}/pause`, {});
    expect(w.repo.web.listAudit({ requestId: r.id }).map(a => a.action)).toContain('request.pause');
    await w.post(w.ba.id, `/requests/${r.id}/approve`, { expect: w.pipeline.gateToken(w.repo.getRequest(r.id)!) });
    expect(w.repo.web.listAudit({ requestId: r.id }).map(a => a.action)).toContain('gate.approve');
  });

  it('stale approve token refused', async () => {
    const w = await webEnv();
    const r = await atGate(w);
    const stale = w.pipeline.gateToken(r);
    // the stage ran again meanwhile
    w.repo.createStageRun(r.id, 'ANALYSIS');
    const res = await w.post(w.ba.id, `/requests/${r.id}/approve`, { expect: stale });
    expect(res.statusCode).toBe(409);
    expect(w.repo.getRequest(r.id)!.status).toBe('awaiting_approval');
    // missing token is refused too
    expect((await w.post(w.ba.id, `/requests/${r.id}/approve`, {})).statusCode).toBe(409);
    const ok = await w.post(w.ba.id, `/requests/${r.id}/approve`, { expect: w.pipeline.gateToken(w.repo.getRequest(r.id)!) });
    expect(ok.statusCode).toBe(302);
    expect(w.repo.getRequest(r.id)!.stage).not.toBe('ANALYSIS');
  });

  it('PLANNING shows PM approval only; TEST/BUGFIX have no approve button; invalid part refused', async () => {
    const w = await webEnv();
    const r = await atGate(w, 'PLANNING');
    const pm = (await w.get(w.pm.id, `/requests/${r.id}`)).body;
    expect(pm).toContain('/approve');
    expect(pm).toContain('Chỉ test case');
    const dev = (await w.get(w.dev.id, `/requests/${r.id}`)).body;
    expect(dev).not.toContain(`/requests/${r.id}/approve`);
    expect((await w.post(w.pm.id, `/requests/${r.id}/approve`, { expect: w.pipeline.gateToken(r), part: 'bogus' })).statusCode).toBe(302);
    expect(w.repo.getRequest(r.id)!.status).toBe('awaiting_approval');
    for (const stage of ['TEST', 'BUGFIX'] as const) {
      w.repo.updateRequest(r.id, { stage, status: 'awaiting_approval' });
      expect((await w.get(w.pm.id, `/requests/${r.id}`)).body).not.toContain(`/requests/${r.id}/approve`);
    }
  });

  it('members wiring stops jobs before removal', async () => {
    const w = await webEnv();
    const order: string[] = [];
    const orig = w.pipeline.beforeMembersRemoved.bind(w.pipeline);
    w.pipeline.beforeMembersRemoved = async (...a) => { order.push('engine'); return orig(...a); };
    const sys = w.systemOps.setMembers;
    w.systemOps.setMembers = async (...a) => { order.push('os'); return sys(...a); };
    const second = await w.addMemberVia();
    order.length = 0;
    await w.pipeline.removeMember(w.p.id, second.id, w.pm.id);
    expect(order).toEqual(['engine', 'os']);
    expect(w.repo.getProjectMember(w.p.id, second.id)).toBeUndefined();
  });

  it('setMembers checks the PM right before probing user ids', async () => {
    const w = await webEnv();
    const outsider = w.mkUser('out');
    await expect(w.svc.setMembers(w.p.id, [{ userId: 999999, roles: ['PM'] }], outsider.id)).rejects.toBeInstanceOf(PermissionError);
  });
});
