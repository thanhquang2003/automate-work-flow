import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Git } from '../../src/gitlab/git.js';

let root: string; let remote: string;
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-'));
  remote = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', remote, seed], { stdio: 'ignore' });
  writeFileSync(join(seed, 'README.md'), 'hi\n');
  g(seed, 'add', '-A');
  g(seed, '-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-m', 'init');
  g(seed, 'push', 'origin', 'HEAD:main');
});

describe('Git', () => {
  it('clone + branch + commit + push roundtrip', async () => {
    const dir = join(root, 'work');
    const git = new Git(dir, { protectedBranch: 'main' });
    await git.clone(remote, '', dir);
    expect(await git.hasRemote()).toBe(true);
    expect(await git.currentBranch()).toBe('main');
    await git.checkout('devflow/REQ-001', true, 'main');
    expect(await git.currentBranch()).toBe('devflow/REQ-001');
    writeFileSync(join(dir, 'a.txt'), 'a');
    expect(await git.commitAll('add a')).toBe(true);
    expect(await git.headSha()).toMatch(/^[0-9a-f]{40}$/);
    await git.push('devflow/REQ-001');
    expect(g(remote, 'rev-parse', 'devflow/REQ-001')).toBe(await git.headSha());
    await git.pull('devflow/REQ-001');
  });
  it('does not write token to .git/config', async () => {
    const dir = join(root, 'work2');
    const git = new Git(dir, { token: 'SECRETTOKEN' });
    await git.clone(remote, 'SECRETTOKEN', dir);
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toContain('SECRETTOKEN');
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
  });
  it('commitAll returns false when clean', async () => {
    const dir = join(root, 'work3');
    const git = new Git(dir);
    await git.clone(remote, '', dir);
    expect(await git.commitAll('nothing')).toBe(false);
  });
  it('push refuses protected branch', async () => {
    const dir = join(root, 'work4');
    const git = new Git(dir, { protectedBranch: 'main' });
    await git.clone(remote, '', dir);
    await expect(git.push('main')).rejects.toThrow(/protected/i);
  });
  it('uses configured author', async () => {
    const dir = join(root, 'work5');
    const git = new Git(dir, { authorName: 'Ann', authorEmail: 'ann@x.io' });
    await git.clone(remote, '', dir);
    writeFileSync(join(dir, 'b.txt'), 'b');
    await git.commitAll('b');
    expect(g(dir, 'log', '-1', '--format=%an <%ae> %cn')).toBe('Ann <ann@x.io> Ann');
  });
  it('rejects tricky push refs', async () => {
    const dir = join(root, 'work7');
    const git = new Git(dir, { protectedBranch: 'main' });
    await git.clone(remote, '', dir);
    for (const b of ['HEAD', 'refs/heads/main', '+main', 'x:main', '--force', '']) {
      await expect(git.push(b)).rejects.toThrow(/protected|invalid/i);
    }
  });
  it('defaults committer to DevFlow Bot when none configured', async () => {
    const dir = join(root, 'work6');
    const empty = join(root, 'empty.gitconfig');
    writeFileSync(empty, '');
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = empty; process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      const git = new Git(dir);
      await git.clone(remote, '', dir);
      writeFileSync(join(dir, 'c.txt'), 'c');
      await git.commitAll('c');
      expect(g(dir, 'log', '-1', '--format=%an <%ae> %cn')).toBe('DevFlow Bot <devflow@localhost> DevFlow Bot');
    } finally {
      if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
      if (saved.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.n;
    }
  });
});
