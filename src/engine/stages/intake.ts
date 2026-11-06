import { safeMkdirp, safeReadFile, safeWriteFile, UnsafePathError } from '../safe-fs.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { GitLabError, type GlProject } from '../../gitlab/client.js';
import { gitlabToken, type StageContext, type StageOutcome } from '../pipeline.js';
import { Git } from '../../gitlab/git.js';
import { ensureOnBranch, integrationBranch, writeProjectInfo, type ProjectInfo } from './common.js';

/**
 * The one name an uploaded attachment gets in inputs/ (web upload AND the INTAKE/CHANGE copy use it, so both sides
 * agree and the stage never re-copies a file it already has): last path component, only [\w.\- ()À-ỹ], trimmed, no
 * leading dot, no trailing dot/space, Windows reserved names suffixed with "_", never empty. Idempotent.
 */
export function attachmentName(raw: string): string {
  let b = raw.replace(/^.*[\\/]/, '').replace(/[^\w.\- ()À-ỹ]/g, '_').trim().replace(/[. ]+$/, '').replace(/^\.+/, '_');
  if (!b) return 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(b.replace(/\..*$/, '')) && !b.endsWith('_')) b = `${b}_`;
  return b;
}

/** Same as attachmentName (older name). */
export const safeFileName = attachmentName;

/** "a.txt" → "a-2.txt", "a-3.txt"… until the (case-insensitive) name is unused. */
export function uniqueName(name: string, used: Set<string>): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let out = name;
  for (let i = 2; used.has(out.toLowerCase()); i++) out = `${stem}-${i}${ext}`;
  used.add(out.toLowerCase());
  return out;
}

/**
 * Reads a stored attachment for copying into inputs/: through safe-fs (inputs/ is seat-writable, a seat could swap
 * the stored file for a link), undefined (logged) when missing or unsafe.
 */
export function readAttachment(ctx: Pick<StageContext, 'log'>, path: string, label: string): Buffer | undefined {
  try {
    return safeReadFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') { ctx.log(`Không tìm thấy file đính kèm ${label}`, 'warn'); return undefined; }
    if (e instanceof UnsafePathError) { ctx.log(`Bỏ qua file đính kèm ${label}: ${e.message}`, 'warn'); return undefined; }
    throw e;
  }
}

export function copyAttachments(ctx: StageContext): number {
  safeMkdirp(ctx.ws.inputsDir, ctx.ws.trustRoot);
  let n = 0;
  const used = new Set<string>();
  for (const a of ctx.repo.listAttachments(ctx.req.id)) {
    const name = uniqueName(attachmentName(a.filename), used);
    const dest = join(ctx.ws.inputsDir, name);
    if (resolve(a.path) === resolve(dest)) { n++; continue; }
    const data = readAttachment(ctx, a.path, a.filename);
    if (!data) continue;
    safeWriteFile(dest, data, ctx.ws.trustRoot);
    n++;
  }
  return n;
}

/** Full GitLab path for a new project name (prefixed with the default group unless already a path). */
function newProjectPath(ctx: StageContext, name: string): string {
  if (name.includes('/')) return name;
  return ctx.cfg.gitlab.defaultGroup ? `${ctx.cfg.gitlab.defaultGroup}/${name}` : name;
}

async function initLocal(ctx: StageContext, branch: string, why: string): Promise<StageOutcome> {
  await ctx.git.init(branch);
  // One initial commit so HEAD, task branches and the scan cache have a base.
  const readme = join(ctx.ws.repoDir, 'README.md');
  if (!existsSync(readme)) writeFileSync(readme, `# ${ctx.req.title}\n`, 'utf8');
  await ctx.git.commitPaths(['README.md'], 'chore: khởi tạo dự án');
  writeProjectInfo(ctx.ws, { gitlab: false, branch });
  ctx.log(`${why} Khởi tạo repo git cục bộ trên nhánh ${branch}; tài liệu và code sẽ chỉ nằm trên máy này.`, 'warn');
  return { kind: 'next' };
}

