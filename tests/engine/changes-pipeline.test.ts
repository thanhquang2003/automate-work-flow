import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { clearStages, nextStage, registerStage, type StageContext, type StageHandler } from '../../src/engine/pipeline.js';
import { CrNotAllowedError, applyAcceptedChange, computeReentry, restorePrevious } from '../../src/engine/changes.js';
import { changeDir, writeJson } from '../../src/engine/stages/common.js';
import { STAGES, type ImpactOutT, type RequestStatus, type Stage } from '../../src/domain/types.js';
import type { Repo } from '../../src/db/repo.js';
import { setup, mkReq } from './helpers.js';

const GATES: Stage[] = ['CODEBASE_SCAN', 'ANALYSIS', 'BREAKDOWN', 'DESIGN', 'PLANNING', 'DEVELOP'];
type Call = { stage: Stage; changes: string[]; baseline: number };
let calls: Call[];
let impacts: Record<string, Partial<ImpactOutT>>;
const next: StageHandler = async () => ({ kind: 'next' });

function impactFor(crId: string): ImpactOutT {
  return {
    cr_id: crId, summary: `Tác động ${crId}`, scope: { add: [], modify: [], remove: [] },
    affected: { features: [], tasks: [], test_cases: [] }, questions: [], effort_delta_mh: 4, risks: [], reenter: 'DEVELOP',
    ...impacts[crId],
  };
}

/** Fake CHANGE stage: takes pending CRs, marks them analyzing and writes impact.json (like Task 3's handler). */
const fakeChange: StageHandler = async ctx => {
  for (const cr of ctx.repo.listChangeRequests(ctx.req.id).filter(c => c.status === 'pending')) {
    ctx.repo.updateChangeRequest(ctx.req.id, cr.id, { status: 'analyzing' });
    const imp = impactFor(cr.id);
    writeJson(join(changeDir(ctx.ws, cr.id), 'impact.json'), imp);
    ctx.repo.updateChangeRequest(ctx.req.id, cr.id, { impactSummary: imp.summary, reenterStage: imp.reenter });
  }
  return { kind: 'next' };
};

function registerAll(over: Partial<Record<Stage, StageHandler>> = {}) {
  for (const s of STAGES) {
    registerStage(s, async (ctx: StageContext) => {
      calls.push({ stage: s, changes: ctx.changes.map(c => c.cr.id), baseline: ctx.baseline });
      return (over[s] ?? (s === 'CHANGE' ? fakeChange : next))(ctx);
    }, { gate: GATES.includes(s) });
  }
}
beforeEach(() => { clearStages(); calls = []; impacts = {}; });

const stages = () => calls.map(c => c.stage);
const place = (repo: Repo, id: string, stage: Stage, status: RequestStatus) => repo.updateRequest(id, { stage, status });
const cr = (title = 'Đổi màu nút') => ({ title, description: 'mô tả', kind: 'modify' as const });

/** Blocks a handler on its first call until aborted; later calls pass through. */
function blockOnce(): { handler: StageHandler; started: Promise<void> } {
  let started!: () => void; let first = true;
  const p = new Promise<void>(r => { started = r; });
  return {
    started: p,
    handler: async ctx => {
      if (first) {
        first = false; started();
        await new Promise<void>(res => { ctx.signal.addEventListener('abort', () => res()); });
      }
      return { kind: 'next' };
    },
  };
}

function seedScope(repo: Repo, reqId: string) {
  const f = (id: string) => ({ id, code: id, name: id, description: '', typeCode: 'A', unitTest: false, note: '', kind: 'function' as const, scopeStatus: 'active' as const, changedByCr: null });
  repo.upsertFeatures(reqId, [f('F-01'), f('F-02')]);
  const t = (id: string, featureId: string) => ({ id, title: id, featureId, dependsOn: [], status: 'done', reviewRounds: 2, branch: `b-${id}`, mrIid: 7, scopeStatus: 'active' as const, changedByCr: null });
  repo.upsertTask(reqId, t('T-01', 'F-01')); repo.upsertTask(reqId, t('T-02', 'F-02'));
  const tc = (id: string, featureId: string) => ({
    id, featureId, purpose: id, data: '', steps: '', expected: '', status1: 'P' as const, status2: 'F' as const, realResult: 'x', evidence: [], comment: null,
    scopeStatus: 'active' as const, changedByCr: null, baseline: 1,
  });
  repo.upsertTestCase(reqId, tc('TC-A-01', 'F-01')); repo.upsertTestCase(reqId, tc('TC-B-01', 'F-02'));
  repo.upsertBug(reqId, { tcId: 'TC-A-01', gitlabIid: 3, fixAttempts: 2, status: 'open' });
  repo.upsertBug(reqId, { tcId: 'TC-B-01', gitlabIid: 4, fixAttempts: 1, status: 'open' });
}

