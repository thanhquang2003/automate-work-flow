import { describe, expect, it } from 'vitest';
import { can, canBeProjectMember, type Actor } from '../../src/security/permissions.js';
import type { ProjectRole, SysRole } from '../../src/domain/types.js';

const actor = (o: Partial<Actor> = {}): Actor => ({ userId: 1, sysRole: 'member', departmentId: 1, canBePm: false, projectRoles: [], ...o });
const roles = (...r: ProjectRole[]) => actor({ projectRoles: r });
const gate = (stage: string, part?: string) => ({ type: 'gate.approve' as const, stage: stage as never, part });
const proj = { project: { departmentId: 1 } };

describe('permissions', () => {
  it('head cannot act on other department', () => {
    const head = actor({ sysRole: 'head', departmentId: 1 });
    expect(can(head, 'user.setCanBePm', { targetUser: { departmentId: 1 } })).toBe(true);
    expect(can(head, 'user.setCanBePm', { targetUser: { departmentId: 2 } })).toBe(false);
    expect(can(head, 'oversight.view', { project: { departmentId: 2 } })).toBe(false);
    expect(can(head, 'oversight.content', { project: { departmentId: 1 } })).toBe(true);
    expect(can(head, 'user.setDepartment', { targetUser: { departmentId: null, sysRole: 'member' }, targetDepartmentId: 2 })).toBe(false);
    expect(can(head, 'user.setDepartment', { targetUser: { departmentId: null, sysRole: 'member' }, targetDepartmentId: 1 })).toBe(true);
    expect(can(head, 'user.setDepartment', { targetUser: { departmentId: 2 }, targetDepartmentId: 1 })).toBe(false);
  });
  it('head cannot set sysRole', () => {
    for (const r of ['head', 'deputy', 'cto', 'member'] as SysRole[]) expect(can(actor({ sysRole: r }), 'user.setSysRole', {})).toBe(false);
    expect(can(actor({ sysRole: 'admin', departmentId: null }), 'user.setSysRole', {})).toBe(true);
  });
  it('cto read-only', () => {
    const cto = actor({ sysRole: 'cto', departmentId: null });
    expect(can(cto, 'oversight.view', {})).toBe(true);
    expect(can(cto, 'oversight.content', { project: { departmentId: 2 } })).toBe(true);
    for (const a of ['project.create', 'project.members.edit', 'request.create', 'task.assign', 'cr.decide', 'user.setCanBePm', 'user.setSysRole', 'user.setDepartment', 'admin.settings'] as const) {
      expect(can(cto, a, proj)).toBe(false);
    }
    expect(can(cto, gate('ANALYSIS'), proj)).toBe(false);
  });
  it('admin has no project rights without membership', () => {
    const admin = actor({ sysRole: 'admin', departmentId: null });
    for (const a of ['project.create', 'project.members.edit', 'request.create', 'task.assign', 'cr.decide'] as const) expect(can(admin, a, proj)).toBe(false);
    expect(can(admin, gate('PLANNING'), proj)).toBe(false);
    expect(can(admin, 'oversight.view', proj)).toBe(true);
    expect(can(admin, 'admin.settings', {})).toBe(true);
    expect(can({ ...admin, projectRoles: ['PM'] }, 'request.create', proj)).toBe(true);
  });
  it('PLANNING approvable by PM only', () => {
    expect(can(roles('PM'), gate('PLANNING', 'DEV'), proj)).toBe(true);
    for (const r of ['BA', 'SE', 'DEV', 'REVIEWER', 'TESTER'] as ProjectRole[]) expect(can(roles(r), gate('PLANNING'), proj)).toBe(false);
  });
  it('REVIEWER approves DEVELOP', () => {
    expect(can(roles('REVIEWER'), gate('DEVELOP'), proj)).toBe(true);
    expect(can(roles('DEV'), gate('DEVELOP'), proj)).toBe(false);
  });
  it('DEV cannot approve DESIGN', () => {
    expect(can(roles('DEV'), gate('DESIGN'), proj)).toBe(false);
    expect(can(roles('SE'), gate('DESIGN'), proj)).toBe(true);
    expect(can(roles('PM'), gate('DESIGN'), proj)).toBe(true);
  });
  it('any assignee of a role may approve its gate', () => {
    const a = actor({ userId: 10, projectRoles: ['BA'] });
    const b = actor({ userId: 11, projectRoles: ['BA', 'DEV'] });
    for (const x of [a, b]) for (const s of ['ANALYSIS', 'CLARIFY', 'BREAKDOWN']) expect(can(x, gate(s), proj)).toBe(true);
    // not assigned to this request in that role
    expect(can(a, gate('ANALYSIS'), { ...proj, requestRoles: ['SE'] })).toBe(false);
  });
  it('user without department cannot be added to a project', () => {
    expect(canBeProjectMember(null, 1)).toBe(false);
    expect(canBeProjectMember(2, 1)).toBe(false);
    expect(canBeProjectMember(1, 1)).toBe(true);
    const pm = roles('PM');
    expect(can(pm, 'project.members.edit', { project: { departmentId: 1 }, memberDepartmentIds: [1, null] })).toBe(false);
    expect(can(pm, 'project.members.edit', { project: { departmentId: 1 }, memberDepartmentIds: [1, 2] })).toBe(false);
    expect(can(pm, 'project.members.edit', { project: { departmentId: 1 }, memberDepartmentIds: [1, 1] })).toBe(true);
    expect(can(actor({ projectRoles: ['DEV'] }), 'project.members.edit', proj)).toBe(false);
  });
  it('project.create needs can_be_pm and a department; unknown roles deny', () => {
    expect(can(actor({ canBePm: true }), 'project.create')).toBe(true);
    expect(can(actor({ canBePm: true, departmentId: null }), 'project.create')).toBe(false);
    expect(can(actor({ canBePm: false }), 'project.create')).toBe(false);
    expect(can(actor({ sysRole: 'root' as never, canBePm: true }), 'project.create')).toBe(false);
    expect(can(actor({ projectRoles: ['SA' as never] }), 'request.create', proj)).toBe(false);
  });
  it('head cannot attach privileged users to a department, nor toggle can_be_pm outside it', () => {
    for (const hs of ['head', 'deputy'] as SysRole[]) {
      const h = actor({ sysRole: hs, departmentId: 1 });
      for (const t of ['admin', 'cto', 'head', 'deputy'] as SysRole[]) {
        expect(can(h, 'user.setDepartment', { targetUser: { departmentId: null, sysRole: t }, targetDepartmentId: 1 })).toBe(false);
      }
      expect(can(h, 'user.setDepartment', { targetUser: { departmentId: null, sysRole: 'member' }, targetDepartmentId: 1 })).toBe(true);
      expect(can(h, 'user.setDepartment', { targetUser: { departmentId: null }, targetDepartmentId: 1 })).toBe(false);
      expect(can(h, 'user.setCanBePm', { targetUser: { departmentId: null, sysRole: 'admin' } })).toBe(false);
      expect(can(h, 'user.setCanBePm', { targetUser: { departmentId: 2, sysRole: 'member' } })).toBe(false);
    }
    expect(can(actor({ sysRole: 'admin', departmentId: null }), 'user.setDepartment', { targetUser: { departmentId: null, sysRole: 'cto' }, targetDepartmentId: 1 })).toBe(true);
  });
  it('stages without an approver cannot be approved by anyone; DONE and CHANGE are PM only', () => {
    const all: ProjectRole[] = ['PM', 'BA', 'SE', 'DEV', 'REVIEWER', 'TESTER'];
    for (const st of ['TEST', 'BUGFIX', 'INTAKE']) for (const r of all) expect(can(roles(r), gate(st), proj)).toBe(false);
    for (const st of ['DONE', 'CHANGE', 'PLANNING']) for (const r of all) expect(can(roles(r), gate(st), proj)).toBe(r === 'PM');
    expect(can(roles('REVIEWER'), gate('DEVELOP'), proj)).toBe(true);
  });
  it('cr.decide is PM only', () => {
    expect(can(roles('PM'), 'cr.decide', proj)).toBe(true);
    for (const r of ['BA', 'SE', 'DEV', 'REVIEWER', 'TESTER'] as ProjectRole[]) expect(can(roles(r), 'cr.decide', proj)).toBe(false);
  });
});
