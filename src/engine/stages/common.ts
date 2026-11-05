import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Repo } from '../../db/repo.js';
import type { AnswerSource, ChangeRequestRow, QuestionRow, TestCaseRow, TestStatus } from '../../domain/types.js';
import type { GitLabClient } from '../../gitlab/client.js';
import type { TcSheetRow } from '../../office/testcase-xlsx.js';
import { changesSection, type PromptExtras, type PromptOutput } from '../prompt.js';
import type { StageContext } from '../pipeline.js';
import type { Workspace } from '../workspace.js';

export const MAX_CLARIFY_ROUNDS = 5;

/** Integration branch of a request. */
export const integrationBranch = (reqId: string): string => `devflow/${reqId}`;

/** Request context, input files, reviewer feedback and accepted change requests for buildPrompt. */
export function promptExtras(ctx: StageContext, outputs: PromptOutput[]): PromptExtras {
  const { req } = ctx;
  return {
    changes: ctx.changes.length ? changesSection(ctx) : undefined,
    request: {
      id: req.id, title: req.title, description: req.description, perfReq: req.perfReq, nonfuncReq: req.nonfuncReq,
      softwareTypes: req.softwareTypes, projectKind: req.projectKind,
    },
    inputs: listFiles(ctx.ws.inputsDir),
    feedback: ctx.feedback,
    outputs,
  };
}

