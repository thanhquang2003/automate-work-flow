import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { TaskRow } from '../../src/domain/types.js';
import { exportQuestions } from '../../src/office/questions-xlsx.js';
import { SETTING_KEYS } from '../../src/settings.js';
import { enc, formHdr, webEnv } from './v3-helpers.js';

type W = Awaited<ReturnType<typeof webEnv>>;
const ACTORS = ['anon', 'nodept', 'pm', 'ba', 'se', 'dev', 'rev', 'tester', 'nonMember', 'otherDept', 'headSame', 'headOther', 'deputy', 'cto', 'adminOut', 'adminMember'] as const;
type ActorName = (typeof ACTORS)[number];
const AUTHED = ACTORS.filter(a => a !== 'anon');
const ADMINS: ActorName[] = ['adminOut', 'adminMember'];

interface Call { url: string; body?: Record<string, string>; multipart?: { fields: [string, string][]; file?: { name: string; filename: string; content: Buffer } } }
interface Row { pattern: string; variant?: string; /** Authorised actors whose input is refused with an error flash (302 ?err=) and no change. */ softRefuse?: readonly ActorName[]; arm(w: W, A: Record<ActorName, number>, actor: number | null): Promise<Call> | Call; allowed: readonly ActorName[] }

/** Routes that are public by design (login, logout, setup, customer survey): not part of the role table. */
const EXEMPT = new Set(['POST /login', 'POST /login/local', 'POST /logout', 'POST /setup', 'POST /s/:token']);

let n = 0;
const uniq = () => ++n;
const q1 = { id: 'Q-01', category: 'Khác', question: '?', why: 'w', type: 'single' as const, options: ['a', 'b'], suggested_answer: 'a', priority: 'must' as const };
const task = (id: string): TaskRow => ({ id, title: id, featureId: null, dependsOn: [], status: 'todo', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: 'active', changedByCr: null, assigneeId: null });

const newReq = (w: W) => w.svc.createRequest({ projectId: w.p.id, code: `ERP-${100 + uniq()}`, title: 't', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: w.pm.id });
const atGate = async (w: W, stage: 'ANALYSIS' = 'ANALYSIS') => { const r = await newReq(w); return w.repo.updateRequest(r.id, { stage, status: 'awaiting_approval' }); };
const rolePeople = (w: W) => [['PM', w.pm.id], ['BA', w.ba.id], ['SE', w.se.id], ['DEV', w.dev.id], ['REVIEWER', w.rev.id], ['TESTER', w.tester.id]] as const;
const member = (w: W, o: Parameters<W['mkUser']>[1] = {}) => w.mkUser(`u${uniq()}`, o);
const docx = async () => { const z = new JSZip(); z.file('word/document.xml', '<x/>'); return z.generateAsync({ type: 'nodebuffer' }); };

