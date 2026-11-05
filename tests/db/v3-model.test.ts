import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import type { NewRequest } from '../../src/domain/types.js';

const base: NewRequest = {
  title: 't', description: 'd', perfReq: '', nonfuncReq: '',
  projectKind: 'new', gitlabProject: null, softwareTypes: ['web'], runMode: 'auto', createdBy: null,
};

let repo: Repo;
beforeEach(() => { repo = new Repo(openDb(':memory:')); });

function mkProject(key = 'ERP') {
  const dev = repo.web.getDepartmentByCode('DEV')!;
  return repo.createProject({ key, name: key, path: `/srv/p/${key}`, departmentId: dev.id, createdBy: null });
}

describe('v3 data model', () => {
  it('schema is idempotent on an existing dev db', () => {
    const file = join(tmpdir(), `devflow-v3-${Date.now()}.db`);
    const a = openDb(file);
    a.prepare("insert into users(username,password_hash,role,created_at) values('old','h','admin',1)").run();
    a.close();
    const b = openDb(file);
    const c = openDb(file);
    expect(b.prepare('select count(*) c from departments').get()).toEqual({ c: 2 });
    const u = new Repo(c).web.getUserByUsername('old')!;
    expect(u.sysRole).toBe('member');
    expect(u.canBePm).toBe(false);
    expect(u.departmentId).toBeNull();
    b.close(); c.close();
  });

  it('departments seeded', () => {
    expect(repo.web.listDepartments().map(d => d.code)).toEqual(['DEV', 'SGLOBAL']);
  });

  it('request code unique per project', () => {
    const a = mkProject('ERP');
    const b = mkProject('CRM');
    repo.createRequest({ ...base, projectId: a.id, code: 'ERP-001' });
    expect(() => repo.createRequest({ ...base, projectId: a.id, code: 'ERP-001' })).toThrow();
    expect(repo.createRequest({ ...base, projectId: b.id, code: 'ERP-001' }).code).toBe('ERP-001');
    expect(repo.isRequestCodeTaken(a.id, 'ERP-001')).toBe(true);
    expect(repo.isRequestCodeTaken(a.id, 'ERP-002')).toBe(false);
  });

  it('suggestRequestCode ERP-001 then ERP-002', () => {
    const p = mkProject('ERP');
    expect(repo.suggestRequestCode(p.id)).toBe('ERP-001');
    repo.createRequest({ ...base, projectId: p.id, code: 'ERP-001' });
    expect(repo.suggestRequestCode(p.id)).toBe('ERP-002');
  });

  it('request_assignees allows several users per role ordered by position', () => {
    const r = repo.createRequest(base);
    const u1 = repo.web.createUser({ username: 'a', passwordHash: 'x', role: 'member' });
    const u2 = repo.web.createUser({ username: 'b', passwordHash: 'x', role: 'member' });
    const u3 = repo.web.createUser({ username: 'c', passwordHash: 'x', role: 'member' });
    repo.setRequestAssignees(r.id, 'DEV', [u3.id, u1.id, u2.id]);
    expect(repo.listRequestAssignees(r.id, 'DEV').map(a => [a.userId, a.position])).toEqual([[u3.id, 0], [u1.id, 1], [u2.id, 2]]);
    expect(repo.getRunner(r.id, 'DEV')).toBe(u3.id);
    repo.setRequestAssignees(r.id, 'DEV', [u2.id, u3.id]);
    expect(repo.getRunner(r.id, 'DEV')).toBe(u2.id);
  });

  it('members, approvals, audit, task assignee and job seat round-trip', () => {
    const p = mkProject();
    const u = repo.web.upsertGoogleUser({ email: 'A@X.com', googleSub: 's1', displayName: 'A' });
    expect(u.created).toBe(true);
    expect(repo.web.upsertGoogleUser({ email: 'a@x.com', googleSub: 's1', displayName: 'A2' }).created).toBe(false);
    repo.setProjectMember(p.id, u.user.id, ['PM', 'DEV'], null);
    expect(repo.getProjectMember(p.id, u.user.id)!.roles).toEqual(['PM', 'DEV']);
    expect(repo.listProjectsForUser(u.user.id).map(x => x.id)).toEqual([p.id]);
    const r = repo.createRequest({ ...base, projectId: p.id, code: 'ERP-001' });
    repo.addApproval({ requestId: r.id, stage: 'DESIGN', userId: u.user.id, decision: 'approve' });
    expect(repo.listApprovals(r.id, 'DESIGN')).toHaveLength(1);
    repo.web.addAudit({ projectId: p.id, userId: u.user.id, action: 'x', detail: 'y' });
    expect(repo.web.listAudit({ projectId: p.id })).toHaveLength(1);
    repo.upsertTask(r.id, { id: 'T1', title: 't', featureId: null, dependsOn: [], status: 'todo', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: 'active', changedByCr: null });
    repo.setTaskAssignee(r.id, 'T1', u.user.id);
    expect(repo.getTask(r.id, 'T1')!.assigneeId).toBe(u.user.id);
    expect(repo.enqueueJob(r.id, 'k', {}, 0, u.user.id).seatUserId).toBe(u.user.id);
    repo.updateRequest(r.id, { status: 'awaiting_seat' });
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_seat');
  });
});
