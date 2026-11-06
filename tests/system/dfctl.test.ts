import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only the argument-validation side of dfctl can run here (no root, not the VPS). Never call a real
// subcommand as root from a test: it would create OS users and groups.
const DFCTL = fileURLToPath(new URL('../../ops/dfctl', import.meta.url));
const hasBash = spawnSync('bash', ['--version']).status === 0;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function dfctl(...args: string[]) {
  return spawnSync('bash', [DFCTL, ...args], { encoding: 'utf8', timeout: 50_000 });
}

describe.skipIf(!hasBash)('dfctl', () => {
  it('passes its own --self-test (bad user id, cwd outside project, arg injection, empty args)', () => {
    const r = dfctl('--self-test');
    expect(r.stdout).not.toMatch(/^not ok/m);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const group of ['bad user id', 'cwd outside project', 'arg injection', 'empty args', 'symlink escape', 'claude bin',
      'user command (setpriv, no runuser)', 'tracked runs and stop marker', '.git hardening']) {
      expect(r.stdout).toContain(group);
    }
    expect(r.stdout).toMatch(/# all \d+ checks passed/);
  }, 60_000);

  it('bash -n: dfctl and the install/spike scripts parse', () => {
    for (const f of ['../../ops/dfctl', '../../scripts/install-server.sh', '../../scripts/spike-claude-login.sh']) {
      const r = spawnSync('bash', ['-n', fileURLToPath(new URL(f, import.meta.url))], { encoding: 'utf8' });
      expect(r.status, `${f}: ${r.stderr}`).toBe(0);
    }
  });

  it('no arguments -> usage error (exit 2)', () => {
    const r = dfctl();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });

  it('rejects invalid arguments before doing anything', () => {
    const cases: string[][] = [
      ['frobnicate', '1'],
      ['provision-user'],
      ['provision-user', '1;id'],
      ['provision-user', '-1'],
      ['provision-user', '1', 'extra'],
      ['ensure-project-group', '1', 'relative/path'],
      ['set-members', 'x'],
      ['set-members', '1', '2', '3x'],
      ['run-claude', '1', '/srv/p/.devflow/worktrees/A', '--', '-p'],
      ['run-claude', '1', '/srv/p/.devflow/worktrees/A', '--run-id', 'short', '--', '-p'],
      ['run-claude', '1', '/srv/p/.devflow/worktrees/A', '--run-id', 'abcdef123456', '-p'],
      ['claude-auth', '1', 'whoami'],
      ['claude-auth', '1', 'login'],
      ['stop-claude', '1', '../../etc/passwd'],
    ];
    for (const c of cases) {
      const r = dfctl(...c);
      expect(r.status, c.join(' ')).toBe(2);
      expect(r.stderr, c.join(' ')).toMatch(/^dfctl: /);
    }
  });

  it.skipIf(isRoot)('valid arguments still require root', () => {
    const r = dfctl('provision-user', '7');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must run as root/);
  });
});