describe('pipeline change control', () => {
  it('nextStage never returns CHANGE', () => {
    for (const s of STAGES) for (const projectKind of ['new', 'existing'] as const) expect(nextStage(s, { projectKind })).not.toBe('CHANGE');
  });

  it('submitChange interrupts running stage; outcome discarded; CHANGE runs once; DONE marks CR applied', async () => {
    const b = blockOnce();
    registerAll({ DEVELOP: b.handler });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    pipeline.start(r.id);
    while (!stages().includes('DEVELOP')) { await worker.tick(); await new Promise(res => setTimeout(res, 1)); }
    await b.started;
    const c = pipeline.submitChange(r.id, cr());
    expect(c).toMatchObject({ id: 'CR-01', status: 'pending', source: 'staff', interruptedStage: 'DEVELOP', interruptedStatus: 'running' });
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'running' });
    await worker.idle(); await worker.drain();
    const after = stages().slice(stages().indexOf('DEVELOP') + 1);
    expect(after).toEqual(['CHANGE', 'DEVELOP', 'TEST', 'DONE']);
    expect(repo.listStageRuns(r.id).filter(s => s.stage === 'DEVELOP').map(s => s.status)).toEqual(['cancelled', 'done']);
    expect(repo.getRequest(r.id)).toMatchObject({ status: 'done', baselineVersion: 2, iteration: 1 });
    expect(repo.getChangeRequest(r.id, 'CR-01')).toMatchObject({ status: 'applied', decisionNote: 'Tự động chấp nhận', decidedBy: null, baselineFrom: 1, baselineTo: 2 });
    // later stages see the accepted CR and the new baseline
    expect(calls.find(x => x.stage === 'TEST')).toMatchObject({ changes: ['CR-01'], baseline: 2 });
  });

  it('cr during CHANGE is analysed before gate (CHANGE runs again) and keeps the first interruption', async () => {
    let release!: () => void; let started!: () => void; let n = 0;
    const s = new Promise<void>(res => { started = res; }); const gate = new Promise<void>(res => { release = res; });
    registerAll({ CHANGE: async ctx => { if (n++ === 0) { const out = await fakeChange(ctx); started(); await gate; return out; } return fakeChange(ctx); } });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'DESIGN', 'awaiting_approval');
    pipeline.submitChange(r.id, cr('A'));
    await worker.tick(); await s;
    const c2 = pipeline.submitChange(r.id, cr('B'));
    expect(c2).toMatchObject({ status: 'pending', interruptedStage: 'DESIGN', interruptedStatus: 'awaiting_approval' });
    release(); await worker.idle(); await worker.drain();
    expect(stages()).toEqual(['CHANGE', 'CHANGE']);
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'awaiting_approval' });
    expect(repo.listChangeRequests(r.id).map(x => x.status)).toEqual(['awaiting_decision', 'awaiting_decision']);
    expect(() => pipeline.approve(r.id)).toThrow(/CHANGE/);
    expect(() => pipeline.reject(r.id, 'x')).toThrow(/CHANGE/);
  });

  it('cr arriving while awaiting decision re-runs CHANGE before decisions', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'DEVELOP', 'needs_human');
    pipeline.submitChange(r.id, cr('A')); await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_approval');
    pipeline.submitChange(r.id, cr('B'));
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'running' });
    expect(() => pipeline.decideChange(r.id, 'CR-01', 'accept')).toThrow();
    await worker.drain();
    expect(stages()).toEqual(['CHANGE', 'CHANGE']);
    expect(repo.listChangeRequests(r.id).map(x => [x.status, x.interruptedStage, x.interruptedStatus])).toEqual([
      ['awaiting_decision', 'DEVELOP', 'needs_human'], ['awaiting_decision', 'DEVELOP', 'needs_human'],
    ]);
  });

  it('auto mode small CR auto-accepts and re-enters computed stage', async () => {
    impacts['CR-01'] = { reenter: 'DESIGN', effort_delta_mh: 40 };
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    place(repo, r.id, 'TEST', 'needs_human');
    pipeline.submitChange(r.id, cr());
    await worker.drain();
    expect(stages()).toEqual(['CHANGE', 'DESIGN', 'PLANNING', 'DEVELOP', 'TEST', 'DONE']);
    expect(repo.getChangeRequest(r.id, 'CR-01')).toMatchObject({ status: 'applied', decisionNote: 'Tự động chấp nhận' });
  });

  it('re-entry is never later than the interrupted stage', async () => {
    impacts['CR-01'] = { reenter: 'TEST' };
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'DESIGN', 'awaiting_approval');
    pipeline.submitChange(r.id, cr());
    await worker.drain();
    pipeline.decideChange(r.id, 'CR-01', 'accept', 'ok', 5);
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'DESIGN', status: 'running', baselineVersion: 2 });
    expect(repo.getChangeRequest(r.id, 'CR-01')).toMatchObject({ status: 'accepted', decidedBy: 5, decisionNote: 'ok' });
  });

  it('remove CR waits for decision even in auto; accept cancels feature, tasks, test cases', async () => {
    impacts['CR-01'] = { scope: { add: [], modify: [], remove: ['F-02'] }, reenter: 'BREAKDOWN', effort_delta_mh: -8 };
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    seedScope(repo, r.id);
    place(repo, r.id, 'DEVELOP', 'failed');
    pipeline.submitChange(r.id, { title: 'Bỏ F-02', description: '', kind: 'remove' });
    await worker.drain();
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'awaiting_approval' });
    expect(repo.getChangeRequest(r.id, 'CR-01')!.status).toBe('awaiting_decision');
    pipeline.decideChange(r.id, 'CR-01', 'accept');
    expect(repo.listFeatures(r.id).map(f => [f.id, f.scopeStatus, f.changedByCr])).toEqual([['F-01', 'active', null], ['F-02', 'cancelled', 'CR-01']]);
    expect(repo.getTask(r.id, 'T-02')).toMatchObject({ scopeStatus: 'cancelled', changedByCr: 'CR-01' });
    expect(repo.getTask(r.id, 'T-01')).toMatchObject({ scopeStatus: 'active', changedByCr: null });
    expect(repo.getTestCase(r.id, 'TC-B-01')).toMatchObject({ scopeStatus: 'cancelled', changedByCr: 'CR-01' });
    expect(repo.getBug(r.id, 'TC-B-01')).toMatchObject({ status: 'closed', note: 'Đóng do CR-01' });
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'BREAKDOWN', status: 'running' });
    await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('done');
  });

  it('effort above threshold waits; at threshold auto-accepts', async () => {
    impacts['CR-01'] = { effort_delta_mh: 41 };
    registerAll();
    const { repo, pipeline, worker } = setup({ crAutoAcceptMaxMh: 40 });
    const r = mkReq(repo);
    place(repo, r.id, 'DEVELOP', 'needs_human');
    pipeline.submitChange(r.id, cr()); await worker.drain();
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_approval');
  });

  it('review mode always waits for a decision', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'DEVELOP', 'needs_human');
    pipeline.submitChange(r.id, cr()); await worker.drain();
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'awaiting_approval' });
  });

  it('modify resets tasks/test cases/bugs of the affected items', async () => {
    impacts['CR-01'] = { scope: { add: [], modify: [{ feature_id: 'F-01', change: 'x' }], remove: [] }, affected: { features: ['F-01'], tasks: ['T-01'], test_cases: ['TC-A-01'] }, reenter: 'PLANNING' };
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    seedScope(repo, r.id);
    place(repo, r.id, 'TEST', 'needs_human');
    pipeline.submitChange(r.id, cr()); await worker.drain();
    pipeline.decideChange(r.id, 'CR-01', 'accept');
    expect(repo.getTask(r.id, 'T-01')).toMatchObject({ status: 'todo', reviewRounds: 0, branch: 'b-T-01', scopeStatus: 'active', changedByCr: 'CR-01' });
    expect(repo.getTask(r.id, 'T-02')).toMatchObject({ status: 'done', reviewRounds: 2 });
    expect(repo.getTestCase(r.id, 'TC-A-01')).toMatchObject({ baseline: null, status1: 'P', status2: 'F', changedByCr: 'CR-01', scopeStatus: 'active' });
    expect(repo.getTestCase(r.id, 'TC-B-01')).toMatchObject({ baseline: 1, changedByCr: null });
    expect(repo.getBug(r.id, 'TC-A-01')).toMatchObject({ status: 'closed', fixAttempts: 0, note: 'Đóng do CR-01' });
    expect(repo.getBug(r.id, 'TC-B-01')).toMatchObject({ status: 'open', fixAttempts: 1 });
    expect(repo.listFeatures(r.id).find(f => f.id === 'F-01')).toMatchObject({ scopeStatus: 'active', changedByCr: 'CR-01' });
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'PLANNING', status: 'running' });
  });

  it('reject restores previous state: running DEVELOP is re-enqueued', async () => {
    const b = blockOnce();
    registerAll({ DEVELOP: b.handler });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'DEVELOP', 'running');
    pipeline.rerunStage(r.id, 'DEVELOP');
    await worker.tick(); await b.started;
    impacts['CR-01'] = { effort_delta_mh: 100 };
    pipeline.submitChange(r.id, cr());
    await worker.idle(); await worker.drain();
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'awaiting_approval' });
    pipeline.decideChange(r.id, 'CR-01', 'reject', 'không cần');
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'running', baselineVersion: 1 });
    expect(repo.getChangeRequest(r.id, 'CR-01')).toMatchObject({ status: 'rejected', decisionNote: 'không cần' });
    await worker.drain();
    expect(stages()).toEqual(['DEVELOP', 'CHANGE', 'DEVELOP']);
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'awaiting_approval' });
  });

  it.each([
    ['CLARIFY', 'awaiting_customer'], ['DONE', 'done'], ['DESIGN', 'awaiting_approval'], ['TEST', 'needs_human'],
  ] as [Stage, RequestStatus][])('reject restores %s/%s without a job', async (stage, status) => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, stage, status);
    pipeline.submitChange(r.id, cr()); await worker.drain();
    pipeline.decideChange(r.id, 'CR-01', 'reject');
    expect(repo.getRequest(r.id)).toMatchObject({ stage, status, baselineVersion: 1, iteration: 1 });
    expect(repo.listJobs(r.id).filter(j => j.status === 'queued' || j.status === 'paused')).toHaveLength(0);
  });

  it('reject restores paused: stage job parked until resume', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'PLANNING', 'paused');
    pipeline.submitChange(r.id, cr()); await worker.drain();
    pipeline.decideChange(r.id, 'CR-01', 'reject');
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'PLANNING', status: 'paused' });
    await worker.drain();
    expect(stages()).toEqual(['CHANGE']);
    pipeline.resume(r.id); await worker.drain();
    expect(stages()).toEqual(['CHANGE', 'PLANNING']);
  });

  it('accept on done increments iteration once and baseline per CR; clarify round reset', async () => {
    impacts['CR-01'] = { reenter: 'TEST' };
    impacts['CR-02'] = { reenter: 'DEVELOP' };
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    repo.updateRequest(r.id, { stage: 'DONE', status: 'done', clarifyRound: 3 });
    pipeline.submitChange(r.id, cr('A'));
    pipeline.submitChange(r.id, cr('B'));
    await worker.drain();
    expect(stages()).toEqual(['CHANGE']);
    pipeline.decideChange(r.id, 'CR-02', 'accept');
    expect(repo.getRequest(r.id)!.status).toBe('awaiting_approval');
    pipeline.decideChange(r.id, 'CR-01', 'accept');
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'DEVELOP', status: 'running', baselineVersion: 3, iteration: 2, clarifyRound: 0 });
    expect(repo.listChangeRequests(r.id).map(x => [x.baselineFrom, x.baselineTo])).toEqual([[1, 2], [2, 3]]);
    await worker.drain();
    pipeline.approve(r.id); // DEVELOP is a review gate
    await worker.drain();
    expect(stages()).toEqual(['CHANGE', 'DEVELOP', 'TEST', 'DONE']);
    expect(calls[1]).toMatchObject({ changes: ['CR-01', 'CR-02'], baseline: 3 });
    expect(repo.listChangeRequests(r.id).map(x => x.status)).toEqual(['applied', 'applied']);
  });

  it('mixed decisions: rejected CR stays rejected and its unanswered questions are dropped; accepted one applies', async () => {
    const q = (id: string, cr: string, priority: 'must' | 'should') => ({ id, category: 'Khác', question: id, why: `[${cr}] lý do`, type: 'text' as const, options: [], suggested_answer: '', priority });
    impacts['CR-01'] = { reenter: 'DESIGN', questions: [q('Q-10', 'CR-01', 'should')] };
    impacts['CR-02'] = { reenter: 'PLANNING', questions: [q('Q-11', 'CR-02', 'must')] };
    registerAll({
      CHANGE: async ctx => { const o = await fakeChange(ctx); ctx.repo.upsertQuestions(ctx.req.id, 1, [q('Q-10', 'CR-01', 'should'), q('Q-11', 'CR-02', 'must')]); return o; },
    });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'TEST', 'needs_human');
    pipeline.submitChange(r.id, cr('A')); pipeline.submitChange(r.id, cr('B'));
    await worker.drain();
    pipeline.decideChange(r.id, 'CR-01', 'accept');
    pipeline.decideChange(r.id, 'CR-02', 'reject', 'không');
    expect(repo.listChangeRequests(r.id).map(x => x.status)).toEqual(['accepted', 'rejected']);
    expect(repo.listQuestions(r.id).map(x => x.id)).toEqual(['Q-10']);
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'DESIGN', baselineVersion: 2 });
  });

  it('new must question from an accepted CR re-enters ANALYSIS', async () => {
    impacts['CR-01'] = { reenter: 'DEVELOP', questions: [{ id: 'Q-20', category: 'Khác', question: '?', why: '[CR-01] x', type: 'text', options: [], suggested_answer: '', priority: 'must' }] };
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    place(repo, r.id, 'TEST', 'needs_human');
    pipeline.submitChange(r.id, cr()); await worker.drain();
    expect(stages()[1]).toBe('ANALYSIS');
  });

  it('missing impact.json fails CHANGE with a Vietnamese message and returns CRs to pending', async () => {
    registerAll({ CHANGE: async ctx => { for (const c of ctx.repo.listChangeRequests(ctx.req.id)) ctx.repo.updateChangeRequest(ctx.req.id, c.id, { status: 'analyzing' }); return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo);
    place(repo, r.id, 'DEVELOP', 'needs_human');
    pipeline.submitChange(r.id, cr()); await worker.drain();
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CHANGE', status: 'failed' });
    expect(repo.latestStageRun(r.id, 'CHANGE')!.error).toMatch(/CR-01/);
    expect(repo.listEvents(r.id).some(e => e.level === 'error' && /tác động/.test(e.message))).toBe(true);
    expect(repo.getChangeRequest(r.id, 'CR-01')!.status).toBe('pending');
  });

  it('cancelled request rejects submitChange and proposeChange', () => {
    registerAll();
    const { repo, pipeline } = setup();
    const r = mkReq(repo);
    pipeline.cancel(r.id);
    expect(() => pipeline.submitChange(r.id, cr())).toThrow(CrNotAllowedError);
    expect(() => pipeline.proposeChange(r.id, cr())).toThrow(CrNotAllowedError);
    expect(repo.listChangeRequests(r.id)).toHaveLength(0);
  });

  it('proposal does nothing until accepted', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'CLARIFY', 'awaiting_customer');
    const p1 = pipeline.proposeChange(r.id, cr('khách 1'));
    expect(p1).toMatchObject({ status: 'proposed', source: 'customer' });
    expect(repo.getRequest(r.id)).toMatchObject({ stage: 'CLARIFY', status: 'awaiting_customer' });
    expect(repo.listJobs(r.id)).toHaveLength(0);
    expect(() => pipeline.decideChange(r.id, p1.id, 'accept')).toThrow();
    pipeline.rejectProposal(r.id, p1.id, 'ngoài phạm vi', 3);
    expect(repo.getChangeRequest(r.id, p1.id)).toMatchObject({ status: 'rejected', decisionNote: 'ngoài phạm vi', decidedBy: 3 });
    const p2 = pipeline.proposeChange(r.id, cr('khách 2'));
    pipeline.acceptProposal(r.id, p2.id);
    expect(repo.getChangeRequest(r.id, p2.id)).toMatchObject({ status: 'pending', interruptedStage: 'CLARIFY', interruptedStatus: 'awaiting_customer' });
    await worker.drain();
    expect(stages()).toEqual(['CHANGE']);
    expect(repo.getChangeRequest(r.id, p2.id)!.status).toBe('awaiting_decision');
    expect(repo.getChangeRequest(r.id, p1.id)!.status).toBe('rejected');
    expect(() => pipeline.acceptProposal(r.id, p2.id)).toThrow();
  });

  it('decideChange rejects CRs not awaiting a decision', async () => {
    registerAll();
    const { repo, pipeline, worker } = setup();
    const r = mkReq(repo, { runMode: 'review' });
    place(repo, r.id, 'DEVELOP', 'needs_human');
    pipeline.submitChange(r.id, cr()); await worker.drain();
    expect(() => pipeline.decideChange(r.id, 'CR-09', 'accept')).toThrow();
    pipeline.decideChange(r.id, 'CR-01', 'accept');
    expect(() => pipeline.decideChange(r.id, 'CR-01', 'reject')).toThrow();
  });

  it('with two workers the CHANGE job waits until the interrupted handler has returned', async () => {
    let t = 1_000_000;
    let release!: () => void; let started!: () => void;
    const s = new Promise<void>(res => { started = res; }); const gate = new Promise<void>(res => { release = res; });
    let first = true;
    registerAll({ DEVELOP: async () => { if (first) { first = false; started(); await gate; } return { kind: 'next' }; } });
    const { repo, pipeline, worker } = setup({ maxConcurrentJobs: 2 }, () => t);
    const r = mkReq(repo);
    place(repo, r.id, 'DEVELOP', 'running');
    pipeline.rerunStage(r.id, 'DEVELOP');
    await worker.tick(); await s;
    pipeline.submitChange(r.id, cr());
    await worker.tick();
    await new Promise(res => setTimeout(res, 5));
    expect(stages()).toEqual(['DEVELOP']); // CHANGE deferred, not run alongside DEVELOP
    release(); await worker.idle();
    t += 2_000;
    await worker.drain();
    expect(stages()).toEqual(['DEVELOP', 'CHANGE', 'DEVELOP', 'TEST', 'DONE']);
  });
});

