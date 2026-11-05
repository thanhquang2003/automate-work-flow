import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  AnswerRow, AnswerSource, AttachmentRow, BugRow, EventRow, FeatureRow, JobRow, NewRequest, Question, QuestionRow,
  ChangeRequestRow, CrAttachmentRow, CrKind, CrSource, CrStatus, ScopeStatus,
  RequestPatch, RequestRow, Stage, StageRunRow, TaskRow, TestCaseRow,
} from '../domain/types.js';
import { WebRepo } from './web-repo.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const json = (v: unknown): string => JSON.stringify(v);
const parse = <T>(s: unknown, def: T): T => {
  if (typeof s !== 'string' || s === '') return def;
  try { return JSON.parse(s) as T; } catch { return def; }
};

const toRequest = (r: Row): RequestRow => ({
  id: r.id, title: r.title, description: r.description, perfReq: r.perf_req, nonfuncReq: r.nonfunc_req,
  projectKind: r.project_kind, gitlabProject: r.gitlab_project ?? null, softwareTypes: parse(r.software_types, []),
  runMode: r.run_mode, stage: r.stage, status: r.status, clarifyRound: r.clarify_round,
  baselineVersion: r.baseline_version ?? 1, iteration: r.iteration ?? 1,
  createdBy: r.created_by ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toStageRun = (r: Row): StageRunRow => ({
  id: r.id, requestId: r.request_id, stage: r.stage, attempt: r.attempt, status: r.status, feedback: r.feedback ?? null,
  startedAt: r.started_at, finishedAt: r.finished_at ?? null, claudeSessionId: r.claude_session_id ?? null, error: r.error ?? null,
});
const toJob = (r: Row): JobRow => ({
  id: r.id, requestId: r.request_id ?? null, kind: r.kind, payload: parse(r.payload, {}), status: r.status,
  runAfter: r.run_after, attempts: r.attempts, lastError: r.last_error ?? null,
});
const toQuestion = (r: Row): QuestionRow => ({
  requestId: r.request_id, id: r.id, round: r.round, category: r.category, question: r.question, why: r.why, type: r.type,
  options: parse(r.options, []), suggested_answer: r.suggested_answer, priority: r.priority,
});
const toFeature = (r: Row): FeatureRow => ({
  id: r.id, code: r.code, name: r.name, description: r.description, typeCode: r.type_code, unitTest: !!r.unit_test, note: r.note, kind: r.kind,
  scopeStatus: r.scope_status ?? 'active', changedByCr: r.changed_by_cr ?? null,
});
const toTask = (r: Row): TaskRow => ({
  id: r.id, title: r.title, featureId: r.feature_id ?? null, dependsOn: parse(r.depends_on, []), status: r.status,
  reviewRounds: r.review_rounds, branch: r.branch ?? null, mrIid: r.mr_iid ?? null,
  scopeStatus: r.scope_status ?? 'active', changedByCr: r.changed_by_cr ?? null,
});
const toTestCase = (r: Row): TestCaseRow => ({
  id: r.id, featureId: r.feature_id ?? null, purpose: r.purpose, data: r.data, steps: r.steps, expected: r.expected,
  status1: r.status1 ?? null, status2: r.status2 ?? null, realResult: r.real_result ?? null,
  evidence: parse(r.evidence, []), comment: r.comment ?? null,
  scopeStatus: r.scope_status ?? 'active', changedByCr: r.changed_by_cr ?? null, baseline: r.baseline ?? null,
});
const toBug = (r: Row): BugRow => ({ tcId: r.tc_id, gitlabIid: r.gitlab_iid ?? null, fixAttempts: r.fix_attempts, status: r.status, note: r.note ?? null });

const toCr = (r: Row): ChangeRequestRow => ({
  id: r.id, requestId: r.request_id, title: r.title, description: r.description, kind: r.kind, source: r.source, status: r.status,
  createdBy: r.created_by ?? null, createdAt: r.created_at, decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ?? null,
  decisionNote: r.decision_note ?? null, baselineFrom: r.baseline_from ?? null, baselineTo: r.baseline_to ?? null,
  reenterStage: r.reenter_stage ?? null, interruptedStage: r.interrupted_stage ?? null, interruptedStatus: r.interrupted_status ?? null,
  interruptedRunAfter: r.interrupted_run_after ?? null,
  impactSummary: r.impact_summary ?? null,
});

const CR_COLS: Record<string, string> = {
  title: 'title', description: 'description', kind: 'kind', source: 'source', status: 'status', decidedBy: 'decided_by',
  decidedAt: 'decided_at', decisionNote: 'decision_note', baselineFrom: 'baseline_from', baselineTo: 'baseline_to',
  reenterStage: 'reenter_stage', interruptedStage: 'interrupted_stage', interruptedStatus: 'interrupted_status', interruptedRunAfter: 'interrupted_run_after', impactSummary: 'impact_summary',
};
const SCOPE_TABLES = { feature: 'features', task: 'tasks', test_case: 'test_cases' } as const;

const REQUEST_COLS: Record<string, string> = {
  title: 'title', description: 'description', perfReq: 'perf_req', nonfuncReq: 'nonfunc_req', projectKind: 'project_kind',
  gitlabProject: 'gitlab_project', softwareTypes: 'software_types', runMode: 'run_mode', stage: 'stage', status: 'status',
  clarifyRound: 'clarify_round', baselineVersion: 'baseline_version', iteration: 'iteration', createdBy: 'created_by', updatedAt: 'updated_at',
};
const TC_COLS: Record<string, string> = {
  featureId: 'feature_id', purpose: 'purpose', data: 'data', steps: 'steps', expected: 'expected', status1: 'status1',
  status2: 'status2', realResult: 'real_result', evidence: 'evidence', comment: 'comment',
  scopeStatus: 'scope_status', changedByCr: 'changed_by_cr', baseline: 'baseline',
};

export class Repo {
  /** Web-facing storage: survey links, users, settings, templates. */
  readonly web: WebRepo;
  constructor(readonly db: DatabaseSync) { this.web = new WebRepo(db); }

  private all(sql: string, ...p: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...p) as Row[]; }
  private one(sql: string, ...p: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...p) as Row | undefined; }
  private run(sql: string, ...p: SQLInputValue[]) { return this.db.prepare(sql).run(...p); }

  // ---- requests ----
  nextRequestId(): string {
    const rows = this.all('select id from requests');
    let max = 0;
    for (const r of rows) {
      const m = /^REQ-(\d+)$/.exec(r.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `REQ-${String(max + 1).padStart(3, '0')}`;
  }

  createRequest(r: NewRequest): RequestRow {
    const id = this.nextRequestId();
    const now = Date.now();
    this.run(
      `insert into requests(id,title,description,perf_req,nonfunc_req,project_kind,gitlab_project,software_types,run_mode,stage,status,clarify_round,created_by,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,'INTAKE','running',0,?,?,?)`,
      id, r.title, r.description, r.perfReq, r.nonfuncReq, r.projectKind, r.gitlabProject, json(r.softwareTypes), r.runMode, r.createdBy, now, now,
    );
    return this.getRequest(id)!;
  }

  getRequest(id: string): RequestRow | undefined {
    const r = this.one('select * from requests where id=?', id);
    return r && toRequest(r);
  }

  listRequests(): RequestRow[] {
    return this.all('select * from requests order by created_at desc, id desc').map(toRequest);
  }

  updateRequest(id: string, patch: RequestPatch): RequestRow {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const [k, v] of Object.entries({ ...patch, updatedAt: Date.now() })) {
      const col = REQUEST_COLS[k];
      if (!col || v === undefined) continue;
      sets.push(`${col}=?`);
      vals.push((k === 'softwareTypes' ? json(v) : v) as SQLInputValue);
    }
    this.run(`update requests set ${sets.join(',')} where id=?`, ...vals, id);
    const r = this.getRequest(id);
    if (!r) throw new Error(`Request not found: ${id}`);
    return r;
  }

  // ---- attachments ----
  addAttachment(requestId: string, filename: string, path: string, size: number): AttachmentRow {
    const info = this.run('insert into attachments(request_id,filename,path,size,created_at) values(?,?,?,?,?)', requestId, filename, path, size, Date.now());
    return this.listAttachments(requestId).find(a => a.id === Number(info.lastInsertRowid))!;
  }
  listAttachments(requestId: string): AttachmentRow[] {
    return this.all('select * from attachments where request_id=? order by id', requestId).map(r => ({
      id: r.id, requestId: r.request_id, filename: r.filename, path: r.path, size: r.size, createdAt: r.created_at,
    }));
  }

  // ---- events ----
  addEvent(reqId: string, level: string, msg: string): EventRow {
    const ts = Date.now();
    const info = this.run('insert into events(request_id,ts,level,message) values(?,?,?,?)', reqId, ts, level, msg);
    return { id: Number(info.lastInsertRowid), requestId: reqId, ts, level, message: msg };
  }
  listEvents(reqId: string, afterId = 0): EventRow[] {
    return this.all('select * from events where request_id=? and id>? order by id', reqId, afterId).map(r => ({
      id: r.id, requestId: r.request_id, ts: r.ts, level: r.level, message: r.message,
    }));
  }

  // ---- questions / answers ----
  upsertQuestions(reqId: string, round: number, qs: Question[]): void {
    const st = this.db.prepare(
      `insert into questions(request_id,id,round,category,question,why,type,options,suggested_answer,priority) values(?,?,?,?,?,?,?,?,?,?)
       on conflict(request_id,id) do update set round=excluded.round,category=excluded.category,question=excluded.question,why=excluded.why,
       type=excluded.type,options=excluded.options,suggested_answer=excluded.suggested_answer,priority=excluded.priority`,
    );
    this.tx(() => { for (const q of qs) st.run(reqId, q.id, round, q.category, q.question, q.why, q.type, json(q.options), q.suggested_answer, q.priority); });
  }
  /** Deletes the given questions (e.g. unanswered questions raised by a rejected CR). */
  deleteQuestions(reqId: string, ids: string[]): void {
    const st = this.db.prepare('delete from questions where request_id=? and id=?');
    this.tx(() => { for (const id of ids) st.run(reqId, id); });
  }
  listQuestions(reqId: string): QuestionRow[] {
    return this.all('select * from questions where request_id=? order by round, id', reqId).map(toQuestion);
  }
  saveAnswer(reqId: string, qid: string, answer: string, source: AnswerSource): void {
    this.run('insert into answers(request_id,question_id,answer,source,created_at) values(?,?,?,?,?)', reqId, qid, answer, source, Date.now());
  }
  listAnswers(reqId: string): AnswerRow[] {
    return this.all('select * from answers where request_id=? order by seq', reqId).map(r => ({
      requestId: r.request_id, questionId: r.question_id, answer: r.answer, source: r.source, createdAt: r.created_at,
    }));
  }
  latestAnswers(reqId: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of this.all('select question_id, answer from answers where request_id=? order by seq', reqId)) m.set(r.question_id, r.answer);
    return m;
  }

  // ---- stage runs ----
  createStageRun(reqId: string, stage: Stage, feedback: string | null = null): StageRunRow {
    const prev = this.one('select max(attempt) a from stage_runs where request_id=? and stage=?', reqId, stage);
    const attempt = ((prev?.a as number | null) ?? 0) + 1;
    const info = this.run(
      "insert into stage_runs(request_id,stage,attempt,status,feedback,started_at) values(?,?,?,'running',?,?)",
      reqId, stage, attempt, feedback, Date.now(),
    );
    return toStageRun(this.one('select * from stage_runs where id=?', Number(info.lastInsertRowid))!);
  }
  finishStageRun(id: number, status: string, opts: { sessionId?: string; error?: string } = {}): void {
    this.run('update stage_runs set status=?, finished_at=?, claude_session_id=coalesce(?,claude_session_id), error=? where id=?',
      status, Date.now(), opts.sessionId ?? null, opts.error ?? null, id);
  }
  setStageRunSession(id: number, sessionId: string): void { this.run('update stage_runs set claude_session_id=? where id=?', sessionId, id); }
  latestStageRun(reqId: string, stage: Stage): StageRunRow | undefined {
    const r = this.one('select * from stage_runs where request_id=? and stage=? order by attempt desc, id desc limit 1', reqId, stage);
    return r && toStageRun(r);
  }
  listStageRuns(reqId: string): StageRunRow[] {
    return this.all('select * from stage_runs where request_id=? order by id', reqId).map(toStageRun);
  }

  // ---- jobs ----
  enqueueJob(requestId: string | null, kind: string, payload: unknown, runAfter = 0): JobRow {
    const info = this.run('insert into jobs(request_id,kind,payload,status,run_after) values(?,?,?,?,?)',
      requestId, kind, json(payload ?? {}), 'queued', runAfter);
    return this.getJob(Number(info.lastInsertRowid))!;
  }
  getJob(id: number): JobRow | undefined {
    const r = this.one('select * from jobs where id=?', id);
    return r && toJob(r);
  }
  listJobs(requestId?: string): JobRow[] {
    return (requestId ? this.all('select * from jobs where request_id=? order by id', requestId) : this.all('select * from jobs order by id')).map(toJob);
  }
  /** Atomically claim the oldest due job. Paused jobs whose run_after has passed are reclaimable (intended: pauseJob sets run_after). */
  claimNextJob(now: number): JobRow | undefined {
    return this.tx(() => {
      const r = this.one("select * from jobs where status in ('queued','paused') and run_after<=? order by run_after, id limit 1", now);
      if (!r) return undefined;
      this.run("update jobs set status='running', attempts=attempts+1 where id=?", r.id);
      return this.getJob(r.id);
    });
  }
  finishJob(id: number): void { this.run("update jobs set status='done', last_error=null where id=?", id); }
  failJob(id: number, error: string): void { this.run("update jobs set status='failed', last_error=? where id=?", error, id); }
  pauseJob(id: number, until: number): void { this.run("update jobs set status='paused', run_after=? where id=?", until, id); }
  /** On startup: jobs left 'running' by a crashed process go back to 'queued'. Returns number reset. */
  resetRunningJobs(): number {
    return Number(this.run("update jobs set status='queued' where status='running'").changes);
  }

  // ---- features ----
  upsertFeatures(reqId: string, fs: FeatureRow[]): void {
    const st = this.db.prepare(
      `insert into features(request_id,id,code,name,description,type_code,unit_test,note,kind,scope_status,changed_by_cr) values(?,?,?,?,?,?,?,?,?,?,?)
       on conflict(request_id,id) do update set code=excluded.code,name=excluded.name,description=excluded.description,
       type_code=excluded.type_code,unit_test=excluded.unit_test,note=excluded.note,kind=excluded.kind,
       scope_status=excluded.scope_status,changed_by_cr=excluded.changed_by_cr`,
    );
    this.tx(() => { for (const f of fs) st.run(reqId, f.id, f.code, f.name, f.description, f.typeCode, f.unitTest ? 1 : 0, f.note, f.kind, f.scopeStatus ?? 'active', f.changedByCr ?? null); });
  }
  /** Replaces the whole feature list of a request (a re-run of BREAKDOWN may drop features). */
  replaceFeatures(reqId: string, fs: FeatureRow[]): void {
    this.tx(() => {
      this.run('delete from features where request_id=?', reqId);
      this.upsertFeatures(reqId, fs);
    });
  }
  listFeatures(reqId: string): FeatureRow[] {
    return this.all('select * from features where request_id=? order by id', reqId).map(toFeature);
  }

  // ---- tasks ----
  upsertTask(reqId: string, t: TaskRow): void {
    this.run(
      `insert into tasks(request_id,id,title,feature_id,depends_on,status,review_rounds,branch,mr_iid,scope_status,changed_by_cr) values(?,?,?,?,?,?,?,?,?,?,?)
       on conflict(request_id,id) do update set title=excluded.title,feature_id=excluded.feature_id,depends_on=excluded.depends_on,
       status=excluded.status,review_rounds=excluded.review_rounds,branch=excluded.branch,mr_iid=excluded.mr_iid,
       scope_status=excluded.scope_status,changed_by_cr=excluded.changed_by_cr`,
      reqId, t.id, t.title, t.featureId, json(t.dependsOn), t.status, t.reviewRounds, t.branch, t.mrIid, t.scopeStatus ?? 'active', t.changedByCr ?? null,
    );
  }
  updateTask(reqId: string, id: string, patch: Partial<Omit<TaskRow, 'id'>>): void {
    const cur = this.getTask(reqId, id);
    if (!cur) throw new Error(`Task not found: ${reqId}/${id}`);
    this.upsertTask(reqId, { ...cur, ...patch });
  }
  getTask(reqId: string, id: string): TaskRow | undefined {
    const r = this.one('select * from tasks where request_id=? and id=?', reqId, id);
    return r && toTask(r);
  }
  listTasks(reqId: string): TaskRow[] {
    return this.all('select * from tasks where request_id=? order by id', reqId).map(toTask);
  }
  /** Replaces the whole task list of a request (a re-run of PLANNING may drop tasks). */
  replaceTasks(reqId: string, ts: TaskRow[]): void {
    this.tx(() => {
      this.run('delete from tasks where request_id=?', reqId);
      for (const t of ts) this.upsertTask(reqId, t);
    });
  }

  // ---- test cases ----
  upsertTestCase(reqId: string, t: TestCaseRow): void {
    this.run(
      `insert into test_cases(request_id,id,feature_id,purpose,data,steps,expected,status1,status2,real_result,evidence,comment,scope_status,changed_by_cr,baseline) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(request_id,id) do update set feature_id=excluded.feature_id,purpose=excluded.purpose,data=excluded.data,steps=excluded.steps,
       expected=excluded.expected,status1=excluded.status1,status2=excluded.status2,real_result=excluded.real_result,evidence=excluded.evidence,comment=excluded.comment,
       scope_status=excluded.scope_status,changed_by_cr=excluded.changed_by_cr,baseline=excluded.baseline`,
      reqId, t.id, t.featureId, t.purpose, t.data, t.steps, t.expected, t.status1, t.status2, t.realResult, json(t.evidence), t.comment, t.scopeStatus ?? 'active', t.changedByCr ?? null, t.baseline ?? null,
    );
  }
  updateTestCase(reqId: string, id: string, patch: Partial<Omit<TestCaseRow, 'id'>>): void {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = TC_COLS[k];
      if (!col || v === undefined) continue;
      sets.push(`${col}=?`);
      vals.push((k === 'evidence' ? json(v) : v) as SQLInputValue);
    }
    if (sets.length) this.run(`update test_cases set ${sets.join(',')} where request_id=? and id=?`, ...vals, reqId, id);
  }
  getTestCase(reqId: string, id: string): TestCaseRow | undefined {
    const r = this.one('select * from test_cases where request_id=? and id=?', reqId, id);
    return r && toTestCase(r);
  }
  listTestCases(reqId: string): TestCaseRow[] {
    return this.all('select * from test_cases where request_id=? order by id', reqId).map(toTestCase);
  }
  /** Replaces the whole test case list of a request (a re-run of PLANNING). */
  replaceTestCases(reqId: string, ts: TestCaseRow[]): void {
    this.tx(() => {
      this.run('delete from test_cases where request_id=?', reqId);
      for (const t of ts) this.upsertTestCase(reqId, t);
    });
  }

  // ---- bugs ----
  upsertBug(reqId: string, b: BugRow): void {
    this.run(
      `insert into bugs(request_id,tc_id,gitlab_iid,fix_attempts,status,note) values(?,?,?,?,?,?)
       on conflict(request_id,tc_id) do update set gitlab_iid=excluded.gitlab_iid,fix_attempts=excluded.fix_attempts,status=excluded.status,note=excluded.note`,
      reqId, b.tcId, b.gitlabIid, b.fixAttempts, b.status, b.note ?? null,
    );
  }
  /** Removes every bug of a request (a re-run of PLANNING starts testing from scratch). */
  clearBugs(reqId: string): void { this.run('delete from bugs where request_id=?', reqId); }
  getBug(reqId: string, tcId: string): BugRow | undefined {
    const r = this.one('select * from bugs where request_id=? and tc_id=?', reqId, tcId);
    return r && toBug(r);
  }
  listBugs(reqId: string): BugRow[] {
    return this.all('select * from bugs where request_id=? order by tc_id', reqId).map(toBug);
  }

  // ---- change requests ----
  nextCrId(reqId: string): string {
    let max = 0;
    for (const r of this.all('select id from change_requests where request_id=?', reqId)) {
      const m = /^CR-(\d+)$/.exec(r.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `CR-${String(max + 1).padStart(2, '0')}`;
  }
  createChangeRequest(
    reqId: string,
    c: { title: string; description: string; kind: CrKind; source: CrSource; createdBy?: number | null; status: CrStatus },
  ): ChangeRequestRow {
    return this.tx(() => {
      const id = this.nextCrId(reqId);
      this.run(
        'insert into change_requests(request_id,id,title,description,kind,source,status,created_by,created_at) values(?,?,?,?,?,?,?,?,?)',
        reqId, id, c.title, c.description, c.kind, c.source, c.status, c.createdBy ?? null, Date.now(),
      );
      return this.getChangeRequest(reqId, id)!;
    });
  }
  getChangeRequest(reqId: string, crId: string): ChangeRequestRow | undefined {
    const r = this.one('select * from change_requests where request_id=? and id=?', reqId, crId);
    return r && toCr(r);
  }
  listChangeRequests(reqId: string): ChangeRequestRow[] {
    return this.all('select * from change_requests where request_id=? order by id', reqId).map(toCr);
  }
  updateChangeRequest(reqId: string, crId: string, patch: Partial<Omit<ChangeRequestRow, 'id' | 'requestId' | 'createdAt' | 'createdBy'>>): ChangeRequestRow {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = CR_COLS[k];
      if (!col || v === undefined) continue;
      sets.push(`${col}=?`);
      vals.push(v as SQLInputValue);
    }
    if (sets.length) this.run(`update change_requests set ${sets.join(',')} where request_id=? and id=?`, ...vals, reqId, crId);
    const r = this.getChangeRequest(reqId, crId);
    if (!r) throw new Error(`Change request not found: ${reqId}/${crId}`);
    return r;
  }
  addCrAttachment(reqId: string, crId: string, filename: string, path: string): void {
    this.run('insert into cr_attachments(request_id,cr_id,filename,path) values(?,?,?,?)', reqId, crId, filename, path);
  }
  listCrAttachments(reqId: string, crId: string): CrAttachmentRow[] {
    return this.all('select * from cr_attachments where request_id=? and cr_id=? order by id', reqId, crId).map(r => ({
      crId: r.cr_id, requestId: r.request_id, filename: r.filename, path: r.path,
    }));
  }
  /** Marks a feature/task/test case active or cancelled; `changed_by_cr` records the CR responsible. Cancelled rows are never deleted. */
  setScope(kind: keyof typeof SCOPE_TABLES, reqId: string, id: string, scopeStatus: ScopeStatus, crId: string | null): void {
    const table = SCOPE_TABLES[kind];
    if (!table) throw new Error(`Unknown scope kind: ${String(kind)}`);
    this.run(`update ${table} set scope_status=?, changed_by_cr=? where request_id=? and id=?`, scopeStatus, crId, reqId, id);
  }

  private txDepth = 0;
  /** Runs fn in a transaction; nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try { return fn(); } finally { this.txDepth--; }
    }
    this.txDepth = 1;
    try { return this.txOuter(fn); } finally { this.txDepth = 0; }
  }
  private txOuter<T>(fn: () => T): T {
    this.db.exec('begin immediate');
    try { const v = fn(); this.db.exec('commit'); return v; } catch (e) { this.db.exec('rollback'); throw e; }
  }
}