const ROWS: Row[] = [
  { pattern: '/requests/:id/approve', allowed: ['pm', 'ba'], arm: async w => { const r = await atGate(w); return { url: `/requests/${r.id}/approve`, body: { expect: w.pipeline.gateToken(r) } }; } },
  { pattern: '/requests/:id/reject', allowed: ['pm', 'ba'], arm: async w => { const r = await atGate(w); return { url: `/requests/${r.id}/reject`, body: { expect: w.pipeline.gateToken(r), feedback: 'làm lại' } }; } },
  { pattern: '/requests/:id/pause', allowed: ['pm'], arm: async w => { const r = await newReq(w); w.pipeline.start(r.id); return { url: `/requests/${r.id}/pause` }; } },
  { pattern: '/requests/:id/resume', allowed: ['pm'], arm: async w => { const r = await newReq(w); w.pipeline.start(r.id); w.pipeline.pause(r.id); return { url: `/requests/${r.id}/resume` }; } },
  { pattern: '/requests/:id/cancel', allowed: ['pm'], arm: async w => { const r = await newReq(w); w.pipeline.start(r.id); return { url: `/requests/${r.id}/cancel` }; } },
  { pattern: '/requests/:id/rerun', allowed: ['pm'], arm: async w => { const r = await newReq(w); w.repo.updateRequest(r.id, { stage: 'ANALYSIS', status: 'failed' }); return { url: `/requests/${r.id}/rerun` }; } },
  { pattern: '/requests/:id/assignees', allowed: ['pm'], arm: async w => {
    const r = await newReq(w); const u2 = await w.addMemberVia();
    await w.svc.setAssignees(r.id, 'DEV', [w.dev.id], w.pm.id);
    return { url: `/requests/${r.id}/assignees`, body: { role: 'DEV', user: String(u2.id), op: 'add', expect_runner: String(w.dev.id) } };
  } },
  { pattern: '/requests/:id/tasks/:task/assign', allowed: ['pm', 'dev'], arm: async w => { const r = await newReq(w); w.repo.upsertTask(r.id, task('T-01')); return { url: `/requests/${r.id}/tasks/T-01/assign`, body: { user: String(w.dev.id) } }; } },
  { pattern: '/requests/:id/changes', allowed: ['pm', 'ba'], arm: async w => { const r = await newReq(w); return { url: `/requests/${r.id}/changes`, multipart: { fields: [['title', 'Thêm'], ['description', 'mô tả'], ['kind', 'add']] } }; } },
  { pattern: '/requests/:id/changes/:cr/decide', allowed: ['pm'], arm: async w => {
    const r = await newReq(w);
    const cr = w.repo.createChangeRequest(r.id, { title: 'c', description: 'd', kind: 'add', source: 'staff', status: 'awaiting_decision' });
    w.repo.updateChangeRequest(r.id, cr.id, { interruptedStage: 'ANALYSIS', interruptedStatus: 'awaiting_approval' });
    w.repo.updateRequest(r.id, { stage: 'CHANGE', status: 'awaiting_approval' });
    return { url: `/requests/${r.id}/changes/${cr.id}/decide`, body: { decision: 'reject', note: 'không cần', expect: w.pipeline.gateToken(w.repo.getRequest(r.id)!) } };
  } },
  { pattern: '/requests/:id/changes/:cr/accept-proposal', allowed: ['pm'], arm: async w => {
    const r = await newReq(w); const cr = w.repo.createChangeRequest(r.id, { title: 'c', description: 'd', kind: 'add', source: 'customer', status: 'proposed' });
    return { url: `/requests/${r.id}/changes/${cr.id}/accept-proposal` };
  } },
  { pattern: '/requests/:id/changes/:cr/reject-proposal', allowed: ['pm'], arm: async w => {
    const r = await newReq(w); const cr = w.repo.createChangeRequest(r.id, { title: 'c', description: 'd', kind: 'add', source: 'customer', status: 'proposed' });
    return { url: `/requests/${r.id}/changes/${cr.id}/reject-proposal`, body: { note: 'không' } };
  } },
  { pattern: '/requests/:id/answers', allowed: ['pm', 'ba'], arm: async w => { const r = await newReq(w); w.repo.upsertQuestions(r.id, 1, [q1]); return { url: `/requests/${r.id}/answers`, body: { qid: 'Q-01', answer: 'có' } }; } },
  { pattern: '/requests/:id/answers/import', allowed: ['pm', 'ba'], arm: async w => {
    const r = await newReq(w); w.repo.upsertQuestions(r.id, 1, [q1]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await exportQuestions(r.id, 1, [q1], new Map())) as unknown as ArrayBuffer);
    wb.worksheets[0]!.getRow(4).getCell(7).value = 'đã trả lời';
    const content = Buffer.from(await wb.xlsx.writeBuffer());
    return { url: `/requests/${r.id}/answers/import`, multipart: { fields: [], file: { name: 'file', filename: 'a.xlsx', content } } };
  } },
  { pattern: '/requests/:id/survey-link', allowed: ['pm', 'ba'], arm: async w => { const r = await newReq(w); return { url: `/requests/${r.id}/survey-link` }; } },
  { pattern: '/requests/:id/continue', allowed: ['pm', 'ba'], arm: async w => { const r = await newReq(w); w.repo.updateRequest(r.id, { stage: 'CLARIFY', status: 'awaiting_customer' }); return { url: `/requests/${r.id}/continue` }; } },
  { pattern: '/requests', variant: 'legacy create is closed', allowed: [], arm: () => ({ url: '/requests', body: { title: 't' } }) },
  { pattern: '/seat/connect', allowed: AUTHED, arm: () => ({ url: '/seat/connect' }) },
  { pattern: '/seat/code', allowed: AUTHED, arm: async (w, _A, actor) => { if (actor !== null) await w.post(actor, '/seat/connect'); return { url: '/seat/code', body: { code: 'CODE-1' } }; } },
  { pattern: '/seat/cancel', allowed: AUTHED, arm: async (w, _A, actor) => { if (actor !== null) await w.post(actor, '/seat/connect'); return { url: '/seat/cancel' }; } },
  { pattern: '/seat/check', allowed: AUTHED, arm: () => ({ url: '/seat/check' }) },
  { pattern: '/seat/logout', allowed: AUTHED, arm: () => ({ url: '/seat/logout' }) },
  { pattern: '/me', allowed: AUTHED, arm: () => ({ url: '/me', body: { gitlab_token: 'tok-123' } }) },
  { pattern: '/admin/users/:id/sys-role', allowed: ADMINS, arm: w => ({ url: `/admin/users/${member(w).id}/sys-role`, body: { sys_role: 'cto' } }) },
  { pattern: '/admin/users/:id/sys-role', variant: 'project member to cto', allowed: [], softRefuse: ADMINS, arm: w => ({ url: `/admin/users/${w.dev.id}/sys-role`, body: { sys_role: 'cto' } }) },
  { pattern: '/admin/users/:id/sys-role', variant: 'project PM to admin', allowed: [], softRefuse: ADMINS, arm: w => ({ url: `/admin/users/${w.pm.id}/sys-role`, body: { sys_role: 'admin' } }) },
  { pattern: '/admin/users/:id/sys-role', variant: 'no department to head', allowed: [], softRefuse: ADMINS, arm: w => ({ url: `/admin/users/${member(w, { dept: null }).id}/sys-role`, body: { sys_role: 'head' } }) },
  { pattern: '/admin/users/:id/department', allowed: ADMINS, arm: w => ({ url: `/admin/users/${member(w, { dept: null }).id}/department`, body: { department_id: String(w.repo.web.getDepartmentByCode('SGLOBAL')!.id) } }) },
  { pattern: '/admin/users/:id/department', variant: 'strip a project member', allowed: [], softRefuse: ADMINS, arm: w => ({ url: `/admin/users/${w.dev.id}/department`, body: { department_id: '' } }) },
  { pattern: '/admin/users/:id/can-pm', allowed: [...ADMINS, 'headSame', 'deputy'], arm: w => ({ url: `/admin/users/${member(w).id}/can-pm`, body: { value: '1' } }) },
  { pattern: '/admin/users/:id/can-pm', variant: 'on self', allowed: ADMINS, arm: (_w, _A, actor) => ({ url: `/admin/users/${actor ?? 1}/can-pm`, body: { value: '1' } }) },
  { pattern: '/admin/users/:id/can-pm', variant: 'on a cto', allowed: ADMINS, arm: (_w, A) => ({ url: `/admin/users/${A.cto}/can-pm`, body: { value: '1' } }) },
  { pattern: '/admin/users/:id/can-pm', variant: 'on a head of the department', allowed: ADMINS, arm: (_w, A) => ({ url: `/admin/users/${A.headSame}/can-pm`, body: { value: '1' } }) },
  { pattern: '/admin/users/:id/disable', allowed: ADMINS, arm: w => ({ url: `/admin/users/${member(w).id}/disable`, body: { value: '1' } }) },
  { pattern: '/dept/pm/:id/can-pm', allowed: [...ADMINS, 'headSame', 'deputy'], arm: w => ({ url: `/dept/pm/${member(w).id}/can-pm`, body: { value: '1' } }) },
  { pattern: '/dept/pm/:id/can-pm', variant: 'on self', allowed: ADMINS, arm: (_w, _A, actor) => ({ url: `/dept/pm/${actor ?? 1}/can-pm`, body: { value: '1' } }) },
  { pattern: '/dept/pm/:id/can-pm', variant: 'on admin', allowed: ADMINS, arm: (_w, A) => ({ url: `/dept/pm/${A.adminOut}/can-pm`, body: { value: '1' } }) },
  { pattern: '/dept/pm/:id/can-pm', variant: 'on another head', allowed: ADMINS, arm: (_w, A) => ({ url: `/dept/pm/${A.headSame}/can-pm`, body: { value: '1' } }) },
  { pattern: '/dept/pm/:id/assign', allowed: ['headSame', 'deputy', 'headOther', 'adminMember'], arm: w => ({ url: `/dept/pm/${member(w, { dept: null }).id}/assign` }) },
  { pattern: '/dept/pm/:id/assign', variant: 'disabled user', allowed: [], arm: w => { const u = member(w, { dept: null }); w.repo.web.setUserDisabled(u.id, true); return { url: `/dept/pm/${u.id}/assign` }; } },
  { pattern: '/dept/pm/:id/assign', variant: 'privileged user', allowed: ['adminMember'], arm: (_w, A) => ({ url: `/dept/pm/${A.cto}/assign` }) },
  { pattern: '/templates/:kind', allowed: ADMINS, arm: async () => ({ url: '/templates/tkct', multipart: { fields: [], file: { name: 'file', filename: 'm.docx', content: await docx() } } }) },
  { pattern: '/templates/:kind/reset', allowed: ADMINS, arm: w => { w.repo.web.setTemplate('tkct', '/x/y.docx'); return { url: '/templates/tkct/reset' }; } },
  { pattern: '/settings', allowed: ADMINS, arm: () => ({ url: '/settings', body: { project_roots: `/srv/p${uniq()}`, seat_concurrency: '2' } }) },
  { pattern: '/users', allowed: ADMINS, arm: () => ({ url: '/users', body: { username: `legacy${uniq()}`, password: 'passw0rd-long', role: 'member' } }) },
  { pattern: '/users/:id/password', allowed: ADMINS, arm: w => ({ url: `/users/${member(w).id}/password`, body: { password: 'another-long-pass' } }) },
  { pattern: '/users/:id/delete', allowed: ADMINS, arm: w => ({ url: `/users/${member(w).id}/delete` }) },
  { pattern: '/projects', allowed: ['pm'], arm: w => ({ url: '/projects', body: { key: `K${uniq()}X`, name: 'p', mode: 'new', path: join(w.root, `p${uniq()}`) } }) },
  { pattern: '/projects/:id/members', allowed: ['pm'], arm: async w => {
    const extra = member(w);
    const body: Record<string, string> = {};
    for (const m of w.repo.listProjectMembers(w.p.id)) if (m.userId !== extra.id) body[`r_${m.userId}`] = m.roles[0]!;
    body[`r_${extra.id}`] = 'DEV';
    return { url: `/projects/${w.p.id}/members`, body };
  } },
  { pattern: '/projects/:id/requests', allowed: ['pm'], arm: w => ({
    url: `/projects/${w.p.id}/requests`,
    multipart: { fields: [['code', `ERP-${100 + uniq()}`], ['title', 't'], ['description', 'd'], ...rolePeople(w).map(([r, id]): [string, string] => [`a_${r}`, String(id)])] },
  }) },
];

