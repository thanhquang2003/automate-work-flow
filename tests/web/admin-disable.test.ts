import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearStages } from '../../src/engine/pipeline.js';
import { Worker } from '../../src/engine/worker.js';
import { blockingRun, registerStubs, until } from '../engine/v3-helpers.js';
import { webEnv } from './v3-helpers.js';

beforeEach(() => registerStubs());
afterEach(() => clearStages());

/** Minor (a) of the final review: disabling a user moves their running jobs first, then drops them from OS groups. */
describe('admin disables a user (server mode)', () => {
  it('stops and reseats the running job, then removes the user from the Linux groups; re-enabling adds them back', async () => {
    const w = await webEnv();
    const admin = w.mkUser('adm'); w.repo.web.setUserSysRole(admin.id, 'admin');
    const se2 = await w.addMemberVia(); // DEV by default: give them SE too
    const cur = w.repo.listProjectMembers(w.p.id).map(m => ({ userId: m.userId, roles: m.userId === se2.id ? [...m.roles, 'SE' as const] : m.roles }));
    await w.svc.setMembers(w.p.id, cur, w.pm.id);
    const r = await w.svc.createRequest({ projectId: w.p.id, code: 'ERP-001', title: 't', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: w.pm.id, assignees: { SE: [w.se.id, se2.id] } });
    const worker = new Worker(w.cfg, w.repo, w.pipeline);
    const b = blockingRun();
    w.seats.setBehave(b.behave);
    w.pipeline.start(r.id);
    await until(worker, () => b.started() === 1, 3000);
    expect(w.seats.calls.at(-1)!.userId).toBe(w.se.id);
    const groupsBefore = w.ops.members.length;

    const res = await w.post(admin.id, `/admin/users/${w.se.id}/disable`, { value: '1' });
    expect(decodeURIComponent(String(res.headers.location))).toContain('ok=');
    // The stopped run had ended before the route answered; the job now belongs to se2.
    const job = w.repo.listJobs(r.id).find(j => (j.payload as { stage?: string }).stage === 'CODEBASE_SCAN' && j.status !== 'done' && j.status !== 'failed');
    expect(job?.seatUserId).toBe(se2.id);
    const after = w.ops.members.slice(groupsBefore);
    expect(after).toContainEqual([w.p.id, expect.not.arrayContaining([w.se.id])]);
    expect(after.at(-1)![1]).toContain(se2.id);
    await until(worker, () => w.seats.calls.some(c => c.userId === se2.id), 3000);
    b.release();
    await worker.idle();

    // Re-enabling puts the user back into the group (and the restart reconcile never re-adds a disabled user).
    const n = w.ops.members.length;
    await w.post(admin.id, `/admin/users/${w.se.id}/disable`, { value: '0' });
    expect(w.ops.members.slice(n).at(-1)![1]).toContain(w.se.id);
  });

  it('reconcile at start leaves disabled users out of the groups', async () => {
    const w = await webEnv();
    const { reconcileProjects } = await import('../../src/projects/reconcile.js');
    w.repo.web.setUserDisabled(w.dev.id, true);
    const n = w.ops.members.length;
    await reconcileProjects(w.repo, w.systemOps);
    const row = w.ops.members.slice(n).find(m => m[0] === w.p.id)!;
    expect(row[1]).not.toContain(w.dev.id);
    expect(row[1]).toContain(w.se.id);
  });
});
