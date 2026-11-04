import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Repo } from '../../db/repo.js';
import type { AnswerSource, QuestionRow } from '../../domain/types.js';
import type { PromptExtras, PromptOutput } from '../prompt.js';
import type { StageContext } from '../pipeline.js';
import type { Workspace } from '../workspace.js';

export const MAX_CLARIFY_ROUNDS = 5;

/** Integration branch of a request. */
export const integrationBranch = (reqId: string): string => `devflow/${reqId}`;

/** Request context, input files and reviewer feedback for buildPrompt. */
export function promptExtras(ctx: StageContext, outputs: PromptOutput[]): PromptExtras {
  const { req } = ctx;
  return {
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
