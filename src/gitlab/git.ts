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

  private authArgs(token?: string): string[] {
    const t = token ?? this.opts.token;
    if (!t) return [];
    const b64 = Buffer.from(`oauth2:${t}`).toString('base64');
    return ['-c', `http.extraHeader=Authorization: Basic ${b64}`];
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
        reject(new Error(`git ${safe(args.filter(a => !a.startsWith('http.extraHeader')).join(' '))} failed: ${safe(String(stderr || err.message)).trim()}`));
      });
    });
  }

  private async run(args: string[], token?: string): Promise<string> {
    return (await this.exec([...this.authArgs(token), ...args])).stdout;
  }

  async clone(url: string, token: string, dir: string): Promise<void> {
    await this.exec([...this.authArgs(token || undefined), 'clone', url, dir], { cwd: process.cwd() });
  }

  async checkout(branch: string, create = false, from?: string): Promise<void> {
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

  async push(branch: string): Promise<void> {
    if (this.opts.protectedBranch && branch === this.opts.protectedBranch) {
      throw new Error(`Refusing to push to protected branch "${branch}"`);
    }
    await this.run(['push', '-u', 'origin', branch]);
  }

  async pull(branch: string): Promise<void> {
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
