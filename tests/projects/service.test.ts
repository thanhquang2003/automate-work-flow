import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionError, ProjectError } from '../../src/projects/service.js';
import { fullProject, git, mkEnv, mkGitRepo, mkUser } from './helpers.js';

const reqIn = (e: ReturnType<typeof mkEnv>, projectId: number, code: string, by = e.pm.id) =>
  e.svc.createRequest({ projectId, code, title: 't', description: 'd', perfReq: '', nonfuncReq: '', softwareTypes: ['web'], runMode: 'review', by });

describe('createProject', () => {
  it('create new project inits repo and exclude', async () => {
    const e = mkEnv();
    const path = join(e.root, 'erp');
    const p = await e.svc.createProject({ mode: 'new', key: 'ERP', name: 'ERP', path, createdBy: e.pm.id });
    expect(p.departmentId).toBe(e.pm.departmentId);
    expect(p.path).toBe(path);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(p.defaultBranch);
    expect(git(path, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(readFileSync(join(path, '.git', 'info', 'exclude'), 'utf8')).toContain('.devflow/');
    expect(e.repo.getProjectMember(p.id, e.pm.id)!.roles).toEqual(['PM']);
    expect(e.ops.groups).toEqual([[p.id, path]]);
    expect(e.repo.web.listAudit({ projectId: p.id }).map(a => a.action)).toContain('project.create');
  });
  it('existing non-git non-empty folder rejected', async () => {
    const e = mkEnv();
    const path = join(e.root, 'legacy'); mkdirSync(path); writeFileSync(join(path, 'x.txt'), 'x');
    await expect(e.svc.createProject({ mode: 'existing', key: 'LG', name: 'L', path, createdBy: e.pm.id })).rejects.toThrow(ProjectError);
    expect(e.repo.getProjectByKey('LG')).toBeUndefined();
    expect(existsSync(join(path, '.git'))).toBe(false);
  });
  it('existing git repo and empty folder are accepted; default branch is kept', async () => {
    const e = mkEnv();
    const g = join(e.root, 'g'); mkGitRepo(g, 'trunk');
    const p1 = await e.svc.createProject({ mode: 'existing', key: 'GG', name: 'g', path: g, createdBy: e.pm.id });
    expect(p1.defaultBranch).toBe('trunk');
    expect(git(g, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
    expect(readFileSync(join(g, '.git', 'info', 'exclude'), 'utf8')).toContain('.devflow/');
    const em = join(e.root, 'em'); mkdirSync(em);
    const p2 = await e.svc.createProject({ mode: 'existing', key: 'EM', name: 'e', path: em, createdBy: e.pm.id });
    expect(git(em, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(p2.id).not.toBe(p1.id);
  });
  it('clone mode clones the GitLab project', async () => {
    const e = mkEnv();
    const bare = join(e.base, 'r.git'); const seed = join(e.base, 'seed');
    mkGitRepo(seed, 'main'); git(e.base, 'clone', '-q', '--bare', seed, bare);
    const gitlab = { getProject: async () => ({ id: 3, path_with_namespace: 'g/a', default_branch: 'main', http_url_to_repo: bare }) } as any;
    const { ProjectService } = await import('../../src/projects/service.js');
    const svc = new ProjectService({ cfg: e.cfg, repo: e.repo, systemOps: e.systemOps, gitlab });
    const path = join(e.root, 'cl');
    const p = await svc.createProject({ mode: 'clone', key: 'CL', name: 'c', path, gitlabProject: 'g/a', createdBy: e.pm.id });
    expect(existsSync(join(path, 'a.txt'))).toBe(true);
    expect(p.gitlabProject).toBe('g/a');
    expect(readFileSync(join(path, '.git', 'info', 'exclude'), 'utf8')).toContain('.devflow/');
  });
  it('rejects paths outside roots, symlink escapes, duplicate path and key', async () => {
    const e = mkEnv();
    const out = join(e.base, 'out'); mkdirSync(out);
    symlinkSync(out, join(e.root, 'lnk'));
    for (const path of [out, join(e.root, 'lnk', 'x'), `${e.root}/../out/y`]) {
      await expect(e.svc.createProject({ mode: 'new', key: 'AA', name: 'a', path, createdBy: e.pm.id })).rejects.toThrow();
    }
    expect(existsSync(join(out, 'x'))).toBe(false);
    await e.svc.createProject({ mode: 'new', key: 'AA', name: 'a', path: join(e.root, 'a'), createdBy: e.pm.id });
    await expect(e.svc.createProject({ mode: 'existing', key: 'BB', name: 'b', path: join(e.root, 'a'), createdBy: e.pm.id })).rejects.toThrow(/đã thuộc/);
    await expect(e.svc.createProject({ mode: 'new', key: 'AA', name: 'b', path: join(e.root, 'b'), createdBy: e.pm.id })).rejects.toThrow(/key/i);
    await expect(e.svc.createProject({ mode: 'new', key: 'CC', name: 'c', path: join(e.root, 'a', 'sub'), createdBy: e.pm.id })).rejects.toThrow(/lồng/);
  });
  it('needs can_be_pm and a department', async () => {
    const e = mkEnv();
    const plain = mkUser(e.repo, 'plain@x.com');
    const nodept = mkUser(e.repo, 'nd@x.com', { dept: null, canBePm: true });
    for (const u of [plain, nodept]) {
      await expect(e.svc.createProject({ mode: 'new', key: 'ZZ', name: 'z', path: join(e.root, 'z'), createdBy: u.id })).rejects.toThrow(PermissionError);
    }
    expect(existsSync(join(e.root, 'z'))).toBe(false);
  });
});

describe('members', () => {
  it('member from another department rejected', async () => {
    const e = mkEnv(); const f = await fullProject(e);
    const other = mkUser(e.repo, 'sg@x.com', { dept: 'SGLOBAL' });
    const nodept = mkUser(e.repo, 'nd2@x.com', { dept: null });
    const cur = e.repo.listProjectMembers(f.p.id).map(m => ({ userId: m.userId, roles: m.roles }));
    for (const u of [other, nodept]) {
      await expect(e.svc.setMembers(f.p.id, [...cur, { userId: u.id, roles: ['DEV'] }], e.pm.id)).rejects.toThrow(PermissionError);
    }
    expect(e.repo.getProjectMember(f.p.id, other.id)).toBeUndefined();
  });
  it('PM cannot be removed as last PM', async () => {
    const e = mkEnv(); const f = await fullProject(e);
    await expect(e.svc.setMembers(f.p.id, [{ userId: f.dev.id, roles: ['DEV'] }], e.pm.id)).rejects.toThrow(/PM/);
    await expect(e.svc.setMembers(f.p.id, [{ userId: e.pm.id, roles: ['BA'] }], e.pm.id)).rejects.toThrow(/PM/);
    expect(e.repo.getProjectMember(f.p.id, e.pm.id)!.roles).toContain('PM');
  });
  it('rejects unknown roles at service and repo level', async () => {
    const e = mkEnv(); const f = await fullProject(e);
    await expect(e.svc.setMembers(f.p.id, [{ userId: e.pm.id, roles: ['PM', 'SA' as any] }], e.pm.id)).rejects.toThrow(/SA/);
    expect(() => e.repo.setProjectMember(f.p.id, f.dev.id, ['BOSS' as any], null)).toThrow(/BOSS/);
    expect(() => e.repo.setRequestAssignees('REQ-001', 'SA' as any, [f.dev.id])).toThrow(/SA/);
  });
  it('only a PM of the project may edit; systemOps and audit called; removal clears assignees', async () => {
    const e = mkEnv(); const f = await fullProject(e);
    const r = await reqIn(e, f.p.id, 'ERP-001');
    const cur = e.repo.listProjectMembers(f.p.id).map(m => ({ userId: m.userId, roles: m.roles }));
    await expect(e.svc.setMembers(f.p.id, cur, f.dev.id)).rejects.toThrow(PermissionError);
    const outsider = mkUser(e.repo, 'out@x.com', { canBePm: true });
    await expect(e.svc.setMembers(f.p.id, cur, outsider.id)).rejects.toThrow(PermissionError);
    e.ops.members.length = 0;
    await e.svc.setMembers(f.p.id, cur.filter(m => m.userId !== f.dev.id), e.pm.id);
    expect(e.ops.members).toHaveLength(1);
    expect(e.ops.members[0]![1].sort()).toEqual(cur.filter(m => m.userId !== f.dev.id).map(m => m.userId).sort());
    expect(e.repo.getProjectMember(f.p.id, f.dev.id)).toBeUndefined();
    expect(e.repo.listRequestAssignees(r.id, 'DEV')).toEqual([]);
    expect(e.repo.web.listAudit({ projectId: f.p.id }).map(a => a.action)).toContain('project.members.set');
  });
});

describe('assignees', () => {
  it('setAssignees validates role membership, order and permission', async () => {
    const e = mkEnv(); const f = await fullProject(e);
    const dev2 = mkUser(e.repo, 'dev2@x.com');
    await e.svc.setMembers(f.p.id, [...e.repo.listProjectMembers(f.p.id).map(m => ({ userId: m.userId, roles: m.roles })), { userId: dev2.id, roles: ['DEV'] }], e.pm.id);
    const r = await reqIn(e, f.p.id, 'ERP-001');
    e.svc.setAssignees(r.id, 'DEV', [dev2.id, f.dev.id], e.pm.id);
    expect(e.repo.listRequestAssignees(r.id, 'DEV').map(a => a.userId)).toEqual([dev2.id, f.dev.id]);
    expect(() => e.svc.setAssignees(r.id, 'DEV', [f.ba.id], e.pm.id)).toThrow(ProjectError);
    expect(() => e.svc.setAssignees(r.id, 'DEV', [], e.pm.id)).toThrow(ProjectError);
    expect(() => e.svc.setAssignees(r.id, 'SA' as any, [f.dev.id], e.pm.id)).toThrow(/SA/);
    expect(() => e.svc.setAssignees(r.id, 'DEV', [f.dev.id], f.dev.id)).toThrow(PermissionError);
    expect(e.repo.listRequestAssignees(r.id, 'DEV').map(a => a.userId)).toEqual([dev2.id, f.dev.id]);
    expect(e.repo.web.listAudit({ requestId: r.id }).map(a => a.action)).toContain('request.assignees.set');
  });
});

describe('createRequest', () => {
  it('request code rule: format, unique per project, branch collision', async () => {
    const e = mkEnv(); const f = await fullProject(e);
    for (const bad of ['', 'a b', 'a/b', '..', '.', 'x'.repeat(41), 'a..b', 'a.lock']) {
      await expect(reqIn(e, f.p.id, bad)).rejects.toThrow(ProjectError);
    }
    const r = await reqIn(e, f.p.id, 'ERP-001');
    expect(r.code).toBe('ERP-001'); expect(r.projectId).toBe(f.p.id);
    await expect(reqIn(e, f.p.id, 'ERP-001')).rejects.toThrow(/đã/);
    await expect(reqIn(e, f.p.id, 'erp-001')).rejects.toThrow(/đã/);
    await expect(reqIn(e, f.p.id, 'ERP-001-T1')).rejects.toThrow(/tiền tố|trùng/);
    git(f.p.path, 'branch', 'devflow/LEGACY');
    await expect(reqIn(e, f.p.id, 'LEGACY')).rejects.toThrow(/nhánh/);
    // same code allowed in another project
    const f2 = await fullProject(e, 'CRM');
    expect((await reqIn(e, f2.p.id, 'ERP-001')).projectId).toBe(f2.p.id);
  });
  it('request blocked when a needed role has no member', async () => {
    const e = mkEnv();
    const p = await e.svc.createProject({ mode: 'new', key: 'ERP', name: 'e', path: join(e.root, 'erp'), createdBy: e.pm.id });
    await expect(reqIn(e, p.id, 'ERP-001')).rejects.toThrow(/BA/);
    expect(e.repo.isRequestCodeTaken(p.id, 'ERP-001')).toBe(false);
  });
  it('assigns all members of each role in order, audits, and needs PM', async () => {
    const e = mkEnv(); const f = await fullProject(e);
    await expect(reqIn(e, f.p.id, 'ERP-009', f.dev.id)).rejects.toThrow(PermissionError);
    const r = await reqIn(e, f.p.id, 'ERP-002');
    expect(e.repo.getRunner(r.id, 'BA')).toBe(f.ba.id);
    expect(e.repo.getRunner(r.id, 'PM')).toBe(e.pm.id);
    expect(e.repo.web.listAudit({ requestId: r.id }).map(a => a.action)).toContain('request.create');
  });
});
