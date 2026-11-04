import { execFile } from 'node:child_process';

export interface GitOpts {
  protectedBranch?: string;
  token?: string;
  authorName?: string;
  authorEmail?: string;
}

const DEFAULT_NAME = 'DevFlow Bot';
const DEFAULT_EMAIL = 'devflow@localhost';

/** Thin wrapper over the git CLI (execFile, no shell). The token is only ever sent via a per-command -c header. */
export class Git {
  constructor(private cwd: string, private opts: GitOpts = {}) {}

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

  private exec(args: string[], o: { cwd?: string; env?: Record<string, string>; allowFail?: boolean } = {}): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd: o.cwd ?? this.cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...o.env },
      }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout) });
        if (o.allowFail) return resolve({ code: typeof (err as any).code === 'number' ? (err as any).code : 1, stdout: String(stdout) });
        // Never leak the token in error text.
        const safe = (s: string) => s.replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***');
        reject(new Error(`git ${safe(args.join(' '))} failed: ${safe(String(stderr || err.message)).trim()}`));
      });
    });
  }

  private async run(args: string[], token?: string): Promise<string> {
    return (await this.exec(args, { env: this.authEnv(token) })).stdout;
  }

  async clone(url: string, token: string, dir: string): Promise<void> {
    await this.exec(['clone', '--', url, dir], { cwd: process.cwd(), env: this.authEnv(token || undefined) });
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

  private async identityArgs(): Promise<string[]> {
    const name = this.opts.authorName ?? ((await this.exec(['config', 'user.name'], { allowFail: true })).stdout.trim() || DEFAULT_NAME);
    const email = this.opts.authorEmail ?? ((await this.exec(['config', 'user.email'], { allowFail: true })).stdout.trim() || DEFAULT_EMAIL);
    return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
  }

  async commitAll(msg: string): Promise<boolean> {
    await this.run(['add', '-A']);
    const st = await this.run(['status', '--porcelain']);
    if (!st.trim()) return false;
    await this.run([...(await this.identityArgs()), 'commit', '-m', msg]);
    return true;
  }

  /**
   * Stages only the given repo-relative paths (additions, changes, deletions) and commits them alone.
   * Returns false when nothing under those paths changed.
   */
  async commitPaths(paths: string[], msg: string): Promise<boolean> {
    if (!paths.length) return false;
    for (const p of paths) if (!p || p.startsWith('-')) throw new Error(`Invalid path: ${JSON.stringify(p)}`);
    await this.run(['add', '-A', '--', ...paths]);
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
    await this.run(['push', '-u', 'origin', '--', branch]);
  }

  async pull(branch: string): Promise<void> {
    this.checkRef(branch);
    await this.run(['pull', '--no-rebase', 'origin', branch]);
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  async headSha(): Promise<string> {
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  async hasRemote(): Promise<boolean> {
    const r = await this.exec(['remote'], { allowFail: true });
    return r.code === 0 && r.stdout.split(/\r?\n/).includes('origin');
  }
}
