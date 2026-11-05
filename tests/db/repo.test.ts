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

describe('db', () => {
  it('migrations are idempotent (openDb twice)', () => {
    const file = join(tmpdir(), `devflow-test-${Date.now()}.db`);
    const a = openDb(file); a.close();
    const b = openDb(file);
    expect(b.prepare("select count(*) c from sqlite_master where name='requests'").get()).toEqual({ c: 1 });
    b.close();
  });
});

describe('Repo requests', () => {
  it('nextRequestId returns REQ-001 then REQ-002', () => {
    expect(repo.nextRequestId()).toBe('REQ-001');
    const r = repo.createRequest(base);
    expect(r.id).toBe('REQ-001');
    expect(r.softwareTypes).toEqual(['web']);
    expect(r.stage).toBe('INTAKE');
    expect(repo.nextRequestId()).toBe('REQ-002');
    expect(repo.createRequest(base).id).toBe('REQ-002');
    expect(repo.listRequests()).toHaveLength(2);
    expect(repo.updateRequest('REQ-001', { status: 'paused', clarifyRound: 2 }).clarifyRound).toBe(2);
  });

  it('events list after id', () => {
    repo.createRequest(base);
    repo.addEvent('REQ-001', 'info', 'a');
    repo.addEvent('REQ-001', 'warn', 'b');
    const all = repo.listEvents('REQ-001');
    expect(all.map(e => e.message)).toEqual(['a', 'b']);
    expect(repo.listEvents('REQ-001', all[0].id).map(e => e.message)).toEqual(['b']);
  });
});

describe('Repo jobs', () => {
  it('claimNextJob skips jobs with run_after in future', () => {
    repo.enqueueJob(null, 'stage', { a: 1 }, 2000);
    expect(repo.claimNextJob(1000)).toBeUndefined();
    const j = repo.claimNextJob(2000);
    expect(j?.status).toBe('running');
    expect(j?.payload).toEqual({ a: 1 });
    expect(repo.claimNextJob(3000)).toBeUndefined();
  });

  it('resetRunningJobs sets running to queued', () => {
    repo.enqueueJob(null, 'stage', {});
    const j = repo.claimNextJob(Date.now())!;
    expect(repo.resetRunningJobs()).toBe(1);
    expect(repo.getJob(j.id)?.status).toBe('queued');
  });

  it('finish/fail/pause', () => {
    const a = repo.enqueueJob(null, 'k', {});
    repo.finishJob(a.id);
    expect(repo.getJob(a.id)?.status).toBe('done');
    repo.failJob(a.id, 'boom');
    expect(repo.getJob(a.id)).toMatchObject({ status: 'failed', lastError: 'boom' });
    repo.pauseJob(a.id, 5000);
    expect(repo.getJob(a.id)).toMatchObject({ status: 'paused', runAfter: 5000 });
  });
});

describe('Repo answers/questions', () => {
  it('latestAnswers returns newest per question', () => {
    repo.createRequest(base);
    repo.saveAnswer('REQ-001', 'Q-01', 'old', 'excel');
    repo.saveAnswer('REQ-001', 'Q-01', 'new', 'web');
    repo.saveAnswer('REQ-001', 'Q-02', 'x', 'staff');
    const m = repo.latestAnswers('REQ-001');
    expect(m.get('Q-01')).toBe('new');
    expect(m.get('Q-02')).toBe('x');
  });

  it('upsertQuestions', () => {
    repo.createRequest(base);
    const q = { id: 'Q-01', category: 'Khác', question: '?', why: 'w', type: 'single' as const, options: ['a', 'b'], suggested_answer: 'a', priority: 'must' as const };
    repo.upsertQuestions('REQ-001', 1, [q]);
    repo.upsertQuestions('REQ-001', 1, [{ ...q, question: '??' }]);
    const l = repo.listQuestions('REQ-001');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ question: '??', options: ['a', 'b'], round: 1 });
  });
});