function snapshot(w: W): string {
  const reqs = w.repo.listRequests();
  return JSON.stringify({
    reqs: reqs.map(r => [r.id, r.stage, r.status]),
    asg: reqs.flatMap(r => w.repo.listRequestAssignees(r.id).map(a => [r.id, a.role, a.userId, a.position])),
    mem: w.repo.listProjects({ includeArchived: true }).map(p => [p.key, w.repo.listProjectMembers(p.id).map(m => [m.userId, m.roles])]),
    users: w.repo.web.listUsers().map(u => [u.id, u.sysRole, u.departmentId, u.canBePm, u.disabled, u.gitlabTokenEnc, u.passwordHash]),
    crs: reqs.flatMap(r => w.repo.listChangeRequests(r.id).map(c => [r.id, c.id, c.status])),
    ans: reqs.map(r => [...w.repo.latestAnswers(r.id)]),
    tasks: reqs.flatMap(r => w.repo.listTasks(r.id).map(t => [r.id, t.id, t.assigneeId])),
    jobs: w.repo.listJobs().map(j => [j.id, j.status, j.seatUserId]),
    survey: reqs.map(r => w.repo.web.listSurveyLinks(r.id).length),
    audit: w.repo.web.listAudit({ limit: 100000 }).length,
    settings: Object.values(SETTING_KEYS).map(k => w.repo.web.getSetting(k) ?? null),
    roots: w.cfg.projectRoots,
    tpl: w.repo.web.getTemplate('tkct') ?? null,
    seat: [w.logins.length, w.logins.map(l => [l.codes.length, l.cancelled]), w.seats.statusChecks.length],
  });
}

