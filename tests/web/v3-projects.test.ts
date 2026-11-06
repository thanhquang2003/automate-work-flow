import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { webEnv } from './v3-helpers.js';

describe('v3 projects, inbox, admin pages', () => {
  it('head toggles can_be_pm only in own department', async () => {
    const w = await webEnv();
    const head = w.mkUser('head'); w.repo.web.setUserSysRole(head.id, 'head');
    const same = w.mkUser('same');
    const other = w.mkUser('other', { dept: 'SGLOBAL' });
    expect((await w.post(head.id, `/dept/pm/${same.id}/can-pm`, { value: '1' })).statusCode).toBe(302);
    expect(w.repo.web.getUser(same.id)!.canBePm).toBe(true);
    expect((await w.post(head.id, `/dept/pm/${other.id}/can-pm`, { value: '1' })).statusCode).toBe(403);
    expect(w.repo.web.getUser(other.id)!.canBePm).toBe(false);
    expect(w.repo.web.listAudit().map(a => a.action)).toContain('user.setCanBePm');
  });

  it('head cannot change sysRole', async () => {
    const w = await webEnv();
    const head = w.mkUser('head'); w.repo.web.setUserSysRole(head.id, 'head');
    const t = w.mkUser('t');
    expect((await w.post(head.id, `/admin/users/${t.id}/sys-role`, { sys_role: 'admin' })).statusCode).toBe(403);
    expect(w.repo.web.getUser(t.id)!.sysRole).toBe('member');
    expect((await w.get(head.id, '/admin/users')).statusCode).toBe(403);
  });

  it("unassigned user shown to head and assigned to head's department", async () => {
    const w = await webEnv();
    const head = w.mkUser('head'); w.repo.web.setUserSysRole(head.id, 'head');
    const un = w.mkUser('nodept', { dept: null });
    const priv = w.mkUser('priv', { dept: null }); w.repo.web.setUserSysRole(priv.id, 'cto');
    const page = await w.get(head.id, '/dept/pm');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('nodept@x.com');
    expect(page.body).not.toContain('priv@x.com');
    expect((await w.post(head.id, `/dept/pm/${un.id}/assign`)).statusCode).toBe(302);
    expect(w.repo.web.getUser(un.id)!.departmentId).toBe(head.departmentId);
    expect((await w.post(head.id, `/dept/pm/${priv.id}/assign`)).statusCode).toBe(403);
  });

  it('project member picker only offers same department', async () => {
    const w = await webEnv();
    w.mkUser('sg', { dept: 'SGLOBAL' });
    w.mkUser('nod', { dept: null });
    const body = (await w.get(w.pm.id, `/projects/${w.p.id}`)).body;
    expect(body).toContain('ba@x.com');
    expect(body).not.toContain('sg@x.com');
    expect(body).not.toContain('nod@x.com');
    const sg = w.repo.web.getUserByEmail('sg@x.com')!;
    const cur = Object.fromEntries(w.repo.listProjectMembers(w.p.id).flatMap(m => m.roles.map(r => [`r_${m.userId}`, r])));
    const res = await w.post(w.pm.id, `/projects/${w.p.id}/members`, { ...cur, [`r_${sg.id}`]: 'DEV' });
    expect(res.statusCode).toBe(403);
    expect(w.repo.getProjectMember(w.p.id, sg.id)).toBeUndefined();
  });

  it('members editor keeps several people per role and the PM', async () => {
    const w = await webEnv();
    const dev2 = w.mkUser('dev2');
    const body: Record<string, string> = {};
    for (const m of w.repo.listProjectMembers(w.p.id)) body[`r_${m.userId}`] = m.roles[0]!;
    body[`r_${dev2.id}`] = 'DEV';
    expect((await w.post(w.pm.id, `/projects/${w.p.id}/members`, body)).headers.location).toContain('ok=');
    expect(w.repo.listProjectMembersWithRole(w.p.id, 'DEV')).toHaveLength(2);
    delete body[`r_${w.pm.id}`];
    expect(String((await w.post(w.pm.id, `/projects/${w.p.id}/members`, body)).headers.location)).toContain('err=');
  });

  it('project create rejects path outside roots', async () => {
    const w = await webEnv();
    const res = await w.post(w.pm.id, '/projects', { key: 'OUT', name: 'o', mode: 'new', path: '/tmp/elsewhere-xyz' });
    expect(res.statusCode).toBe(400);
    expect(w.repo.getProjectByKey('OUT')).toBeUndefined();
    const dev = await w.post(w.dev.id, '/projects', { key: 'OUT', name: 'o', mode: 'new', path: join(w.root, 'o') });
    expect(dev.statusCode).toBe(403);
    const ok = await w.post(w.pm.id, '/projects', { key: 'NEW', name: 'n', mode: 'new', path: join(w.root, 'new') });
    expect(ok.statusCode).toBe(302);
    expect(w.repo.getProjectByKey('NEW')).toBeDefined();
  });

  it('request code validation and uniqueness', async () => {
    const w = await webEnv();
    const page = (await w.get(w.pm.id, `/projects/${w.p.id}/requests/new`)).body;
    expect(page).toContain('ERP-001');
    const mp = (fields: [string, string][]) => {
      const b = '----t';
      const payload = fields.map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${b}--\r\n`;
      return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}`, origin: 'http://localhost:3000', host: 'localhost:3000', cookie: w.cookie(w.pm.id) } };
    };
    const base: [string, string][] = [['title', 't'], ['description', 'd']];
    const send = (code: string) => w.app.inject({ method: 'POST', url: `/projects/${w.p.id}/requests`, ...mp([['code', code], ...base]) });
    expect((await send('bad code!')).statusCode).toBe(400);
    expect((await send('ERP-001')).statusCode).toBe(302);
    expect((await send('erp-001')).statusCode).toBe(400);
    expect(w.repo.listRequestsByProject(w.p.id)).toHaveLength(1);
    expect(w.repo.listRequestAssignees(w.repo.listRequestsByProject(w.p.id)[0]!.id, 'DEV').length).toBeGreaterThan(0);
    // non-PM
    const dev = await w.app.inject({ method: 'POST', url: `/projects/${w.p.id}/requests`, ...mp([['code', 'ERP-009'], ...base]), headers: { ...mp([]).headers, cookie: w.cookie(w.dev.id) } });
    expect(dev.statusCode).toBe(403);
  });

  it('inbox lists my pending gates', async () => {
    const w = await webEnv();
    const r = await w.svc.createRequest({ projectId: w.p.id, code: 'ERP-001', title: 'Cổng chờ', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by: w.pm.id });
    w.repo.updateRequest(r.id, { stage: 'ANALYSIS', status: 'awaiting_approval' });
    expect((await w.get(w.ba.id, '/')).body).toContain('Cổng chờ');
    expect((await w.get(w.pm.id, '/')).body).toContain('Cổng chờ');
    expect((await w.get(w.dev.id, '/')).body).not.toContain('Cổng chờ');
    // dev sees the project but no gate
    expect((await w.get(w.dev.id, '/')).body).toContain('ERP');
  });

  it('admin pages admin-only', async () => {
    const w = await webEnv();
    const admin = w.mkUser('adm'); w.repo.web.setUserSysRole(admin.id, 'admin');
    for (const u of [w.pm.id, w.dev.id]) {
      expect((await w.get(u, '/admin/users')).statusCode).toBe(403);
      expect((await w.get(u, '/settings')).statusCode).toBe(403);
    }
    expect((await w.get(admin.id, '/admin/users')).statusCode).toBe(200);
    expect((await w.get(admin.id, '/settings')).body).toContain('PROJECT_ROOTS');
    expect((await w.post(admin.id, `/admin/users/${w.dev.id}/sys-role`, { sys_role: 'cto' })).statusCode).toBe(302);
    expect(w.repo.web.getUser(w.dev.id)!.sysRole).toBe('cto');
    expect((await w.post(admin.id, '/settings', { project_roots: '/srv/p, /srv/q', seat_concurrency: '2' })).headers.location).toContain('ok=');
    expect(w.cfg.projectRoots).toEqual(['/srv/p', '/srv/q']);
  });
});
