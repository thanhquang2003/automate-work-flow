import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import { addTrustedRoot } from './safe-fs.js';

/** Minimal request shape needed to locate a workspace. */
export interface WorkspaceReq { id: string; projectId?: number | null; code?: string | null }

const CODE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const SAFE_NAME = /^[\w.-]+$/;

/**
 * Where a request lives on disk.
 * - Legacy (v2/local): `<dataDir>/workspaces/<id>/{repo,inputs,artifacts,evidence,logs}`.
 * - Project-rooted (v3): `<project>/.devflow/requests/<code>/{inputs,artifacts,evidence,logs}`, the request worktree
 *   `<project>/.devflow/worktrees/<code>` (branch `devflow/<code>`) and docs under `docs/devflow/<code>/` in it.
 */
export class Workspace {
  readonly repoDir: string;
  readonly inputsDir: string;
  readonly artifactsDir: string;
  readonly evidenceDir: string;
  readonly logsDir: string;
  readonly devflowDir: string;
  /** Request key used in branch and artifact names: the request code in v3, the request id for legacy requests. */
  readonly key: string;
  /** Repo-relative docs folder of this request. */
  readonly docsRel: string;
  /** Project folder (v3 only). */
  readonly projectDir?: string;

  private constructor(readonly root: string, o: { key: string; repoDir: string; docsRel: string; projectDir?: string }) {
    this.key = o.key;
    this.repoDir = o.repoDir;
    this.docsRel = o.docsRel;
    this.projectDir = o.projectDir;
    this.inputsDir = join(root, 'inputs');
    this.artifactsDir = join(root, 'artifacts');
    this.evidenceDir = join(root, 'evidence');
    this.logsDir = join(root, 'logs');
    this.devflowDir = join(this.repoDir, ...o.docsRel.split('/'));
    // Everything DevFlow writes for this request lies under this folder: safe-fs checks paths from here down.
    addTrustedRoot(o.projectDir ?? root);
  }

  get isProjectRooted(): boolean { return this.projectDir !== undefined; }

  /** Legacy layout (request id based). */
  static for(cfg: Config, reqId: string): Workspace {
    if (!/^[\w.-]+$/.test(reqId) || reqId.includes('..')) throw new Error(`Invalid request id: ${reqId}`);
    const root = resolve(cfg.dataDir, 'workspaces', reqId);
    return new Workspace(root, { key: reqId, repoDir: join(root, 'repo'), docsRel: 'docs/devflow' });
  }

  /** Project-rooted layout. `projectPath` must already be a validated project folder. */
  static forProject(projectPath: string, code: string): Workspace {
    if (!CODE_RE.test(code) || code === '.' || code === '..' || code.includes('..')) throw new Error(`Invalid request code: ${code}`);
    const dot = join(projectPath, '.devflow');
    return new Workspace(join(dot, 'requests', code), {
      key: code, repoDir: join(dot, 'worktrees', code), docsRel: `docs/devflow/${code}`, projectDir: projectPath,
    });
  }

  /** The right layout for a request: project-rooted when it has a project and code, else legacy. */
  static forRequest(cfg: Config, repo: Repo, req: WorkspaceReq): Workspace {
    if (req.projectId != null && req.code) {
      const p = repo.getProject(req.projectId);
      if (!p) throw new Error(`Project not found: ${req.projectId}`);
      return Workspace.forProject(p.path, req.code);
    }
    return Workspace.for(cfg, req.id);
  }

  /** Worktree of a task: `.devflow/worktrees/<code>-<TASK>` (v3 only). */
  taskWorktree(taskId: string): string {
    if (!this.projectDir) throw new Error('Task worktrees exist only for project-rooted requests');
    if (!SAFE_NAME.test(taskId) || taskId.includes('..')) throw new Error(`Invalid task id: ${taskId}`);
    return join(this.projectDir, '.devflow', 'worktrees', `${this.key}-${taskId}`);
  }

  /** Branch of a task: `devflow/<code>-<TASK>`. */
  taskBranch(taskId: string): string {
    if (!SAFE_NAME.test(taskId) || taskId.includes('..')) throw new Error(`Invalid task id: ${taskId}`);
    return `devflow/${this.key}-${taskId}`;
  }

  /** Creates the request folders. The repo dir is created by `git worktree add` (v3) or INTAKE (legacy), not here. */
  ensure(): this {
    const dirs = [this.root, this.inputsDir, this.artifactsDir, this.evidenceDir, this.logsDir];
    if (!this.projectDir) dirs.push(this.repoDir);
    for (const d of dirs) mkdirSync(d, { recursive: true });
    return this;
  }
}
