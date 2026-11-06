import { safeReadText } from './safe-fs.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from '../db/repo.js';
import { ImpactOut, STAGES, type ChangeRequestRow, type ImpactOutT, type RequestRow, type RequestStatus, type Stage } from '../domain/types.js';
import { changeDir } from './stages/common.js';
import type { Workspace } from './workspace.js';

/** A change request cannot be created for this request (it is cancelled). */
export class CrNotAllowedError extends Error {
  constructor(reqId: string) {
    super(`Yêu cầu ${reqId} đã bị hủy, không thể tạo yêu cầu thay đổi`);
    this.name = 'CrNotAllowedError';
  }
}

export const impactJsonPath = (ws: Workspace, crId: string): string => join(changeDir(ws, crId), 'impact.json');

/** The CHANGE stage's impact.json for a CR, or undefined when missing or invalid. */
export function loadImpact(ws: Workspace, crId: string): ImpactOutT | undefined {
  const p = impactJsonPath(ws, crId);
  if (!existsSync(p)) return undefined;
  try {
    const r = ImpactOut.safeParse(JSON.parse(safeReadText(p)));
    return r.success ? r.data : undefined;
  } catch { return undefined; }
}

const idx = (s: Stage): number => STAGES.indexOf(s);

/**
 * Stage to re-enter after accepting CRs (spec §4.3): the earliest `reenter` of the accepted impacts, or ANALYSIS when
 * an accepted CR raised a new `must` question; never earlier than ANALYSIS; never later than the interrupted stage
 * (DONE/BUGFIX/CHANGE count as TEST). A CR that adds or removes features re-enters at BREAKDOWN at the latest. When the request had not reached ANALYSIS yet it simply continues from there.
 */
export function computeReentry(impacts: ImpactOutT[], hasNewMust: boolean, prevStage: Stage): Stage {
  const wanted: Stage[] = impacts.map(i => i.reenter);
  if (hasNewMust) wanted.push('ANALYSIS');
  // Adding or removing a feature changes the feature list / ULNL, which only BREAKDOWN regenerates.
  if (impacts.some(i => i.scope.add.length || i.scope.remove.length)) wanted.push('BREAKDOWN');
  let target: Stage = wanted.length ? wanted.reduce((a, b) => (idx(b) < idx(a) ? b : a)) : 'TEST';
  if (idx(target) < idx('ANALYSIS')) target = 'ANALYSIS';
  const bound: Stage = prevStage === 'DONE' || prevStage === 'BUGFIX' || prevStage === 'CHANGE' ? 'TEST' : prevStage;
  return idx(bound) < idx(target) ? bound : target;
}

export interface RestorePlan { stage: Stage; status: RequestStatus; enqueue: boolean }

/**
 * Where a request goes back to when every CR of a batch is rejected: a stage that was running is run again; a failed one stays failed;
 * a paused one is run again once resumed (the job is parked); waiting/finished states are restored as they were.
 */
export function restorePrevious(stage: Stage, status: RequestStatus): RestorePlan {
  switch (status) {
    case 'running':
    // Waiting for a seat: run again; the new job parks itself again if the seat is still unusable (its parked
    // job was superseded by the change request, so something must be enqueued).
    case 'awaiting_seat':
      return { stage, status: 'running', enqueue: true };
    case 'failed':
      // A failed stage stays failed (needs a human retry); nothing is enqueued.
      return { stage, status: 'failed', enqueue: false };
    case 'paused':
      return { stage, status: 'paused', enqueue: true };
    default:
      return { stage, status, enqueue: false };
  }
}

const closedNote = (crId: string): string => `Đóng do ${crId}`;

/** Closes the bug of a test case touched by a CR (GitLab issues are closed lazily by TEST) and resets its fix counter. */
function closeBug(repo: Repo, reqId: string, tcId: string, crId: string): void {
  const bug = repo.getBug(reqId, tcId);
  if (bug) repo.upsertBug(reqId, { ...bug, fixAttempts: 0, status: 'closed', note: closedNote(crId) });
}

/**
 * Applies an accepted CR's scope to the DB (spec §4.3). remove → the feature and its tasks/test cases are cancelled
 * (never deleted); modify → affected tasks go back to `todo` with review rounds reset, affected test cases lose their
 * baseline so TEST re-runs them (result history is kept; baseline:null only matters for v1-era runs without
 * run.baseline — otherwise every active test case is re-tested at the new version anyway) and their bugs are closed; add → nothing (BREAKDOWN creates it).
 */
export function applyAcceptedChange(repo: Repo, req: Pick<RequestRow, 'id'>, cr: Pick<ChangeRequestRow, 'id'>, impact: ImpactOutT): void {
  const reqId = req.id;
  repo.tx(() => {
    const features = new Map(repo.listFeatures(reqId).map(f => [f.id, f]));
    // Already-cancelled features keep the CR that cancelled them.
    const removed = new Set(impact.scope.remove.filter(id => features.get(id)?.scopeStatus === 'active'));
    for (const fid of removed) {
      repo.setScope('feature', reqId, fid, 'cancelled', cr.id);
      for (const t of repo.listTasks(reqId)) if (t.featureId === fid) repo.setScope('task', reqId, t.id, 'cancelled', cr.id);
      for (const tc of repo.listTestCases(reqId)) {
        if (tc.featureId !== fid) continue;
        repo.setScope('test_case', reqId, tc.id, 'cancelled', cr.id);
        closeBug(repo, reqId, tc.id, cr.id);
      }
    }
    const touched = new Set([...impact.scope.modify.map(m => m.feature_id), ...impact.affected.features]);
    for (const fid of touched) {
      const f = features.get(fid);
      if (f && !removed.has(fid) && f.scopeStatus === 'active') repo.setScope('feature', reqId, fid, 'active', cr.id);
    }
    for (const tid of impact.affected.tasks) {
      const t = repo.getTask(reqId, tid);
      if (!t || t.scopeStatus === 'cancelled') continue;
      repo.updateTask(reqId, tid, { status: 'todo', reviewRounds: 0, changedByCr: cr.id });
    }
    for (const tcId of impact.affected.test_cases) {
      const tc = repo.getTestCase(reqId, tcId);
      if (!tc || tc.scopeStatus === 'cancelled') continue;
      repo.updateTestCase(reqId, tcId, { baseline: null, changedByCr: cr.id });
      closeBug(repo, reqId, tcId, cr.id);
    }
  });
}
