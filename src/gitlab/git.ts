import { execFile } from 'node:child_process';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface GitOpts {
  /** DEVFLOW_MODE of the caller (Config.mode). Default 'server', the safe side. */
  mode?: GitMode;
  /** Receives warnings (e.g. a skipped gitlink update); default console.warn. */
  onWarn?: (msg: string) => void;
  protectedBranch?: string;
  token?: string;
  authorName?: string;
  authorEmail?: string;
}

/**
 * Prepended to every git command DevFlow runs, in both modes: git never recurses into submodules or nested
 * repositories (a seat can stage a gitlink to a repo whose own config defines filters/commands).
 */
export const GIT_SUBMODULE_ARGS: readonly string[] = [
  '-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
  '-c', 'push.recurseSubmodules=no', '-c', 'status.submoduleSummary=false',
];
/**
 * Server mode only (seat trust boundary): repository hooks and fsmonitor never execute. Local mode keeps the
 * user's own hooks (git-lfs pre-push etc.), as in v2.
 */
export const GIT_SERVER_ARGS: readonly string[] = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0'];

/**
 * Server mode only: system and global git config are not read (filter/diff/merge drivers such as git-lfs
 * defined there would otherwise run on seat-written content and could see credentials).
 */
export const GIT_SERVER_ENV: Readonly<Record<string, string>> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };

/** Read-only content access: pathspecs are literal (no `:(magic)`/globs from user input), replace refs are ignored. */
const READ_ENV: Record<string, string> = { GIT_LITERAL_PATHSPECS: '1', GIT_NO_REPLACE_OBJECTS: '1' };

export type GitMode = 'local' | 'server';

export interface TreeEntry { mode: string; type: 'blob' | 'tree' | 'commit'; sha: string; size: number | null; path: string; name: string }

/** Full argv for one git invocation in `mode`. */
export function gitArgv(args: string[], mode: GitMode): string[] {
  return mode === 'server' ? [...GIT_SUBMODULE_ARGS, ...GIT_SERVER_ARGS, ...args] : [...GIT_SUBMODULE_ARGS, ...args];
}

/** A v3 request/task worktree: `<project>/.devflow/worktrees/<name>`. */
const WORKTREE_RE = /^(.*)[\\/]\.devflow[\\/]worktrees[\\/]([^\\/]+)$/;

/** Files git reads as configuration; kept owner-only even though DevFlow runs with umask 002. */
const CONFIG_FILES = ['config', join('info', 'exclude'), join('info', 'attributes')];

const DEFAULT_NAME = 'DevFlow Bot';
const DEFAULT_EMAIL = 'devflow@localhost';

/** Thin wrapper over the git CLI (execFile, no shell). The token is only ever sent via a per-command -c header. */
export class Git {
  readonly mode: GitMode;

  constructor(private cwd: string, private opts: GitOpts = {}) {
    this.mode = opts.mode ?? 'server';
  }

