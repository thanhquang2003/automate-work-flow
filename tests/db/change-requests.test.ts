import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/db/db.js';
import { Repo } from '../../src/db/repo.js';
import { ImpactOut, STAGES, type NewRequest } from '../../src/domain/types.js';
import { loadConfig } from '../../src/config.js';
import { nextStage } from '../../src/engine/pipeline.js';

const base: NewRequest = {
  title: 't', description: 'd', perfReq: '', nonfuncReq: '',
  projectKind: 'new', gitlabProject: null, softwareTypes: ['web'], runMode: 'auto', createdBy: null,
};
const cr = { title: 'Thêm lọc', description: 'mô tả', kind: 'add' as const, source: 'staff' as const, status: 'pending' as const };

let repo: Repo;
beforeEach(() => { repo = new Repo(openDb(':memory:')); });

describe('change requests repo', () => {
  it('nextCrId CR-01 then CR-02 per request', () => {
    const a = repo.createRequest(base);
    const b = repo.createRequest(base);
    expect(repo.nextCrId(a.id)).toBe('CR-01');
    expect(repo.createChangeRequest(a.id, cr).id).toBe('CR-01');
    expect(repo.createChangeRequest(a.id, cr).id).toBe('CR-02');
    expect(repo.nextCrId(a.id)).toBe('CR-03');
    expect(repo.nextCrId(b.id)).toBe('CR-01');
    expect(repo.listChangeRequests(a.id).map(c => c.id)).toEqual(['CR-01', 'CR-02']);
  });

  it('get/update/attachments', () => {
    const r = repo.createRequest(base);
    const c = repo.createChangeRequest(r.id, { ...cr, createdBy: 3 });
    expect(c).toMatchObject({ requestId: r.id, status: 'pending', createdBy: 3, decidedBy: null, baselineFrom: null, reenterStage: null });
    const u = repo.updateChangeRequest(r.id, c.id, { status: 'accepted', decidedBy: 2, baselineFrom: 1, baselineTo: 2, reenterStage: 'DESIGN', impactSummary: 'x' });
    expect(u).toMatchObject({ status: 'accepted', decidedBy: 2, baselineTo: 2, reenterStage: 'DESIGN', impactSummary: 'x' });
    expect(repo.getChangeRequest(r.id, 'CR-99')).toBeUndefined();
    repo.addCrAttachment(r.id, c.id, 'a.pdf', '/p/a.pdf');
    expect(repo.listCrAttachments(r.id, c.id)).toEqual([{ crId: c.id, requestId: r.id, filename: 'a.pdf', path: '/p/a.pdf' }]);
  });

  it('request defaults baselineVersion/iteration = 1', () => {
    const r = repo.createRequest(base);
    expect(r.baselineVersion).toBe(1);
    expect(r.iteration).toBe(1);
    expect(repo.updateRequest(r.id, { baselineVersion: 2, iteration: 2 })).toMatchObject({ baselineVersion: 2, iteration: 2 });
  });

  it('cancelled scope persists with changed_by_cr', () => {
    const r = repo.createRequest(base);
    repo.upsertFeatures(r.id, [{ id: 'F1', code: 'c', name: 'n', description: '', typeCode: '', unitTest: false, note: '', kind: 'function', scopeStatus: 'active', changedByCr: null }]);
    repo.upsertTask(r.id, { id: 'T1', title: 't', featureId: 'F1', dependsOn: [], status: 'todo', reviewRounds: 0, branch: null, mrIid: null, scopeStatus: 'active', changedByCr: null });
    repo.upsertTestCase(r.id, { id: 'TC1', featureId: 'F1', purpose: '', data: '', steps: '', expected: '', status1: null, status2: null, realResult: null, evidence: [], comment: null, scopeStatus: 'active', changedByCr: null, baseline: null });
    repo.setScope('feature', r.id, 'F1', 'cancelled', 'CR-01');
    repo.setScope('task', r.id, 'T1', 'cancelled', 'CR-01');
    repo.setScope('test_case', r.id, 'TC1', 'cancelled', 'CR-01');
    expect(repo.listFeatures(r.id)[0]).toMatchObject({ scopeStatus: 'cancelled', changedByCr: 'CR-01' });
    expect(repo.listTasks(r.id)[0]).toMatchObject({ scopeStatus: 'cancelled', changedByCr: 'CR-01' });
    expect(repo.getTestCase(r.id, 'TC1')).toMatchObject({ scopeStatus: 'cancelled', changedByCr: 'CR-01', baseline: null });
    repo.updateTestCase(r.id, 'TC1', { baseline: 2 });
    expect(repo.getTestCase(r.id, 'TC1')!.baseline).toBe(2);
  });
});