describe('Repo stage runs, tasks, tc, bugs, survey, users, settings, templates', () => {
  it('stage runs', () => {
    repo.createRequest(base);
    const r1 = repo.createStageRun('REQ-001', 'ANALYSIS');
    expect(r1.attempt).toBe(1);
    const r2 = repo.createStageRun('REQ-001', 'ANALYSIS');
    expect(r2.attempt).toBe(2);
    repo.finishStageRun(r2.id, 'done', { sessionId: 's1' });
    expect(repo.latestStageRun('REQ-001', 'ANALYSIS')).toMatchObject({ attempt: 2, status: 'done', claudeSessionId: 's1' });
  });

  it('tasks/test cases/bugs/features', () => {
    repo.createRequest(base);
    repo.upsertFeatures('REQ-001', [{ id: 'F-01', code: 'LOGIN', name: 'n', description: 'd', typeCode: 'X', unitTest: true, note: '', kind: 'function' }]);
    expect(repo.listFeatures('REQ-001')[0]).toMatchObject({ id: 'F-01', unitTest: true });
    repo.upsertTask('REQ-001', { id: 'T-01', title: 't', featureId: 'F-01', dependsOn: [], status: 'todo', reviewRounds: 0, branch: null, mrIid: null });
    repo.upsertTask('REQ-001', { id: 'T-01', title: 't2', featureId: 'F-01', dependsOn: ['T-00'], status: 'done', reviewRounds: 1, branch: 'b', mrIid: 3 });
    expect(repo.listTasks('REQ-001')).toEqual([expect.objectContaining({ title: 't2', dependsOn: ['T-00'], mrIid: 3 })]);
    repo.upsertTestCase('REQ-001', { id: 'TC-LOGIN-01', featureId: 'F-01', purpose: 'p', data: '', steps: 's', expected: 'e', status1: null, status2: null, realResult: null, evidence: [], comment: null });
    repo.updateTestCase('REQ-001', 'TC-LOGIN-01', { status1: 'P', evidence: ['a.png'] });
    expect(repo.listTestCases('REQ-001')[0]).toMatchObject({ status1: 'P', evidence: ['a.png'] });
    repo.upsertBug('REQ-001', { tcId: 'TC-LOGIN-01', gitlabIid: 5, fixAttempts: 1, status: 'open' });
    expect(repo.getBug('REQ-001', 'TC-LOGIN-01')?.gitlabIid).toBe(5);
    expect(repo.listBugs('REQ-001')).toHaveLength(1);
  });

  it('survey links, users, settings, templates', () => {
    repo.createRequest(base);
    repo.web.createSurveyLink({ token: 'tok', requestId: 'REQ-001', round: 1, expiresAt: 9 });
    expect(repo.web.getSurveyLink('tok')?.submittedAt).toBeNull();
    repo.web.markSurveySubmitted('tok', 5);
    expect(repo.web.getSurveyLink('tok')?.submittedAt).toBe(5);
    const u = repo.web.createUser({ username: 'a', passwordHash: 'h', role: 'admin' });
    expect(repo.web.getUserByUsername('a')?.id).toBe(u.id);
    repo.web.setUserGitlabToken(u.id, 'enc');
    expect(repo.web.getUser(u.id)?.gitlabTokenEnc).toBe('enc');
    expect(repo.web.listUsers()).toHaveLength(1);
    expect(repo.web.getSetting('k')).toBeUndefined();
    repo.web.setSetting('k', 'v'); repo.web.setSetting('k', 'v2');
    expect(repo.web.getSetting('k')).toBe('v2');
    repo.web.setTemplate('tkct', 'p.docx');
    expect(repo.web.getTemplate('tkct')).toBe('p.docx');
    expect(repo.web.listTemplates()).toEqual([{ kind: 'tkct', path: 'p.docx' }]);
  });
});
