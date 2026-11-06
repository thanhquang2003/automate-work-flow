import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import { REQUEST_CODE_RE, assertProjectRole } from '../db/repo.js';
import { PROJECT_ROLES, type ProjectRole, type ProjectRow, type RequestRow, type RunMode, type SoftwareType, type UserRow } from '../domain/types.js';
import type { GitLabClient } from '../gitlab/client.js';
import { Git } from '../gitlab/git.js';
import { can, type Action, type Actor, type Ctx } from '../security/permissions.js';
import { PathError, resolveProjectPath } from './paths.js';

/** The caller lacks the right (or a member would break the department rule). Maps to HTTP 403. */
export class PermissionError extends Error {}
/** Invalid input or state (bad path, bad code, role without member...). Maps to HTTP 400/409. */
export class ProjectError extends Error {}

/**
 * OS-level side of projects (Linux groups for the seat users). Task 4 provides the real implementation;
 * the service only needs these two calls.
 */
export interface ProjectSystemOps {
  ensureProjectGroup(projectId: number, path: string): Promise<void> | void;
  /** The complete list of users that may access the project folder after the change. */
  setMembers(projectId: number, userIds: number[]): Promise<void> | void;
}

export class NoopProjectSystemOps implements ProjectSystemOps {
  ensureProjectGroup(): void { /* local mode / tests */ }
  setMembers(): void { /* local mode / tests */ }
}

export interface ProjectServiceDeps {
  cfg: Pick<Config, 'projectRoots' | 'mode'>;
  repo: Repo;
  systemOps?: ProjectSystemOps;
  /** GitLab client for clone / new-with-GitLab modes. */
  gitlab?: GitLabClient;
  /** Token for git clone/push; defaults to `gitlab.token`. */
  gitlabToken?: string;
}

export interface CreateProjectInput {
  mode: 'existing' | 'clone' | 'new';
  key: string;
  name: string;
  path: string;
  gitlabProject?: string | null;
  createdBy: number;
}

export interface MemberInput { userId: number; roles: ProjectRole[] }

export interface CreateRequestInput {
  projectId: number;
  code: string;
  title: string;
  description: string;
  perfReq: string;
  nonfuncReq: string;
  softwareTypes: SoftwareType[];
  runMode: RunMode;
  /** Per role, ordered users (first = runner). Roles not listed default to every member holding the role. */
  assignees?: Partial<Record<ProjectRole, number[]>>;
  by: number;
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,11}$/;
const INIT_BRANCH = 'main';

const isDirEmpty = (p: string): boolean => readdirSync(p).length === 0;

export class ProjectService {
  private readonly repo: Repo;
  private readonly systemOps: ProjectSystemOps;

  constructor(private deps: ProjectServiceDeps) {
    this.repo = deps.repo;
    this.systemOps = deps.systemOps ?? new NoopProjectSystemOps();
  }

  // ---- actors ----

  private user(id: number): UserRow {
    const u = this.repo.web.getUser(id);
    if (!u || u.disabled) throw new PermissionError('Tài khoản không tồn tại hoặc đã bị khóa.');
    return u;
  }

  private actor(u: UserRow, projectId?: number): Actor {
    const roles = projectId === undefined ? [] : this.repo.getProjectMember(projectId, u.id)?.roles ?? [];
    return { userId: u.id, sysRole: u.sysRole, departmentId: u.departmentId, canBePm: u.canBePm, projectRoles: roles };
  }

  private require(u: UserRow, action: Action, ctx: Ctx, project?: ProjectRow, what = 'thực hiện thao tác này'): void {
    if (!can(this.actor(u, project?.id), action, ctx)) throw new PermissionError(`Bạn không có quyền ${what}.`);
  }

  // ---- projects ----