describe('changes helpers', () => {
  const imp = (reenter: ImpactOutT['reenter']): ImpactOutT => ({ cr_id: 'CR-01', summary: '', scope: { add: [], modify: [], remove: [] }, affected: { features: [], tasks: [], test_cases: [] }, questions: [], effort_delta_mh: 0, risks: [], reenter });

  it('computeReentry: earliest impact, new must → ANALYSIS, bounded by the interrupted stage', () => {
    expect(computeReentry([imp('DESIGN'), imp('PLANNING')], false, 'TEST')).toBe('DESIGN');
    expect(computeReentry([imp('DESIGN')], true, 'TEST')).toBe('ANALYSIS');
    expect(computeReentry([imp('TEST')], false, 'DESIGN')).toBe('DESIGN');
    expect(computeReentry([imp('TEST')], false, 'DONE')).toBe('TEST');
    expect(computeReentry([imp('TEST')], false, 'BUGFIX')).toBe('TEST');
    expect(computeReentry([imp('DEVELOP')], false, 'CHANGE')).toBe('DEVELOP');
    expect(computeReentry([imp('ANALYSIS')], false, 'CLARIFY')).toBe('ANALYSIS');
    expect(computeReentry([imp('DESIGN')], false, 'CLARIFY')).toBe('CLARIFY');
    // request had not reached ANALYSIS yet: continue from where it was
    expect(computeReentry([imp('DESIGN')], false, 'INTAKE')).toBe('INTAKE');
  });

  it('restorePrevious maps the interrupted status to a restore plan', () => {
    expect(restorePrevious('DEVELOP', 'running')).toEqual({ stage: 'DEVELOP', status: 'running', enqueue: true });
    expect(restorePrevious('DEVELOP', 'failed')).toEqual({ stage: 'DEVELOP', status: 'running', enqueue: true });
    expect(restorePrevious('DEVELOP', 'paused')).toEqual({ stage: 'DEVELOP', status: 'paused', enqueue: true });
    expect(restorePrevious('CLARIFY', 'awaiting_customer')).toEqual({ stage: 'CLARIFY', status: 'awaiting_customer', enqueue: false });
    expect(restorePrevious('DONE', 'done')).toEqual({ stage: 'DONE', status: 'done', enqueue: false });
  });

  it('applyAcceptedChange ignores unknown ids and add-only scope', () => {
    const { repo } = setup();
    const r = mkReq(repo);
    seedScope(repo, r.id);
    const before = JSON.stringify([repo.listFeatures(r.id), repo.listTasks(r.id), repo.listTestCases(r.id)]);
    applyAcceptedChange(repo, r, { id: 'CR-01' }, { ...imp('BREAKDOWN'), scope: { add: [{ name: 'Mới', description: '' }], modify: [], remove: [] } });
    applyAcceptedChange(repo, r, { id: 'CR-02' }, { ...imp('BREAKDOWN'), affected: { features: [], tasks: ['T-99'], test_cases: ['TC-ZZ'] } });
    expect(JSON.stringify([repo.listFeatures(r.id), repo.listTasks(r.id), repo.listTestCases(r.id)])).toBe(before);
  });
});