/** Clones the project and checks out devflow/<REQ>, creating it on GitLab from the default branch. */
async function cloneProject(ctx: StageContext, p: GlProject, branch: string): Promise<void> {
  const gitlab = ctx.gitlab!;
  const empty = (p as GlProject & { empty_repo?: boolean }).empty_repo === true || !p.default_branch;
  if (!empty) await gitlab.createBranch(p.id, branch, p.default_branch);
  // Same credential as the API calls above (creator's own token when set), else the shared token.
  await ctx.git.clone(p.http_url_to_repo, gitlabToken(gitlab) || ctx.cfg.gitlab.token, ctx.ws.repoDir);
  if (!empty) {
    await ctx.git.checkout(branch);
  } else {
    // Empty project (new): seed the default branch with one commit so the final MR has a target.
    const def = p.default_branch || 'main';
    await ctx.git.checkout(def, true);
    writeFileSync(join(ctx.ws.repoDir, 'README.md'), `# ${ctx.req.title}\n`, 'utf8');
    await ctx.git.commitPaths(['README.md'], 'chore: khởi tạo dự án');
    await ctx.git.push(def);
    p = { ...p, default_branch: def };
    await ctx.git.checkout(branch, true);
    await ctx.git.push(branch);
  }
  writeProjectInfo(ctx.ws, {
    gitlab: true, projectId: p.id, pathWithNamespace: p.path_with_namespace, defaultBranch: p.default_branch,
    webUrl: (p as GlProject & { web_url?: string }).web_url, branch,
  });
}

/**
 * Project-rooted request: the project already holds the repo, so INTAKE only adds the request worktree
 * `.devflow/worktrees/<code>` on branch `devflow/<code>`, cut from the project's default branch.
 */
async function intakeProject(ctx: StageContext): Promise<StageOutcome> {
  const { req, ws } = ctx;
  const project = ctx.repo.getProject(req.projectId!);
  if (!project) return { kind: 'fail', error: `Không tìm thấy dự án #${req.projectId}` };
  const branch = integrationBranch(ws.key);
  const n = copyAttachments(ctx);
  if (n) ctx.log(`Đã chép ${n} file đính kèm vào ${ws.inputsDir}`);

  if (existsSync(join(ws.repoDir, '.git'))) {
    await ensureOnBranch(ctx, branch);
    ctx.log(`Worktree đã có sẵn, dùng nhánh ${branch}`);
    return { kind: 'next' };
  }
  const pg = new Git(project.path, { mode: ctx.cfg.mode, token: gitlabToken(ctx.gitlab) || ctx.cfg.gitlab.token || undefined });
  await pg.excludeLocal('.devflow/');
  if (await pg.hasRemote()) {
    try { await pg.fetch(); } catch (e) { ctx.log(`Không fetch được origin (${(e as Error).message}); dùng bản cục bộ.`, 'warn'); }
  }
  const def = project.defaultBranch;
  let base = def;
  if (!(await pg.branchExists(def))) {
    if (await pg.refExists(`origin/${def}`)) base = `origin/${def}`;
    else return { kind: 'fail', error: `Dự án không có nhánh mặc định "${def}".` };
  } else if (await pg.refExists(`origin/${def}`) && await pg.isAncestor(def, `origin/${def}`)) {
    base = `origin/${def}`; // remote is ahead: start from the newest code
  }
  mkdirSync(join(ws.repoDir, '..'), { recursive: true });
  await pg.worktreeAdd(ws.repoDir, branch, base);

  let info: ProjectInfo = { gitlab: false, defaultBranch: def, branch };
  if (project.gitlabProject && ctx.gitlab) {
    try {
      const p = await ctx.gitlab.getProject(project.gitlabProject);
      info = { gitlab: true, projectId: p.id, pathWithNamespace: p.path_with_namespace, defaultBranch: def, webUrl: (p as GlProject & { web_url?: string }).web_url, branch };
    } catch (e) {
      ctx.log(`Không truy cập được GitLab project "${project.gitlabProject}": ${(e as Error).message}. Chạy ở chế độ cục bộ.`, 'warn');
    }
  }
  writeProjectInfo(ws, info);
  ctx.log(`Đã tạo worktree ${ws.repoDir} trên nhánh ${branch} (tách từ ${base})`);
  return { kind: 'next' };
}