  async createProject(input: CreateProjectInput): Promise<ProjectRow> {
    const by = this.user(input.createdBy);
    this.require(by, 'project.create', {}, undefined, 'tạo dự án (cần quyền PM và thuộc một phòng)');
    if (by.departmentId === null) throw new PermissionError('Người dùng chưa thuộc phòng nào nên không thể tạo dự án.');
    if (!['existing', 'clone', 'new'].includes(input.mode)) throw new ProjectError(`Chế độ không hợp lệ: ${String(input.mode)}`);
    if (!KEY_RE.test(input.key)) throw new ProjectError('Mã dự án (key) gồm 2-12 ký tự chữ HOA hoặc số, bắt đầu bằng chữ.');
    const name = input.name.trim();
    if (!name) throw new ProjectError('Chưa nhập tên dự án.');
    if (this.repo.getProjectByKey(input.key)) throw new ProjectError(`Mã dự án (key) ${input.key} đã được dùng.`);

    let path: string;
    try { path = resolveProjectPath(input.path, this.deps.cfg.projectRoots); } catch (e) {
      if (e instanceof PathError) throw new ProjectError(e.message);
      throw e;
    }
    if (this.repo.getProjectByPath(path)) throw new ProjectError('Thư mục này đã thuộc một dự án khác.');
    for (const o of this.repo.listProjects({ includeArchived: true })) {
      if (path.startsWith(`${o.path}/`) || o.path.startsWith(`${path}/`)) throw new ProjectError(`Thư mục lồng nhau với dự án ${o.key}: mỗi dự án phải có thư mục riêng.`);
    }

    const git = new Git(path, { mode: this.deps.cfg.mode, token: this.deps.gitlabToken ?? this.deps.gitlab?.token });
    let defaultBranch: string;
    let gitlabProject = input.gitlabProject?.trim() || null;

    // Everything below only creates files inside a validated path; DevFlow never deletes anything.
    if (input.mode === 'existing') {
      if (!existsSync(path)) throw new ProjectError('Thư mục dự án có sẵn không tồn tại.');
      if (!statSync(path).isDirectory()) throw new ProjectError('Đường dẫn dự án không phải thư mục.');
      if (existsSync(join(path, '.git'))) {
        if (!(await git.hasCommits())) await this.initialCommit(git, path, name, INIT_BRANCH, false);
        defaultBranch = await git.currentBranch();
        if (defaultBranch === 'HEAD') throw new ProjectError('Repo đang ở trạng thái detached HEAD; hãy checkout nhánh mặc định trước.');
      } else if (isDirEmpty(path)) {
        defaultBranch = INIT_BRANCH;
        await this.initialCommit(git, path, name, defaultBranch, true);
      } else {
        throw new ProjectError('Thư mục có sẵn nhưng không phải repo git và không rỗng. Hãy `git init` thủ công hoặc chọn thư mục rỗng.');
      }
    } else if (input.mode === 'clone') {
      if (!gitlabProject) throw new ProjectError('Chưa chọn GitLab project để clone.');
      if (!this.deps.gitlab) throw new ProjectError('Chưa cấu hình GitLab nên không thể clone.');
      if (existsSync(path) && !(statSync(path).isDirectory() && isDirEmpty(path))) throw new ProjectError('Thư mục đích đã tồn tại và không rỗng.');
      const p = await this.deps.gitlab.getProject(gitlabProject);
      if (!p.default_branch) throw new ProjectError(`GitLab project "${gitlabProject}" là repo rỗng. Hãy dùng chế độ "mới".`);
      mkdirSync(join(path, '..'), { recursive: true });
      await new Git(join(path, '..'), { mode: this.deps.cfg.mode, token: this.deps.gitlabToken ?? this.deps.gitlab.token }).clone(p.http_url_to_repo, this.deps.gitlabToken ?? this.deps.gitlab.token, path);
      defaultBranch = p.default_branch;
      gitlabProject = p.path_with_namespace;
    } else {
      if (existsSync(path) && !(statSync(path).isDirectory() && isDirEmpty(path))) throw new ProjectError('Thư mục đích đã tồn tại và không rỗng. Dùng chế độ "có sẵn".');
      mkdirSync(path, { recursive: true });
      defaultBranch = INIT_BRANCH;
      await this.initialCommit(git, path, name, defaultBranch, true);
      if (gitlabProject && this.deps.gitlab) {
        const gl = this.deps.gitlab;
        let p;
        try { p = await gl.getProject(gitlabProject); } catch {
          const group = gitlabProject.includes('/') ? gitlabProject.slice(0, gitlabProject.lastIndexOf('/')) : '';
          const ns = group ? await gl.findGroupId(group) : undefined;
          if (group && ns === undefined) throw new ProjectError(`Không tìm thấy GitLab group "${group}".`);
          p = await gl.createProject(gitlabProject.split('/').pop()!, ns);
        }
        await git.addRemote('origin', p.http_url_to_repo);
        await git.push(defaultBranch);
        gitlabProject = p.path_with_namespace;
      }
    }

    await git.excludeLocal('.devflow/');

    const project = this.repo.tx(() => {
      const row = this.repo.createProject({ key: input.key, name, path, departmentId: by.departmentId!, gitlabProject, defaultBranch, createdBy: by.id });
      this.repo.setProjectMember(row.id, by.id, ['PM'], by.id);
      this.repo.web.addAudit({ projectId: row.id, userId: by.id, action: 'project.create', detail: JSON.stringify({ key: row.key, path, mode: input.mode, defaultBranch }) });
      return row;
    });
    await this.systemOps.ensureProjectGroup(project.id, path);
    return project;
  }

