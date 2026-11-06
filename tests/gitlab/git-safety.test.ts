import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GIT_SERVER_ARGS, GIT_SUBMODULE_ARGS, Git, gitArgv } from '../../src/gitlab/git.js';
import { readFileSync } from 'node:fs';

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
  it('submodule recursion is off in both modes; hooks/fsmonitor are off only in server mode', () => {
    expect(GIT_SUBMODULE_ARGS).toEqual([
      '-c', 'diff.ignoreSubmodules=all', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false',
      '-c', 'push.recurseSubmodules=no', '-c', 'status.submoduleSummary=false',
    ]);
    expect(GIT_SERVER_ARGS).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0']);
    expect(gitArgv(['status', '--porcelain'], 'server')).toEqual([...GIT_SUBMODULE_ARGS, ...GIT_SERVER_ARGS, 'status', '--porcelain']);
    expect(gitArgv(['status', '--porcelain'], 'local')).toEqual([...GIT_SUBMODULE_ARGS, 'status', '--porcelain']);
  });

  function hookAndFsmonitor() {
    const { base, proj } = repo();
    const marker = join(base, 'hook-ran');
    const hook = join(proj, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    const fsm = join(base, 'fsmonitor.sh');
    const fsmMarker = join(base, 'fsmonitor-ran');
    writeFileSync(fsm, `#!/bin/sh\ntouch '${fsmMarker}'\n`);
    chmodSync(fsm, 0o755);
    g(proj, 'config', 'core.fsmonitor', fsm);
    return { proj, marker, fsmMarker };
  }

  it.runIf(posix)('server mode: repository hooks and fsmonitor commands never run', async () => {
    const { proj, marker, fsmMarker } = hookAndFsmonitor();
    const git = new Git(proj, { mode: 'server' });
    writeFileSync(join(proj, 'b.txt'), 'b\n');
    expect(await git.commitPaths(['b.txt'], 'add b')).toBe(true);
    await git.changedTracked();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(fsmMarker)).toBe(false);
  });

  it.runIf(posix)('local mode keeps v2 behaviour: the user\'s own hooks run', async () => {
    const { proj, marker } = hookAndFsmonitor();
    g(proj, 'config', '--unset', 'core.fsmonitor');
    const git = new Git(proj, { mode: 'local' });
    writeFileSync(join(proj, 'b.txt'), 'b\n');
    expect(await git.commitPaths(['b.txt'], 'add b')).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it('the default mode is server (fail safe)', () => {
    expect(new Git('/x').mode).toBe('server');
    expect(new Git('/x', { mode: 'local' }).mode).toBe('local');
  });

  it.runIf(posix)('a nested repo with a clean filter (gitlink in the index) never runs it', async () => {
    for (const mode of ['server', 'local'] as const) {
      const { base, proj } = repo();
      const marker = join(base, 'filter-ran');
      // Seat-made nested repository with its own config and attributes.
      const sub = join(proj, 'sub');
      mkdirSync(sub);
      g(sub, 'init', '-q', '-b', 'main');
      writeFileSync(join(sub, 'f.txt'), 'one\n');
      g(sub, 'add', '-A');
      g(sub, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '-q', '-m', 's');
      g(sub, 'config', 'filter.x.clean', `sh -c "touch '${marker}'; cat"`);
      mkdirSync(join(sub, '.git', 'info'), { recursive: true });
      writeFileSync(join(sub, '.git', 'info', 'attributes'), '* filter=x\n');
      g(proj, 'update-index', '--add', '--cacheinfo', `160000,${g(sub, 'rev-parse', 'HEAD')},sub`);
      g(proj, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'gitlink');
      writeFileSync(join(sub, 'f.txt'), 'two\n');
      // Sanity: plain git does recurse and runs the filter, so the test is meaningful.
      g(proj, 'status', '--porcelain');
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const warnings: string[] = [];
      const git = new Git(proj, { mode, onWarn: m => warnings.push(m) });
      const step = async (label: string, f: () => Promise<unknown>) => {
        await f();
        expect(existsSync(marker), `${mode}: filter ran during ${label}`).toBe(false);
      };
      await step('changedTracked (diff HEAD)', () => git.changedTracked());
      await step('untracked (ls-files)', () => git.untracked());
      writeFileSync(join(proj, 'c.txt'), 'c\n');
      await step('commitAll (add, diff --cached, commit)', () => git.commitAll('add c'));
      await step('isAncestor (merge-base)', () => git.isAncestor('main', 'main'));
      await step('checkout -b', () => git.checkout('side', true, 'main'));
      await step('checkout', () => git.checkout('main'));
      await step('merge --no-ff', () => git.merge('side', 'merge side'));
      writeFileSync(join(proj, 'd.txt'), 'd\n');
      await step('commitPaths over the whole tree', () => git.commitPaths(['.'], 'add d'));
      expect(g(proj, 'ls-files', '-s', 'sub').startsWith('160000')).toBe(true); // gitlink untouched, still recorded
      expect(warnings.some(w => w.includes('gitlink') && w.includes('sub'))).toBe(true);
      writeFileSync(join(proj, 'a.txt'), 'changed\n');
      await step('stashAll (status, stash)', async () => { expect(await git.stashAll('wip')).toBe(true); });
    }
  });

  it.runIf(posix)('.git/config is made non-group-writable after git rewrites it', async () => {
    const { proj } = repo();
    const cfg = join(proj, '.git', 'config');
    chmodSync(cfg, 0o664);
    await new Git(proj, { mode: 'server' }).addRemote('origin', 'https://example.invalid/x.git');
    expect(statSync(cfg).mode & 0o022).toBe(0);
    chmodSync(cfg, 0o664);
    await new Git(proj, { mode: 'local' }).addRemote('up', 'https://example.invalid/y.git');
    expect(statSync(cfg).mode & 0o020).not.toBe(0); // local mode leaves the user's file modes alone
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

describe.runIf(posix)('credentials and global config', () => {
  // A wrapper `git` first in PATH records, per call, the subcommand and the env DevFlow passes.
  function wrapGit(base: string): { log: string; restore: () => void } {
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const log = join(base, 'git-calls.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh
sub=""; for a in "$@"; do case "$a" in -c) skip=1; continue ;; esac; if [ -n "$skip" ]; then skip=""; continue; fi; sub="$a"; break; done
hdr=no; i=0; while [ $i -lt "\${GIT_CONFIG_COUNT:-0}" ]; do eval "k=\\$GIT_CONFIG_KEY_$i"; [ "$k" = http.extraHeader ] && hdr=yes; i=$((i+1)); done
echo "$sub hdr=$hdr global=\${GIT_CONFIG_GLOBAL:-unset} nosystem=\${GIT_CONFIG_NOSYSTEM:-unset}" >> '${log}'
exec '${real}' "$@"
`);
    chmodSync(join(bin, 'git'), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${bin}:${old}`;
    return { log, restore: () => { process.env.PATH = old; } };
  }

  it('the GitLab token goes only to network commands; server mode blanks system/global config', async () => {
    const { base, proj } = repo();
    const remote = join(base, 'remote.git');
    g(base, 'init', '-q', '--bare', '-b', 'main', remote);
    g(proj, 'remote', 'add', 'origin', remote);
    const w = wrapGit(base);
    try {
      const git = new Git(proj, { mode: 'server', token: 'tok-secret' });
      await git.currentBranch();
      await git.changedTracked();
      await git.push('main');
      await git.fetch();
      const local = new Git(proj, { mode: 'local', token: 'tok-secret' });
      await local.currentBranch();
    } finally { w.restore(); }
    const lines = readFileSync(w.log, 'utf8').trim().split('\n');
    for (const l of lines.filter(l => /^(rev-parse|diff|ls-files|config)\b/.test(l))) expect(l).toContain('hdr=no');
    for (const l of lines.filter(l => /^(push|fetch)\b/.test(l))) expect(l).toContain('hdr=yes');
    expect(lines.some(l => l.startsWith('push'))).toBe(true);
    const server = lines.slice(0, -1);
    for (const l of server) expect(l).toContain('global=/dev/null nosystem=1');
    expect(lines.at(-1)).toContain('global=unset nosystem=unset');
  });
});