export async function intake(ctx: StageContext): Promise<StageOutcome> {
  const { req, ws } = ctx;
  if (ws.isProjectRooted) return intakeProject(ctx);
  const branch = integrationBranch(ctx.ws.key);
  const n = copyAttachments(ctx);
  if (n) ctx.log(`Đã chép ${n} file đính kèm vào ${ws.inputsDir}`);

  if (existsSync(join(ws.repoDir, '.git'))) {
    await ensureOnBranch(ctx, branch);
    ctx.log(`Repo đã có sẵn trong workspace, dùng nhánh ${branch}`);
    return { kind: 'next' };
  }

  const gitlab = ctx.gitlab;
  if (req.projectKind === 'existing') {
    if (!gitlab) return { kind: 'fail', error: 'Dự án có sẵn cần kết nối GitLab để lấy mã nguồn, nhưng chưa cấu hình GitLab (GITLAB_URL và GITLAB_TOKEN, hoặc token của người dùng). Hãy cấu hình GitLab trong trang Cài đặt rồi chạy lại.' };
    if (!req.gitlabProject) return { kind: 'fail', error: 'Chưa chọn GitLab project cho dự án có sẵn.' };
    let p: GlProject;
    try {
      p = await gitlab.getProject(req.gitlabProject);
    } catch (e) {
      const msg = e instanceof GitLabError && e.status === 404 ? 'không tồn tại hoặc token không có quyền truy cập' : (e as Error).message;
      return { kind: 'fail', error: `Không truy cập được GitLab project "${req.gitlabProject}": ${msg}` };
    }
    if (!p.default_branch || (p as GlProject & { empty_repo?: boolean }).empty_repo) return { kind: 'fail', error: `GitLab project "${req.gitlabProject}" là repo rỗng. Hãy chọn loại dự án "mới".` };
    await cloneProject(ctx, p, branch);
    ctx.log(`Đã clone ${p.path_with_namespace} và chuyển sang nhánh ${branch} (tách từ ${p.default_branch})`);
    return { kind: 'next' };
  }

  // new project
  if (!gitlab) return initLocal(ctx, branch, 'Chưa cấu hình GitLab.');
  if (!req.gitlabProject) return initLocal(ctx, branch, 'Chưa đặt tên GitLab project.');
  const path = newProjectPath(ctx, req.gitlabProject);
  let p: GlProject | undefined;
  try {
    p = await gitlab.getProject(path);
  } catch (e) {
    if (!(e instanceof GitLabError && e.status === 404)) throw e;
  }
  if (!p) {
    const name = path.split('/').pop()!;
    const group = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const ns = group ? await gitlab.findGroupId(group) : undefined;
    if (group && ns === undefined) return { kind: 'fail', error: `Không tìm thấy GitLab group "${group}" để tạo project mới.` };
    p = await gitlab.createProject(name, ns);
    ctx.log(`Đã tạo GitLab project ${p.path_with_namespace}`);
  } else if (p.default_branch && !(p as GlProject & { empty_repo?: boolean }).empty_repo) {
    return { kind: 'fail', error: `GitLab project "${p.path_with_namespace}": Dự án đã có mã nguồn, hãy chọn loại 'Dự án có sẵn'.` };
  }
  await cloneProject(ctx, p, branch);
  ctx.log(`Repo ${p.path_with_namespace} sẵn sàng trên nhánh ${branch}`);
  return { kind: 'next' };
}