  private async initialCommit(git: Git, path: string, name: string, branch: string, init: boolean): Promise<void> {
    if (init) await git.init(branch);
    const readme = join(path, 'README.md');
    if (!existsSync(readme)) writeFileSync(readme, `# ${name}\n`, 'utf8');
    await git.commitPaths(['README.md'], 'chore: khởi tạo dự án');
  }

  // ---- members ----

  async setMembers(projectId: number, members: MemberInput[], byId: number): Promise<void> {
    const project = this.repo.getProject(projectId);
    if (!project) throw new ProjectError('Không tìm thấy dự án.');
    const by = this.user(byId);

    const seen = new Set<number>();
    const clean: MemberInput[] = [];
    const depts: (number | null)[] = [];
    for (const m of members) {
      if (seen.has(m.userId)) throw new ProjectError(`Người dùng #${m.userId} xuất hiện hai lần trong danh sách thành viên.`);
      seen.add(m.userId);
      if (!Array.isArray(m.roles) || !m.roles.length) throw new ProjectError(`Thành viên #${m.userId} chưa có vai trò nào.`);
      for (const r of m.roles) {
        try { assertProjectRole(r); } catch { throw new ProjectError(`Vai trò không hợp lệ: ${String(r)} (hợp lệ: ${PROJECT_ROLES.join(', ')}).`); }
      }
      const u = this.repo.web.getUser(m.userId);
      if (!u || u.disabled) throw new ProjectError(`Người dùng #${m.userId} không tồn tại hoặc đã bị khóa.`);
      depts.push(u.departmentId);
      clean.push({ userId: m.userId, roles: [...new Set(m.roles)] });
    }

    // Permission first (so outsiders learn nothing), then the department rule with its own message.
    if (!this.actor(by, project.id).projectRoles.includes('PM')) throw new PermissionError('Chỉ PM của dự án được sửa thành viên.');
    if (depts.some(d => d === null)) throw new PermissionError('Người dùng chưa thuộc phòng nào không thể tham gia dự án.');
    if (depts.some(d => d !== project.departmentId)) throw new PermissionError('Chỉ người cùng phòng với dự án mới được làm thành viên.');
    this.require(by, 'project.members.edit', { project: { departmentId: project.departmentId }, memberDepartmentIds: depts }, project, 'sửa thành viên dự án');
    if (!clean.some(m => m.roles.includes('PM'))) throw new ProjectError('Dự án phải còn ít nhất một PM.');

    const before = this.repo.listProjectMembers(projectId);
    this.repo.tx(() => {
      const keep = new Map(clean.map(m => [m.userId, m.roles]));
      for (const old of before) {
        if (!keep.has(old.userId)) {
          this.repo.removeProjectMember(projectId, old.userId);
          this.repo.removeRequestAssigneeEverywhere(old.userId, projectId);
        }
      }
      for (const m of clean) this.repo.setProjectMember(projectId, m.userId, m.roles, by.id);
      // A member who lost a role is no longer an assignee for it.
      for (const r of this.repo.listRequestsByProject(projectId)) {
        for (const role of PROJECT_ROLES) {
          const cur = this.repo.listRequestAssignees(r.id, role).map(a => a.userId);
          const ok = cur.filter(u => keep.get(u)?.includes(role));
          if (ok.length !== cur.length) this.repo.setRequestAssignees(r.id, role, ok);
        }
      }
      this.repo.web.addAudit({
        projectId, userId: by.id, action: 'project.members.set',
        detail: JSON.stringify({ before: before.map(m => ({ u: m.userId, r: m.roles })), after: clean.map(m => ({ u: m.userId, r: m.roles })) }),
      });
    });
    await this.systemOps.setMembers(projectId, clean.map(m => m.userId));
  }

  // ---- request assignees ----