describe('migration', () => {
  it('migration adds columns to an existing v1 database', () => {
    const file = join(tmpdir(), `devflow-v1-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const v1 = new DatabaseSync(file);
    v1.exec(`
      create table requests(id text primary key, title text not null, description text not null default '', perf_req text not null default '',
        nonfunc_req text not null default '', project_kind text not null default 'new', gitlab_project text, software_types text not null default '[]',
        run_mode text not null default 'auto', stage text not null default 'INTAKE', status text not null default 'running',
        clarify_round integer not null default 0, created_by integer, created_at integer not null, updated_at integer not null);
      create table features(request_id text not null, id text not null, code text not null, name text not null, description text not null default '',
        type_code text not null default '', unit_test integer not null default 0, note text not null default '', kind text not null default 'function', primary key(request_id,id));
      create table tasks(request_id text not null, id text not null, title text not null, feature_id text, depends_on text not null default '[]',
        status text not null default 'todo', review_rounds integer not null default 0, branch text, mr_iid integer, primary key(request_id,id));
      create table test_cases(request_id text not null, id text not null, feature_id text, purpose text not null default '', data text not null default '',
        steps text not null default '', expected text not null default '', status1 text, status2 text, real_result text, evidence text not null default '[]', comment text, primary key(request_id,id));
      insert into requests(id,title,created_at,updated_at) values('REQ-001','old',1,1);
      insert into tasks(request_id,id,title) values('REQ-001','T1','x');
    `);
    v1.close();
    const db = openDb(file);
    const cols = (t: string) => (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map(c => c.name);
    expect(cols('requests')).toEqual(expect.arrayContaining(['baseline_version', 'iteration']));
    for (const t of ['features', 'tasks', 'test_cases']) expect(cols(t)).toEqual(expect.arrayContaining(['scope_status', 'changed_by_cr']));
    expect(cols('test_cases')).toContain('baseline');
    const r = new Repo(db);
    expect(r.getRequest('REQ-001')).toMatchObject({ baselineVersion: 1, iteration: 1 });
    expect(r.getTask('REQ-001', 'T1')).toMatchObject({ scopeStatus: 'active', changedByCr: null });
    expect(r.createChangeRequest('REQ-001', cr).id).toBe('CR-01');
    db.close();
    openDb(file).close(); // idempotent re-run
  });
});

describe('ImpactOut', () => {
  const ok = {
    cr_id: 'CR-01', summary: 's', scope: { add: [{ name: 'n', description: 'd' }], modify: [{ feature_id: 'F1', change: 'c' }], remove: ['F2'] },
    affected: { features: ['F1'], tasks: [], test_cases: [] }, effort_delta_mh: 8, reenter: 'DESIGN',
  };
  it('parses with defaults', () => {
    const p = ImpactOut.parse(ok);
    expect(p.questions).toEqual([]);
    expect(p.risks).toEqual([]);
  });
  it('ImpactOut rejects unknown reenter', () => {
    expect(ImpactOut.safeParse({ ...ok, reenter: 'DONE' }).success).toBe(false);
    expect(ImpactOut.safeParse({ ...ok, reenter: 'INTAKE' }).success).toBe(false);
  });
});

describe('stages/config', () => {
  it('STAGES contains CHANGE after DONE and nextStage never returns it', () => {
    expect(STAGES[STAGES.indexOf('DONE') + 1]).toBe('CHANGE');
    for (const s of STAGES) for (const projectKind of ['new', 'existing'] as const) {
      expect(nextStage(s, { projectKind })).not.toBe('CHANGE');
    }
    expect(nextStage('DONE', { projectKind: 'new' })).toBeUndefined();
  });
  it('config default crAutoAcceptMaxMh 40', () => {
    expect(loadConfig({}).crAutoAcceptMaxMh).toBe(40);
    expect(loadConfig({ CR_AUTO_ACCEPT_MAX_MH: '12' }).crAutoAcceptMaxMh).toBe(12);
  });
});
