import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GIT_SAFETY_ARGS, Git, gitArgv } from '../../src/gitlab/git.js';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const posix = process.platform !== 'win32';

function repo(): { base: string; proj: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'git-safe-')));
  const proj = join(base, 'proj');
  mkdirSync(proj);
  g(proj, 'init', '-q', '-b', 'main');
  writeFileSync(join(proj, 'a.txt'), 'a\n');
  g(proj, 'add', '-A');
  g(proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return { base, proj };
}

describe('git safety flags', () => {
  it('every git invocation disables hooks and fsmonitor', () => {
    expect(GIT_SAFETY_ARGS).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
    expect(gitArgv(['status', '--porcelain'])).toEqual([...GIT_SAFETY_ARGS, 'status', '--porcelain']);
  });

  it.runIf(posix)('repository hooks and fsmonitor commands never run', async () => {
    const { base, proj } = repo();
    const marker = join(base, 'pwned');
    const hook = join(proj, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    const fsm = join(base, 'fsmonitor.sh');
    writeFileSync(fsm, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(fsm, 0o755);
    g(proj, 'config', 'core.fsmonitor', fsm);
    const git = new Git(proj);
    writeFileSync(join(proj, 'b.txt'), 'b\n');
    expect(await git.commitPaths(['b.txt'], 'add b')).toBe(true);
    await git.changedTracked();
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(posix)('.git/config is made non-group-writable after git rewrites it', async () => {
    const { proj } = repo();
    const cfg = join(proj, '.git', 'config');
    chmodSync(cfg, 0o664);
    await new Git(proj).addRemote('origin', 'https://example.invalid/x.git');
    expect(statSync(cfg).mode & 0o022).toBe(0);
  });
});

describe.runIf(posix)('worktree pinning', () => {
  async function withWorktree() {
    const { base, proj } = repo();
    const wt = join(proj, '.devflow', 'worktrees', 'R1');
    mkdirSync(join(proj, '.devflow', 'worktrees'), { recursive: true });
    await new Git(proj).worktreeAdd(wt, 'devflow/R1', 'main');
    return { base, proj, wt };
  }

  it('a redirected commondir (seat-writable .git/worktrees/<n>) is refused', async () => {
    const { base, proj, wt } = await withWorktree();
    const real = g(proj, 'rev-parse', 'main');
    // Attacker repository with its own config and history.
    const evil = join(base, 'evil');
    mkdirSync(evil);
    g(evil, 'init', '-q', '-b', 'devflow/R1');
    writeFileSync(join(evil, 'x'), 'x');
    g(evil, 'add', '-A');
    g(evil, '-c', 'user.name=e', '-c', 'user.email=e@e', 'commit', '-q', '-m', 'evil');
    expect(await new Git(wt).headSha()).toBe(real);
    writeFileSync(join(proj, '.git', 'worktrees', 'R1', 'commondir'), `${join(evil, '.git')}\n`);
    await expect(new Git(wt).headSha()).rejects.toThrow(/commondir/);
  });

  it('a worktree .git file pointing outside the project repo is refused', async () => {
    const { base, wt } = await withWorktree();
    writeFileSync(join(wt, '.git'), `gitdir: ${join(base, 'elsewhere')}\n`);
    await expect(new Git(wt).headSha()).rejects.toThrow(/worktree/i);
  });

  it('a missing worktree .git file is refused instead of falling back to the project repo', async () => {
    const { wt } = await withWorktree();
    execFileSync('rm', ['-f', join(wt, '.git')]);
    await expect(new Git(wt).currentBranch()).rejects.toThrow(/worktree/i);
  });

  it('normal worktree operations still work', async () => {
    const { wt } = await withWorktree();
    const git = new Git(wt);
    expect(await git.currentBranch()).toBe('devflow/R1');
    writeFileSync(join(wt, 'c.txt'), 'c\n');
    expect(await git.commitAll('add c')).toBe(true);
  });
});