  /** Token goes via env (not argv, so it is not visible in process listings). */
  private authEnv(token?: string): Record<string, string> {
    const t = token ?? this.opts.token;
    if (!t) return {};
    const b64 = Buffer.from(`oauth2:${t}`).toString('base64');
    const n = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
    return {
      GIT_CONFIG_COUNT: String(n + 1),
      [`GIT_CONFIG_KEY_${n}`]: 'http.extraHeader',
      [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${b64}`,
    };
  }

  private checkRef(name: string): void {
    if (!name || name.startsWith('-') || name.startsWith('+') || name.includes(':') || name === 'HEAD' || /[\s\0]/.test(name)) {
      throw new Error(`Invalid branch/ref name: ${JSON.stringify(name)}`);
    }
  }

  /**
   * For a v3 worktree, git's location is pinned to the project's own repository: GIT_COMMON_DIR is
   * `<project>/.git` (owner-only config), and the worktree's `.git` file must point into
   * `<project>/.git/worktrees/`, whose `commondir` must lead back to `<project>/.git`. Seats can write inside
   * worktrees and `.git/worktrees/<n>/`, so a redirected `.git` file or `commondir` is refused, and config is
   * always read from GIT_COMMON_DIR (git 2.43 still reads refs through `commondir`, hence the check).
   */
  private async worktreePin(cwd: string): Promise<{ env: Record<string, string>; commonDir: string } | undefined> {
    const m = WORKTREE_RE.exec(resolve(cwd));
    if (!m) return undefined;
    const project = m[1]!;
    const commonDir = join(project, '.git');
    let text: string;
    try { text = await readFile(join(cwd, '.git'), 'utf8'); } catch {
      throw new Error(`DevFlow worktree ${cwd} has no readable .git file; refusing to run git there`);
    }
    const g = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
    const gitDir = g ? resolve(cwd, g) : '';
    const allowed = [join(commonDir, 'worktrees')];
    try { allowed.push(join(await realpath(commonDir), 'worktrees')); } catch { /* checked below */ }
    if (!gitDir || !allowed.includes(dirname(gitDir)) || !basename(gitDir) || basename(gitDir).startsWith('.')) {
      throw new Error(`DevFlow worktree ${cwd}: .git file does not point into the project repository; refusing to run git there`);
    }
    const st = await lstat(commonDir).catch(() => undefined);
    if (!st?.isDirectory()) throw new Error(`DevFlow worktree ${cwd}: project repository ${commonDir} missing`);
    const gst = await lstat(gitDir).catch(() => undefined);
    if (!gst?.isDirectory()) throw new Error(`DevFlow worktree ${cwd}: ${gitDir} is not a directory; refusing to run git there`);
    // The git dir must belong to THIS worktree: its gitdir back-pointer names our .git file (a seat could
    // otherwise point its worktree at another request's git dir in the same project).
    const back = (await readFile(join(gitDir, 'gitdir'), 'utf8').catch(() => '')).trim();
    if (!back || resolve(back) !== join(resolve(cwd), '.git')) {
      throw new Error(`DevFlow worktree ${cwd}: ${join(gitDir, 'gitdir')} does not point back to this worktree; refusing to run git there`);
    }
    // git still reads refs through <gitDir>/commondir, so it must lead back to the project repository.
    const cd = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
    const cdReal = cd ? await realpath(resolve(gitDir, cd)).catch(() => '') : '';
    if (!cdReal || cdReal !== await realpath(commonDir)) {
      throw new Error(`DevFlow worktree ${cwd}: ${join(gitDir, 'commondir')} does not lead to the project repository; refusing to run git there`);
    }
    return { env: { GIT_DIR: gitDir, GIT_COMMON_DIR: commonDir, GIT_WORK_TREE: resolve(cwd) }, commonDir };
  }

  /** Removes group/other write from git's config files (a rewrite under umask 002 would make them 0664). */
  private static async hardenConfig(commonDir: string | undefined): Promise<void> {
    if (!commonDir || process.platform === 'win32') return;
    const uid = process.getuid?.();
    for (const f of CONFIG_FILES) {
      const p = join(commonDir, f);
      try {
        const st = await lstat(p);
        if (st.isFile() && st.uid === uid && (st.mode & 0o022) !== 0) await chmod(p, st.mode & 0o7755);
      } catch { /* missing or not ours */ }
    }
  }

  private async commonDirOf(cwd: string): Promise<string | undefined> {
    const st = await lstat(join(cwd, '.git')).catch(() => undefined);
    return st?.isDirectory() ? join(cwd, '.git') : undefined;
  }

  private async exec(args: string[], o: { cwd?: string; env?: Record<string, string>; allowFail?: boolean } = {}): Promise<{ code: number; stdout: string }> {
    const cwd = o.cwd ?? this.cwd;
    const pin = o.cwd ? undefined : await this.worktreePin(cwd);
    const res = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      execFile('git', gitArgv(args, this.mode), {
        cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(this.mode === 'server' ? GIT_SERVER_ENV : {}), ...pin?.env, ...o.env },
      }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout) });
        if (o.allowFail) return resolve({ code: typeof (err as any).code === 'number' ? (err as any).code : 1, stdout: String(stdout) });
        // Never leak the token in error text.
        const safe = (s: string) => s.replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***');
        reject(new Error(`git ${safe(args.join(' '))} failed: ${safe(String(stderr || err.message)).trim()}`));
      });
    }).finally(async () => {
      if (this.mode === 'server') await Git.hardenConfig(pin?.commonDir ?? (o.cwd ? undefined : await this.commonDirOf(cwd)));
    });
    return res;
  }

  /** Local git command: never gets the GitLab credential. */
  private async run(args: string[]): Promise<string> {
    return (await this.exec(args)).stdout;
  }

  /** Network command (fetch, pull, push): the only ones that get the credential header. */
  private async net(args: string[]): Promise<string> {
    return (await this.exec(args, { env: this.authEnv() })).stdout;
  }

  async clone(url: string, token: string, dir: string): Promise<void> {
    await this.exec(['clone', '--', url, dir], { cwd: process.cwd(), env: this.authEnv(token || undefined) });
    if (this.mode === 'server') await Git.hardenConfig(await this.commonDirOf(resolve(process.cwd(), dir)));
  }

  /** `git init` in the working directory with the given initial branch. */
  async init(initialBranch: string): Promise<void> {
    this.checkRef(initialBranch);
    await this.exec(['init', '-b', initialBranch]);
  }

  async checkout(branch: string, create = false, from?: string): Promise<void> {
    this.checkRef(branch);
    if (from) this.checkRef(from);
    if (create) await this.run(['checkout', '-b', branch, ...(from ? [from] : [])]);
    else await this.run(['checkout', branch]);
  }

  /**
   * Pathspecs excluding every gitlink (submodule / nested repository) already in the index. `git add -A` and
   * `git stash -u` ignore diff.ignoreSubmodules and run `git status` inside such a repository, which would
   * apply that repository's own (seat-controlled) filters as DevFlow. So pointer updates of tracked gitlinks
   * are never staged (a warning names them). An UNTRACKED nested repository is still added by `add -A` as a
   * new gitlink (git records its HEAD without running anything inside it).
   */
  private async gitlinkExcludes(): Promise<string[]> {
    const out = await this.run(['ls-files', '--stage', '-z']);
    const res: string[] = [];
    for (const entry of out.split('\0')) {
      if (!entry.startsWith('160000 ')) continue;
      const tab = entry.indexOf('\t');
      if (tab > 0) res.push(`:(top,exclude,literal)${entry.slice(tab + 1)}`);
    }
    if (res.length) {
      const paths = res.map(r => r.slice(':(top,exclude,literal)'.length)).join(', ');
      (this.opts.onWarn ?? console.warn)(`DevFlow không stage gitlink (submodule/repo lồng nhau): ${paths}; thay đổi con trỏ của chúng (nếu có) bị bỏ qua.`);
    }
    return res;
  }

  private async identityArgs(): Promise<string[]> {
    const name = this.opts.authorName ?? ((await this.exec(['config', 'user.name'], { allowFail: true })).stdout.trim() || DEFAULT_NAME);
    const email = this.opts.authorEmail ?? ((await this.exec(['config', 'user.email'], { allowFail: true })).stdout.trim() || DEFAULT_EMAIL);
    return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
  }

  /**
   * Stages everything and commits. `exclude` (repo-relative paths, e.g. untracked build outputs that existed before
   * Claude ran) is unstaged again so it never lands in the commit. Returns false when nothing is staged.
   */
  async commitAll(msg: string, exclude: string[] = []): Promise<boolean> {
    await this.run(['add', '-A', '--', ':(top)', ...(await this.gitlinkExcludes())]);
    if (exclude.length) {
      // Via a pathspec file: the list can be long (argv limits on Windows).
      const dir = await mkdtemp(join(tmpdir(), 'devflow-git-'));
      const file = join(dir, 'exclude');
      try {
        await writeFile(file, exclude.join('\0'), 'utf8');
        await this.run(['reset', '-q', `--pathspec-from-file=${file}`, '--pathspec-file-nul']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const staged = await this.exec(['diff', '--cached', '--quiet'], { allowFail: true });
    if (staged.code === 0) return false;
    await this.run([...(await this.identityArgs()), 'commit', '-m', msg]);
    return true;
  }

  /**
   * Stashes every uncommitted change, untracked (not ignored) files included, under `msg`.
   * Returns false (and does nothing) when the working tree is clean.
   */
  async stashAll(msg: string): Promise<boolean> {
    if (!(await this.run(['status', '--porcelain'])).trim()) return false;
    await this.run([...(await this.identityArgs()), 'stash', 'push', '-u', '-m', msg, '--', ':(top)', ...(await this.gitlinkExcludes())]);
    return true;
  }

  /** Untracked, not ignored files (repo-relative, forward slashes). */
  async untracked(): Promise<string[]> {
    const out = await this.run(['ls-files', '--others', '--exclude-standard', '-z']);
    return out.split('\0').filter(Boolean);
  }

  /** Tracked paths that differ from HEAD (worktree or index; additions, changes, deletions; renames split). */
  async changedTracked(): Promise<string[]> {
    const out = await this.run(['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']);
    return out.split('\0').filter(Boolean);
  }

  /** Puts the given repo-relative paths back to HEAD, in the index and the worktree. */
  async restore(paths: string[]): Promise<void> {
    if (!paths.length) return;
    for (const p of paths) if (!p || p.startsWith('-')) throw new Error(`Invalid path: ${JSON.stringify(p)}`);
    await this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]);
  }

  async branchExists(branch: string): Promise<boolean> {
    this.checkRef(branch);
    return (await this.exec(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
  }

  /** Creates or resets `branch` to `from` and checks it out (`checkout -B`). */
  async resetBranch(branch: string, from: string): Promise<void> {
    this.checkRef(branch);
    this.checkRef(from);
    await this.run(['checkout', '-B', branch, from]);
  }

  /** Number of commits on `branch` that are not on `base`. */
  async aheadCount(base: string, branch: string): Promise<number> {
    this.checkRef(base);
    this.checkRef(branch);
    return Number.parseInt((await this.run(['rev-list', '--count', `${base}..${branch}`])).trim(), 10) || 0;
  }

  /** Merges `branch` into the current branch with a merge commit (`--no-ff`). Aborts and throws on conflict. */
  async merge(branch: string, msg: string): Promise<void> {
    this.checkRef(branch);
    try {
      await this.run([...(await this.identityArgs()), 'merge', '--no-ff', '-m', msg, '--', branch]);
    } catch (e) {
      await this.exec(['merge', '--abort'], { allowFail: true });
      throw e;
    }
  }

  /**
   * Stages only the given repo-relative paths (additions, changes, deletions) and commits them alone.
   * Returns false when nothing under those paths changed.
   */
  async commitPaths(paths: string[], msg: string): Promise<boolean> {
    if (!paths.length) return false;
    for (const p of paths) if (!p || p.startsWith('-')) throw new Error(`Invalid path: ${JSON.stringify(p)}`);
    await this.run(['add', '-A', '--', ...paths, ...(await this.gitlinkExcludes())]);
    const staged = await this.exec(['diff', '--cached', '--quiet', '--', ...paths], { allowFail: true });
    if (staged.code === 0) return false;
    await this.run([...(await this.identityArgs()), 'commit', '-m', msg, '--', ...paths]);
    return true;
  }

  async push(branch: string): Promise<void> {
    this.checkRef(branch);
    const norm = branch.replace(/^refs\/heads\//, '');
    if (this.opts.protectedBranch && norm === this.opts.protectedBranch.replace(/^refs\/heads\//, '')) {
      throw new Error(`Refusing to push to protected branch "${branch}"`);
    }
    await this.net(['push', '-u', 'origin', '--', branch]);
  }

  async pull(branch: string): Promise<void> {
    this.checkRef(branch);
    await this.net([...(await this.identityArgs()), 'pull', '--no-rebase', 'origin', branch]);
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  async headSha(): Promise<string> {
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  // ---- project layout (v3): worktrees, local exclude, remotes ----

  /** True when `name` is a valid branch name according to `git check-ref-format --branch`. */
  async isValidBranchName(name: string): Promise<boolean> {
    if (!name || name.startsWith('-') || /[\s\0]/.test(name)) return false;
    return (await this.exec(['check-ref-format', '--branch', name], { allowFail: true })).code === 0;
  }

  /** True when the ref exists locally (refs/heads) or as a remote-tracking branch of origin. */
  async branchExistsAnywhere(branch: string): Promise<boolean> {
    this.checkRef(branch);
    if (await this.branchExists(branch)) return true;
    return (await this.exec(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { allowFail: true })).code === 0;
  }

  async hasCommits(): Promise<boolean> {
    return (await this.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code === 0;
  }

  /** True when `ancestor` is reachable from `descendant`. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    this.checkRef(ancestor);
    this.checkRef(descendant);
    return (await this.exec(['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true })).code === 0;
  }

  async refExists(ref: string): Promise<boolean> {
    this.checkRef(ref);
    return (await this.exec(['rev-parse', '--verify', '--quiet', ref], { allowFail: true })).code === 0;
  }

  async fetch(): Promise<void> {
    await this.net(['fetch', '--quiet', 'origin']);
  }

  async addRemote(name: string, url: string): Promise<void> {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid remote name: ${name}`);
    await this.exec(['remote', 'add', name, '--', url]);
  }

  /**
   * `git worktree add`: checks out `branch` in `path`. When the branch does not exist it is created from `base`
   * (required then); an existing branch is reused as is.
   */
  async worktreeAdd(path: string, branch: string, base?: string): Promise<void> {
    this.checkRef(branch);
    if (await this.branchExists(branch)) {
      await this.run(['worktree', 'add', '--', path, branch]);
      return;
    }
    if (!base) throw new Error(`Branch ${branch} does not exist and no base was given`);
    this.checkRef(base);
    await this.run(['worktree', 'add', '-b', branch, '--', path, base]);
  }

  /** Removes a linked worktree (refuses when it has local changes unless `force`). The branch is kept. */
  async worktreeRemove(path: string, force = false): Promise<void> {
    await this.run(['worktree', 'remove', ...(force ? ['--force'] : []), '--', path]);
  }

  async worktreeList(): Promise<{ path: string; branch: string | null; head: string }[]> {
    const out = await this.run(['worktree', 'list', '--porcelain']);
    const res: { path: string; branch: string | null; head: string }[] = [];
    for (const block of out.split(/\n\n+/)) {
      const lines = block.split('\n').filter(Boolean);
      const wt = lines.find(l => l.startsWith('worktree '));
      if (!wt) continue;
      const br = lines.find(l => l.startsWith('branch '));
      res.push({
        path: wt.slice(9), head: (lines.find(l => l.startsWith('HEAD ')) ?? '').slice(5),
        branch: br ? br.slice(7).replace(/^refs\/heads\//, '') : null,
      });
    }
    return res;
  }

  /** Adds `entry` to the repository's local `.git/info/exclude` (shared by all worktrees) when missing. */
  async excludeLocal(entry: string): Promise<void> {
    if (!entry || /[\r\n\0]/.test(entry)) throw new Error(`Invalid exclude entry: ${JSON.stringify(entry)}`);
    const rel = (await this.run(['rev-parse', '--git-path', 'info/exclude'])).trim();
    const file = resolve(this.cwd, rel);
    const cur = await readFile(file, 'utf8').catch(() => '');
    if (cur.split(/\r?\n/).some(l => l.trim() === entry)) return;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${entry}\n`, 'utf8');
    if (this.mode === 'server') await Git.hardenConfig(dirname(dirname(file)));
  }

  // ---- read-only content access (oversight views): git plumbing only, nothing is checked out or followed ----

  /**
   * Commit id of local branch `branch`, or undefined. The name is validated (plain ref characters, no `..`,
   * `check-ref-format`) and resolved as `refs/heads/<name>` only: no sha, no revision syntax, no `@{...}`.
   */
  async branchCommit(branch: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(branch) || branch.startsWith('-') || branch.startsWith('/') || branch.includes('..')) return undefined;
    if ((await this.exec(['check-ref-format', `refs/heads/${branch}`], { allowFail: true })).code !== 0) return undefined;
    const r = await this.exec(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { allowFail: true });
    const sha = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  }

  private static parseTree(out: string): TreeEntry[] {
    const res: TreeEntry[] = [];
    for (const rec of out.split('\0')) {
      const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(rec);
      if (!m) continue;
      res.push({ mode: m[1]!, type: m[2] as TreeEntry['type'], sha: m[3]!, size: m[4] === '-' ? null : Number(m[4]), path: m[5]!, name: m[5]!.slice(m[5]!.lastIndexOf('/') + 1) });
    }
    return res;
  }

  /** The tree entry at `path` (components already validated by the caller) in `commit`, or undefined. */
  async treeEntry(commit: string, path: string): Promise<TreeEntry | undefined> {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Invalid commit id');
    if (!path) return { mode: '040000', type: 'tree', sha: commit, size: null, path: '', name: '' };
    return Git.parseTree((await this.exec(['ls-tree', '-z', '-l', commit, '--', path], { env: READ_ENV })).stdout)[0];
  }

  /** Entries directly inside the directory `path` ('' = root) of `commit`. Gitlinks and symlinks are only listed. */
  async listTree(commit: string, path: string): Promise<TreeEntry[]> {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Invalid commit id');
    const args = ['ls-tree', '-z', '-l', commit, ...(path ? ['--', `${path}/`] : [])];
    return Git.parseTree((await this.exec(args, { env: READ_ENV })).stdout);
  }

  /** Text of a blob (the caller checked its size). For a symlink entry this is the link target text. */
  async blobText(sha: string): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('Invalid object id');
    return (await this.exec(['cat-file', 'blob', sha], { env: READ_ENV })).stdout;
  }

  async hasRemote(): Promise<boolean> {
    const r = await this.exec(['remote'], { allowFail: true });
    return r.code === 0 && r.stdout.split(/\r?\n/).includes('origin');
  }
}
