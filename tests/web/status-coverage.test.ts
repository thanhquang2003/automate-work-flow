import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestStatus } from '../../src/domain/types.js';
import { STATUS_LABELS, STAGE_RUN_LABELS, TASK_STATUS_LABELS } from '../../src/web/view.js';
import { buildServer } from '../../src/web/server.js';
import { mkReq, setup } from '../engine/helpers.js';
import { webEnv } from './v3-helpers.js';

/** Final review 2(e): every request status renders a real label (no blank/undefined) on the request page and lists. */
const STATUSES: RequestStatus[] = ['running', 'awaiting_seat', 'awaiting_approval', 'awaiting_customer', 'paused', 'needs_human', 'failed', 'done', 'cancelled'];

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const noBlank = (body: string, what: string): void => {
  expect(body, what).not.toMatch(/>undefined</);
  expect(body, what).not.toMatch(/<span class="badge st-[\w-]+"><\/span>/);
};

describe('status coverage (local mode pages)', () => {
  it.each(STATUSES)('request page and dashboard render status %s with its label', async status => {
    const s = setup();
    const app = await buildServer(s.cfg, { repo: s.repo, pipeline: s.pipeline });
    apps.push(app);
    const r = mkReq(s.repo, { title: `Yêu cầu ${status}` });
    s.repo.updateRequest(r.id, { status, stage: status === 'done' ? 'DONE' : 'DEVELOP' });
    s.repo.replaceTasks(r.id, [{ id: 'T-01', title: 'Task lỗi', featureId: null, dependsOn: [], status: 'failed', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: 'active', changedByCr: null, assigneeId: null }]);
    const run = s.repo.createStageRun(r.id, 'DEVELOP', null);
    s.repo.finishStageRun(run.id, 'awaiting_seat', { error: 'seat' });
    const label = STATUS_LABELS[status]!;
    for (const url of [`/requests/${r.id}`, `/requests/${r.id}?tab=tasks`, '/', `/?status=${status}`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(label);
      noBlank(res.body, url);
    }
    const detail = (await app.inject({ method: 'GET', url: `/requests/${r.id}` })).body;
    expect(detail).toContain(STAGE_RUN_LABELS.awaiting_seat);
    expect((await app.inject({ method: 'GET', url: `/requests/${r.id}?tab=tasks` })).body).toContain(TASK_STATUS_LABELS.failed);
    // A request waiting for a seat offers Pause/Cancel (I2: pause honours awaiting_seat).
    if (status === 'awaiting_seat') {
      expect(detail).toContain(`/requests/${r.id}/pause"`);
      expect(detail).toContain(`/requests/${r.id}/cancel"`);
    }
  });

  it('awaiting_seat badge has its own style', async () => {
    const css = await (await import('node:fs/promises')).readFile(new URL('../../public/app.css', import.meta.url), 'utf8');
    expect(css).toContain('.st-awaiting_seat');
  });
});

describe('status coverage (server mode: inbox, project page, oversight)', () => {
  it.each(STATUSES)('project and oversight pages render status %s', async status => {
    const w = await webEnv();
    const r = await w.svc.createRequest({ projectId: w.p.id, code: `ERP-0${STATUSES.indexOf(status) + 10}`, title: 't', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: w.pm.id });
    w.repo.updateRequest(r.id, { status, stage: 'DEVELOP' });
    w.repo.enqueueJob(r.id, 'run_task', { stage: 'DEVELOP', taskId: 'T-01', awaitSeat: w.dev.id }, 0, w.dev.id);
    const cto = w.mkUser('cto', { dept: null }); w.repo.web.setUserSysRole(cto.id, 'cto');
    const label = STATUS_LABELS[status]!;
    for (const [uid, url] of [[w.pm.id, `/projects/${w.p.id}`], [w.pm.id, '/'], [w.pm.id, `/requests/${r.id}`], [cto.id, `/oversight/projects/${w.p.id}`], [cto.id, '/oversight/blockers']] as const) {
      const res = await w.get(uid, url);
      expect(res.statusCode, url).toBe(200);
      noBlank(res.body, url);
      if (!url.endsWith('/') && !url.includes('blockers')) expect(res.body, url).toContain(label);
    }
  });
});
