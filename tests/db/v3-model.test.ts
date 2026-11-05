import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import type { NewRequest } from '../../src/domain/types.js';

const base: NewRequest = {
  title: 't', description: 'd', perfReq: '', nonfuncReq: '',
  projectKind: 'new', gitlabProject: null, softwareTypes: ['web'], runMode: 'auto', createdBy: null,
};

const OLD_V2_DDL = `
create table if not exists users(
  id integer primary key autoincrement,
  username text not null unique,
  password_hash text not null,
  role text not null default 'member',
  gitlab_token_enc text,
  created_at integer not null
);
create table if not exists requests(
  id text primary key,
  title text not null,
  description text not null default '',
  perf_req text not null default '',
  nonfunc_req text not null default '',
  project_kind text not null default 'new',
  gitlab_project text,
  software_types text not null default '[]',
  run_mode text not null default 'auto',
  stage text not null default 'INTAKE',
  status text not null default 'running',
  clarify_round integer not null default 0,
  created_by integer,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists tasks(
  request_id text not null,
  id text not null,
  title text not null,
  feature_id text,
  depends_on text not null default '[]',
  status text not null default 'todo',
  review_rounds integer not null default 0,
  branch text,
  mr_iid integer,
  primary key(request_id, id)
);
create table if not exists jobs(
  id integer primary key autoincrement,
  request_id text,
  kind text not null,
  payload text not null default '{}',
  status text not null default 'queued',
  run_after integer not null default 0,
  attempts integer not null default 0,
  last_error text
);
`;

let repo: Repo;
beforeEach(() => { repo = new Repo(openDb(':memory:')); });

function mkProject(key = 'ERP') {
  const dev = repo.web.getDepartmentByCode('DEV')!;
  return repo.createProject({ key, name: key, path: `/srv/p/${key}`, departmentId: dev.id, createdBy: null });
}

describe('v3 data model', () => {
  it('schema is idempotent on an existing dev db', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'devflow-v3-')), 'old.db');
    try {
      // hand-built pre-v3 tables (no v3 columns), one row in each
      const old = new DatabaseSync(file);
      old.exec(OLD_V2_DDL);
      old.exec(`insert into users(username,password_hash,role,created_at) values('old','h','admin',1);
        insert into requests(id,title,created_at,updated_at) values('REQ-001','t',1,1);
        insert into tasks(request_id,id,title) values('REQ-001','T1','x');
        insert into jobs(request_id,kind) values('REQ-001','k');`);
      old.close();
      const b = openDb(file);
      const c = openDb(file); // second call must not throw
      const cols = (t: string) => (c.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map(x => x.name);
      expect(cols('users')).toEqual(expect.arrayContaining(['email', 'google_sub', 'display_name', 'sys_role', 'department_id', 'can_be_pm', 'os_user', 'disabled']));
      expect(cols('requests')).toEqual(expect.arrayContaining(['project_id', 'code']));
      expect(cols('tasks')).toContain('assignee_id');
      expect(cols('jobs')).toContain('seat_user_id');
      expect(c.prepare('select count(*) c from departments').get()).toEqual({ c: 2 });
      const r = new Repo(c);
      const u = r.web.getUserByUsername('old')!;
      expect([u.role, u.sysRole, u.canBePm, u.departmentId]).toEqual(['admin', 'member', false, null]);
      expect(r.getRequest('REQ-001')!.title).toBe('t');
      expect(r.getTask('REQ-001', 'T1')!.assigneeId).toBeNull();
      expect(r.listJobs('REQ-001')).toHaveLength(1);
      b.close(); c.close();
    } finally { rmSync(dirname(file), { recursive: true, force: true }); }
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

  it('setRequestAssignees joins an outer repo.tx() and rolls back with it', () => {
    const r = repo.createRequest(base);
    const u1 = repo.web.createUser({ username: 'a', passwordHash: 'x', role: 'member' });
    const u2 = repo.web.createUser({ username: 'b', passwordHash: 'x', role: 'member' });
    repo.tx(() => { repo.setRequestAssignees(r.id, 'DEV', [u1.id]); repo.setRequestAssignees(r.id, 'BA', [u2.id]); });
    expect(repo.listRequestAssignees(r.id)).toHaveLength(2);
    expect(() => repo.tx(() => {
      repo.setRequestAssignees(r.id, 'DEV', [u2.id, u1.id]);
      throw new Error('boom');
    })).toThrow('boom');
    expect(repo.listRequestAssignees(r.id, 'DEV').map(a => a.userId)).toEqual([u1.id]);
    // failure inside setRequestAssignees itself (bad user id type) rolls back its own delete
    expect(() => repo.setRequestAssignees(r.id, 'DEV', [u2.id, undefined as unknown as number])).toThrow();
    expect(repo.listRequestAssignees(r.id, 'DEV').map(a => a.userId)).toEqual([u1.id]);
  });
});