  /** Ordered people for one role of a request (first = runner). Persists only; the engine reacts in Task 5. */
  setAssignees(requestId: string, role: ProjectRole, userIds: number[], byId: number): void {
    try { assertProjectRole(role); } catch { throw new ProjectError(`Vai trò không hợp lệ: ${String(role)}`); }
    const req = this.repo.getRequest(requestId);
    if (!req || req.projectId == null) throw new ProjectError('Không tìm thấy yêu cầu thuộc dự án.');
    const project = this.repo.getProject(req.projectId)!;
    const by = this.user(byId);
    this.require(by, 'task.assign', { project: { departmentId: project.departmentId } }, project, 'phân công người phụ trách');
    const ids = [...new Set(userIds)];
    if (!ids.length) throw new ProjectError(`Vai trò ${role} cần ít nhất một người phụ trách.`);
    for (const id of ids) {
      if (!this.repo.getProjectMember(project.id, id)?.roles.includes(role)) throw new ProjectError(`Người dùng #${id} không giữ vai trò ${role} trong dự án.`);
    }
    const before = this.repo.listRequestAssignees(requestId, role).map(a => a.userId);
    this.repo.tx(() => {
      this.repo.setRequestAssignees(requestId, role, ids);
      this.repo.web.addAudit({ projectId: project.id, requestId, userId: by.id, action: 'request.assignees.set', detail: JSON.stringify({ role, before, after: ids }) });
    });
  }

  // ---- requests ----

  /** Validates the request code against the project (format, uniqueness, git branch and worktree names). */
  async validateRequestCode(project: ProjectRow, code: string): Promise<void> {
    if (typeof code !== 'string' || !REQUEST_CODE_RE.test(code) || code === '.' || code === '..' || code.includes('..') || code.endsWith('.lock') || code.endsWith('.')) {
      throw new ProjectError('Mã yêu cầu chỉ gồm chữ, số, "." "_" "-" (1-40 ký tự), không chứa "..", không kết thúc bằng "." hoặc ".lock".');
    }
    const lower = code.toLowerCase();
    for (const r of this.repo.listRequestsByProject(project.id)) {
      const o = (r.code ?? '').toLowerCase();
      if (!o) continue;
      if (o === lower) throw new ProjectError(`Mã yêu cầu ${code} đã được dùng trong dự án.`);
      // devflow/<A>-<TASK> branches and worktrees of request A would collide with request <A>-<TASK>.
      if (lower.startsWith(`${o}-`) || o.startsWith(`${lower}-`)) throw new ProjectError(`Mã yêu cầu ${code} trùng tiền tố với ${r.code} (nhánh/worktree task sẽ đụng nhau).`);
    }
    const git = new Git(project.path, { mode: this.deps.cfg.mode });
    const branch = `devflow/${code}`;
    if (!(await git.isValidBranchName(branch))) throw new ProjectError(`Mã yêu cầu ${code} không tạo được tên nhánh git hợp lệ.`);
    if (await git.branchExistsAnywhere(branch)) throw new ProjectError(`Đã có nhánh ${branch} trong repo; hãy chọn mã khác.`);
  }

  async createRequest(input: CreateRequestInput): Promise<RequestRow> {
    const project = this.repo.getProject(input.projectId);
    if (!project) throw new ProjectError('Không tìm thấy dự án.');
    const by = this.user(input.by);
    this.require(by, 'request.create', { project: { departmentId: project.departmentId } }, project, 'tạo yêu cầu trong dự án này');
    if (project.archived) throw new ProjectError('Dự án đã lưu trữ.');
    if (!input.title.trim()) throw new ProjectError('Chưa nhập tiêu đề yêu cầu.');
    await this.validateRequestCode(project, input.code);

    // Every role the pipeline uses needs somebody, or the request would block at its first gate.
    const members = this.repo.listProjectMembers(project.id);
    const assign = new Map<ProjectRole, number[]>();
    for (const role of PROJECT_ROLES) {
      const given = input.assignees?.[role];
      const ids = given ? [...new Set(given)] : members.filter(m => m.roles.includes(role)).map(m => m.userId);
      if (!ids.length) throw new ProjectError(`Dự án chưa có thành viên nào giữ vai trò ${role}: hãy thêm trước khi tạo yêu cầu.`);
      for (const id of ids) {
        if (!members.find(m => m.userId === id)?.roles.includes(role)) throw new ProjectError(`Người dùng #${id} không giữ vai trò ${role} trong dự án.`);
      }
      assign.set(role, ids);
    }

    return this.repo.tx(() => {
      const row = this.repo.createRequest({
        title: input.title.trim(), description: input.description, perfReq: input.perfReq, nonfuncReq: input.nonfuncReq,
        projectKind: 'existing', gitlabProject: project.gitlabProject, softwareTypes: input.softwareTypes, runMode: input.runMode,
        createdBy: by.id, projectId: project.id, code: input.code,
      });
      for (const [role, ids] of assign) this.repo.setRequestAssignees(row.id, role, ids);
      this.repo.web.addAudit({ projectId: project.id, requestId: row.id, userId: by.id, action: 'request.create', detail: JSON.stringify({ code: input.code }) });
      return row;
    });
  }
}