async function actors(w: W): Promise<Record<ActorName, number>> {
  const mk = (n: string, o: Parameters<W['mkUser']>[1], sys?: 'head' | 'deputy' | 'cto' | 'admin') => {
    const u = w.mkUser(n, o);
    if (sys) w.repo.web.setUserSysRole(u.id, sys);
    return u.id;
  };
  const adminMember = mk('adminm', {}, 'admin');
  const cur = w.repo.listProjectMembers(w.p.id).map(m => ({ userId: m.userId, roles: m.roles }));
  await w.svc.setMembers(w.p.id, [...cur, { userId: adminMember, roles: ['DEV'] }], w.pm.id);
  return {
    anon: 0, nodept: mk('nodept', { dept: null }), pm: w.pm.id, ba: w.ba.id, se: w.se.id, dev: w.dev.id, rev: w.rev.id, tester: w.tester.id,
    nonMember: mk('nonmember', {}), otherDept: mk('otherdept', { dept: 'SGLOBAL' }),
    headSame: mk('headsame', {}, 'head'), headOther: mk('headother', { dept: 'SGLOBAL' }, 'head'), deputy: mk('deputy', {}, 'deputy'),
    cto: mk('cto', { dept: null }, 'cto'), adminOut: mk('adminout', { dept: null }, 'admin'), adminMember,
  };
}