/** Absolute paths of all files under a directory (recursive, sorted). */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** `path` in backticks when the file exists, else the fallback text (for prompt variables). */
export function fileRef(path: string, fallback: string): string {
  return existsSync(path) ? `\`${path}\`` : fallback;
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---- project info (written by INTAKE, read by later stages) ----

export interface ProjectInfo {
  /** True when the repo is backed by a GitLab project. */
  gitlab: boolean;
  projectId?: number;
  pathWithNamespace?: string;
  /** Project default branch: never pushed to or merged into by DevFlow. */
  defaultBranch?: string;
  webUrl?: string;
  /** Integration branch devflow/<REQ>. */
  branch: string;
}

const projectFile = (ws: Workspace): string => join(ws.root, 'project.json');

export function writeProjectInfo(ws: Workspace, info: ProjectInfo): void { writeJson(projectFile(ws), info); }

export function readProjectInfo(ws: Workspace): ProjectInfo | undefined {
  const p = projectFile(ws);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8')) as ProjectInfo;
}

/**
 * Pushes a DevFlow branch when the repo has an `origin` remote. Refuses the project's default branch.
 * Returns whether a push happened.
 */
export async function pushIfRemote(ctx: StageContext, branch: string): Promise<boolean> {
  const info = readProjectInfo(ctx.ws);
  const norm = (b: string) => b.replace(/^refs\/heads\//, '');
  if (info?.defaultBranch && norm(branch) === norm(info.defaultBranch)) throw new Error(`Không được push vào nhánh mặc định ${info.defaultBranch}`);
  if (!branch.startsWith('devflow/')) throw new Error(`Chỉ push nhánh devflow/*, nhận được ${branch}`);
  if (!(await ctx.git.hasRemote())) return false;
  await ctx.git.push(branch);
  return true;
}

/** Makes sure the repo is on the integration branch (creating it locally if missing). */
export async function ensureOnBranch(ctx: StageContext, branch: string): Promise<void> {
  const cur = await ctx.git.currentBranch().catch(() => '');
  if (cur === branch) return;
  try {
    await ctx.git.checkout(branch);
  } catch {
    await ctx.git.checkout(branch, true);
  }
}

// ---- questions / answers ----

export interface AnswerEntry { id: string; question: string; answer: string; source: AnswerSource }
export interface AssumptionEntry { id: string; question: string; assumption: string; priority: 'must' | 'should'; why: string }

/** Latest non-empty answer per question, with its source, in question order. */
export function answeredQuestions(repo: Repo, reqId: string): AnswerEntry[] {
  const latest = new Map<string, { answer: string; source: AnswerSource }>();
  for (const a of repo.listAnswers(reqId)) latest.set(a.questionId, { answer: a.answer, source: a.source });
  const out: AnswerEntry[] = [];
  for (const q of repo.listQuestions(reqId)) {
    const a = latest.get(q.id);
    if (a && a.answer.trim()) out.push({ id: q.id, question: q.question, answer: a.answer, source: a.source });
  }
  return out;
}

/** Questions without a (non-empty) answer. */
export function openQuestions(repo: Repo, reqId: string): QuestionRow[] {
  const answered = new Set(answeredQuestions(repo, reqId).map(a => a.id));
  return repo.listQuestions(reqId).filter(q => !answered.has(q.id));
}

export const answersPath = (ws: Workspace): string => join(ws.devflowDir, 'answers.json');
export const assumptionsPath = (ws: Workspace): string => join(ws.devflowDir, 'assumptions.json');
/** Per-CR output folder of the CHANGE stage: impact.md + impact.json. */
export const changeDir = (ws: Workspace, crId: string): string => join(ws.devflowDir, 'changes', crId);
export const codebaseMapPath = (ws: Workspace): string => join(ws.devflowDir, 'codebase-map.md');

export function writeAnswers(ctx: StageContext): AnswerEntry[] {
  const answers = answeredQuestions(ctx.repo, ctx.req.id);
  writeJson(answersPath(ctx.ws), answers);
  return answers;
}

/** Turns every still-open question into an explicit assumption (its suggested answer), written to assumptions.json. */
export function writeAssumptions(ctx: StageContext): AssumptionEntry[] {
  const list = openQuestions(ctx.repo, ctx.req.id).map(q => ({
    id: q.id,
    question: q.question,
    assumption: q.suggested_answer.trim() || 'Chưa có đề xuất — cần khách hàng xác nhận',
    priority: q.priority,
    why: q.why,
  }));
  writeJson(assumptionsPath(ctx.ws), list);
  return list;
}

/** Prompt variables shared by the analyst/architect prompts. */
export function contextFileVars(ctx: StageContext): Record<string, string> {
  const ws = ctx.ws;
  return {
    devflow_dir: ws.devflowDir,
    codebase_map: fileRef(codebaseMapPath(ws), '(không có — dự án mới)'),
    answers_file: fileRef(answersPath(ws), '(chưa có câu trả lời nào)'),
    assumptions_file: fileRef(assumptionsPath(ws), '(không có)'),
  };
}

// ---- markdown heading checks ----

const normHeading = (s: string): string => s.normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();

/** Heading texts of a level, normalised (numbering prefix stripped, case/space folded). */
export function headings(md: string, level: number): string[] {
  const re = new RegExp(`^#{${level}}[ \\t]+(.+?)[ \\t]*#*[ \\t]*$`, 'gm');
  return [...md.replace(/\r\n?/g, '\n').matchAll(re)].map(m => normHeading(m[1]!.replace(/^\d+(\.\d+)*\.?\s+/, '')));
}

/** Required [level, text] headings that are missing from the markdown, rendered as "## text". */
export function missingHeadings(md: string, wanted: [number, string][]): string[] {
  return wanted.filter(([lvl, text]) => !headings(md, lvl).includes(normHeading(text))).map(([lvl, text]) => `${'#'.repeat(lvl)} ${text}`);
}

/** True when a heading (already normalised) starts with the code followed by a separator or nothing. */
export function headingHasCode(h: string, code: string): boolean {
  const c = normHeading(code);
  return h === c || (h.startsWith(c) && /^[\s:\-–—]/.test(h.slice(c.length)));
}

/** Repo-relative pathspec of the DevFlow docs folder (the only thing stages commit). */
export const DOCS_PATHSPEC = 'docs/devflow';

// ---- part 2 helpers: GitLab project handle, scratch dir, flow state, integration branch prep ----

/** GitLab client + project when the request is backed by GitLab; undefined in local-only mode. */
export interface ProjectGitLab { client: GitLabClient; pid: number; defaultBranch: string; webUrl?: string }

export function projectGitLab(ctx: StageContext): ProjectGitLab | undefined {
  const info = readProjectInfo(ctx.ws);
  if (!info?.gitlab || !ctx.gitlab || info.projectId === undefined || !info.defaultBranch) return undefined;
  return { client: ctx.gitlab, pid: info.projectId, defaultBranch: info.defaultBranch, webUrl: info.webUrl };
}

/** DevFlow-internal scratch folder inside the repo (gitignored): Claude's summaries and review JSON. */
export const SCRATCH_DIR = '.devflow-tmp';
export const scratchDir = (ws: Workspace): string => join(ws.repoDir, SCRATCH_DIR);

/** Adds `.devflow-tmp/` to the repo's .gitignore when missing. Returns true when the file changed. */
export function ensureGitignore(repoDir: string): boolean {
  const p = join(repoDir, '.gitignore');
  const cur = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (cur.split(/\r?\n/).some(l => l.trim() === `${SCRATCH_DIR}/` || l.trim() === SCRATCH_DIR || l.trim() === `/${SCRATCH_DIR}/`)) return false;
  writeFileSync(p, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${SCRATCH_DIR}/\n`, 'utf8');
  return true;
}

/**
 * Checks out the integration branch devflow/<REQ>, pulls it from GitLab when there is a remote, and makes sure
 * `.devflow-tmp/` is gitignored (committed and pushed on the integration branch). Returns the branch name.
 */
export async function prepareIntegration(ctx: StageContext): Promise<string> {
  const branch = integrationBranch(ctx.req.id);
  await ensureOnBranch(ctx, branch);
  if (await ctx.git.hasRemote()) await ctx.git.pull(branch);
  if (ensureGitignore(ctx.ws.repoDir)) {
    await ctx.git.commitPaths(['.gitignore'], `chore(devflow): bỏ qua thư mục tạm ${SCRATCH_DIR}/`);
    await pushIfRemote(ctx, branch);
  }
  return branch;
}

/** Per-request bookkeeping that has no DB column (test run history, issue URLs, bugfix review rounds, final MR). */
/**
 * One Tester result of a TC. `seq` orders runs against merges into the integration branch (FlowState.clock);
 * `baseline` is the request baseline the run was made at (absent in runs recorded before change requests existed).
 */
export interface TestRun { run: number; seq: number; status: TestStatus; real_result: string; comment: string; evidence: string[]; baseline?: number }
export interface FlowState {
  runs: Record<string, TestRun[]>;
  issueUrls: Record<string, string>;
  /** Highest run number per TC whose bug/issue sync is done (TEST reconcile is idempotent). */
  bugSynced: Record<string, number>;
  /** Monotonic counter shared by test runs and merges into the integration branch. */
  clock: number;
  /**
   * `clock` value of the last merge into devflow/<REQ> — a bug fix, a DEVELOP task or a feedback item (0 = none).
   * A P result older than this triggers the regression run (the name predates task merges counting).
   */
  lastFixSeq: number;
  /** Review rounds of work items without a DB column (bug fixes, feedback items), by work key. */
  reviewRounds: Record<string, number>;
  /** MR iid of work items without a DB column, by work key. */
  mrIids?: Record<string, number>;
  /** Number of DEVELOP gate-feedback work items done. */
  feedbackItems?: number;
  finalMrUrl?: string;
  /** Baseline whose iteration summary was already added as a note on the open final MR (DONE is idempotent). */
  finalMrNotedBaseline?: number;
  /** Bugs closed by an accepted CR whose GitLab issue TEST already closed (`<TC>@<note>`). */
  crClosedIssues?: string[];
}

const flowFile = (ws: Workspace): string => join(ws.root, 'flow-state.json');

export function readFlowState(ws: Workspace): FlowState {
  const p = flowFile(ws);
  const empty: FlowState = { runs: {}, issueUrls: {}, reviewRounds: {}, bugSynced: {}, clock: 0, lastFixSeq: 0 };
  if (!existsSync(p)) return empty;
  return { ...empty, ...(JSON.parse(readFileSync(p, 'utf8')) as Partial<FlowState>) };
}

export function writeFlowState(ws: Workspace, s: FlowState): void { writeJson(flowFile(ws), s); }

export function updateFlowState(ws: Workspace, fn: (s: FlowState) => void): FlowState {
  const s = readFlowState(ws);
  fn(s);
  writeJson(flowFile(ws), s);
  return s;
}

/** Test cases in report order: by feature id, then TC id. */
export function sortedTestCases(repo: Repo, reqId: string): TestCaseRow[] {
  return repo.listTestCases(reqId).sort((a, b) => (a.featureId ?? '').localeCompare(b.featureId ?? '') || a.id.localeCompare(b.id));
}

// ---- versioned artifacts (spec §4.4): <KIND>_<REQ>_v<N>.<ext>, N = baseline; older versions are kept ----

export type ArtifactKind = 'TKCT' | 'TKDB' | 'ULNL' | 'TestCase';
const ARTIFACT_EXT: Record<ArtifactKind, string> = { TKCT: 'docx', TKDB: 'docx', ULNL: 'xlsx', TestCase: 'xlsx' };

/** File name of an artifact at a baseline: `TKCT_REQ-001_v2.docx`. */
export function artifactName(kind: ArtifactKind, reqId: string, baseline: number): string {
  return `${kind}_${reqId}_v${baseline}.${ARTIFACT_EXT[kind]}`;
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Absolute path of the newest version of an artifact in ws.artifactsDir, or undefined when there is none.
 * Names without a version suffix (written before versioning) count as v1; a suffixed v1 wins over the unsuffixed one.
 */
export function latestArtifact(ws: Workspace, kind: ArtifactKind, reqId: string): string | undefined {
  if (!existsSync(ws.artifactsDir)) return undefined;
  const re = new RegExp(`^${escRe(kind)}_${escRe(reqId)}(?:_v(\\d+))?\\.${ARTIFACT_EXT[kind]}$`);
  let best: { name: string; v: number; suffixed: boolean } | undefined;
  for (const name of readdirSync(ws.artifactsDir)) {
    const m = re.exec(name);
    if (!m) continue;
    const cand = { name, v: m[1] ? Number(m[1]) : 1, suffixed: !!m[1] };
    if (!best || cand.v > best.v || (cand.v === best.v && cand.suffixed && !best.suffixed)) best = cand;
  }
  return best && join(ws.artifactsDir, best.name);
}

// ---- incremental runs after accepted change requests (spec §4.4) ----

/**
 * True when stages must update earlier outputs instead of replacing them: accepted CRs are pending, or the request
 * already went through a change (baseline > 1). Cancelled or omitted rows are then never deleted.
 */
export const isIncremental = (ctx: StageContext): boolean => ctx.changes.length > 0 || ctx.baseline > 1;

export type ScopeKind = 'feature' | 'task' | 'test_case';

/**
 * CR responsible for a scope change of an item: the accepted CR whose impact names the item (removed, modified or
 * affected), else the latest accepted CR. Undefined when there is no accepted change.
 */
export function crResponsible(ctx: StageContext, kind: ScopeKind, id: string): string | undefined {
  for (const { cr, impact } of [...ctx.changes].reverse()) {
    const names = kind === 'feature'
      ? [...impact.scope.remove, ...impact.scope.modify.map(m => m.feature_id), ...impact.affected.features]
      : kind === 'task' ? impact.affected.tasks : impact.affected.test_cases;
    if (names.includes(id)) return cr.id;
  }
  return ctx.changes.at(-1)?.cr.id;
}

/** Accepted or applied change requests (rejected ones carry baselineFrom too and must be filtered out). */
export const effectiveChanges = (crs: ChangeRequestRow[]): ChangeRequestRow[] =>
  crs.filter(c => (c.status === 'accepted' || c.status === 'applied') && c.baselineTo !== null).sort((a, b) => (a.baselineTo! - b.baselineTo!) || a.id.localeCompare(b.id));

export const designFile = (ws: Workspace, name: 'tkct.md' | 'tkdb.md'): string => join(ws.devflowDir, 'design', name);

/** DB test case → workbook row. */
export function tcSheetRow(tc: TestCaseRow): TcSheetRow {
  return {
    id: tc.id, purpose: tc.purpose, data: tc.data, steps: tc.steps, expected: tc.expected,
    real_result: tc.realResult ?? undefined, status1: tc.status1 ?? undefined, status2: tc.status2 ?? undefined,
    evidence: tc.evidence, comment: tc.comment ?? undefined,
    ...(tc.scopeStatus === 'cancelled' ? { cancelledBy: tc.changedByCr ?? '' } : {}),
  };
}

/**
 * Work branch of a request (task, bug fix, feedback): `devflow/<REQ>-<name>`. Spec §6 says `devflow/<REQ>/<TASK>`, but
 * git cannot hold both `refs/heads/devflow/<REQ>` and `refs/heads/devflow/<REQ>/…` (ref directory/file conflict).
 */
export const workBranch = (reqId: string, name: string): string => `${integrationBranch(reqId)}-${name}`;