async function send(w: W, call: Call, actor: number | null) {
  const cookie = actor === null ? {} : { cookie: w.cookie(actor) };
  if (call.multipart) {
    const b = '----matrix';
    const parts: Buffer[] = call.multipart.fields.map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    const f = call.multipart.file;
    if (f) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.content, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${b}--\r\n`));
    return w.app.inject({ method: 'POST', url: call.url, payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}`, origin: 'http://localhost:3000', host: 'localhost:3000', ...cookie } });
  }
  return w.app.inject({ method: 'POST', url: call.url, payload: enc(call.body ?? {}), headers: { ...formHdr, ...cookie } });
}

describe('role enforcement on every write route', () => {
  it('the table covers every state-changing route (a new route without a row fails here)', async () => {
    const w = await webEnv();
    const registered = new Set(w.routes.filter(r => /^(POST|PUT|PATCH|DELETE) /.test(r) && !EXEMPT.has(r)));
    const covered = new Set(ROWS.map(r => `POST ${r.pattern}`));
    expect([...registered].filter(r => !covered.has(r)), 'write routes missing from the role table').toEqual([]);
    expect([...covered].filter(r => !registered.has(r)), 'table rows for routes that do not exist').toEqual([]);
  });

  for (const row of ROWS) {
    it(`${row.pattern}${row.variant ? ` (${row.variant})` : ''}: ${row.allowed.length ? row.allowed.join('/') : 'nobody'} allowed, everyone else refused`, async () => {
      const w = await webEnv();
      const A = await actors(w);
      for (const name of ACTORS) {
        const actor = name === 'anon' ? null : A[name];
        const call = await row.arm(w, A, actor);
        const before = snapshot(w);
        const res = await send(w, call, actor);
        const after = snapshot(w);
        const cell = `${row.pattern}${row.variant ? ` (${row.variant})` : ''} as ${name}`;
        if (row.allowed.includes(name)) {
          expect([200, 302], `${cell}: status ${res.statusCode}`).toContain(res.statusCode);
          expect(String(res.headers.location ?? ''), `${cell}: error redirect`).not.toContain('err=');
          expect(after, `${cell}: expected a state change`).not.toBe(before);
        } else if (row.softRefuse?.includes(name)) {
          expect(res.statusCode, cell).toBe(302);
          expect(String(res.headers.location ?? ''), `${cell}: refusal message`).toContain('err=');
          expect(after, `${cell}: state must be unchanged`).toBe(before);
        } else {
          if (name === 'anon') {
            expect(res.statusCode, cell).toBe(302);
            expect(String(res.headers.location), cell).toBe('/login');
          } else {
            expect(res.statusCode, cell).toBe(403);
          }
          expect(after, `${cell}: state must be unchanged`).toBe(before);
        }
      }
    }, 120_000);
  }
});
