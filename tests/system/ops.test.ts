import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { DEFAULT_DFCTL_PATH, NoopSystemOps, SudoSystemOps, checkServerPrereqs } from '../../src/system/ops.js';
import { mkSeatFakes } from '../claude/seat-fakes.js';

const hasBash = process.platform !== 'win32';

describe('config', () => {
  it('DFCTL_PATH defaults to /usr/local/lib/devflow/dfctl', () => {
    expect(DEFAULT_DFCTL_PATH).toBe('/usr/local/lib/devflow/dfctl');
    expect(loadConfig({}).dfctlPath).toBe(DEFAULT_DFCTL_PATH);
    expect(loadConfig({ DFCTL_PATH: '  ' }).dfctlPath).toBe(DEFAULT_DFCTL_PATH);
  });
});

describe('checkServerPrereqs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'df-ops-'));
  const good = join(dir, 'dfctl');
  writeFileSync(good, '#!/bin/sh\n');
  chmodSync(good, 0o755);

  it('server mode refuses to start without dfctl', () => {
    expect(() => checkServerPrereqs({ mode: 'server', dfctlPath: join(dir, 'missing') }, { platform: 'linux' })).toThrow(/dfctl/);
  });
  it('refuses on non-Linux', () => {
    expect(() => checkServerPrereqs({ mode: 'server', dfctlPath: good }, { platform: 'win32', requireRootOwned: false })).toThrow(/Linux/);
  });
  it('refuses a non-executable, relative, or writable-by-others dfctl', () => {
    const noexec = join(dir, 'noexec');
    writeFileSync(noexec, '#!/bin/sh\n');
    chmodSync(noexec, 0o644);
    expect(() => checkServerPrereqs({ mode: 'server', dfctlPath: noexec }, { platform: 'linux', requireRootOwned: false })).toThrow(/thực thi|executable/);
    expect(() => checkServerPrereqs({ mode: 'server', dfctlPath: 'dfctl' }, { platform: 'linux', requireRootOwned: false })).toThrow(/tuyệt đối|absolute/);
    const loose = join(dir, 'loose');
    writeFileSync(loose, '#!/bin/sh\n');
    chmodSync(loose, 0o777);
    expect(() => checkServerPrereqs({ mode: 'server', dfctlPath: loose }, { platform: 'linux', requireRootOwned: false })).toThrow(/ghi|writable/);
  });
  it('by default requires dfctl owned by root', () => {
    if (process.getuid?.() === 0) return;
    expect(() => checkServerPrereqs({ mode: 'server', dfctlPath: good }, { platform: 'linux' })).toThrow(/root/);
  });
  it('accepts a proper dfctl; local mode needs nothing', () => {
    expect(() => checkServerPrereqs({ mode: 'server', dfctlPath: good }, { platform: 'linux', requireRootOwned: false })).not.toThrow();
    expect(() => checkServerPrereqs({ mode: 'local', dfctlPath: join(dir, 'missing') })).not.toThrow();
  });
});

describe.skipIf(!hasBash)('SudoSystemOps', () => {
  it('runs sudo -n dfctl with validated arguments', async () => {
    const f = mkSeatFakes();
    const ops = new SudoSystemOps({ dfctlPath: f.dfctl, sudoBin: f.sudo });
    await ops.provisionUser(12);
    await ops.ensureProjectGroup(3, '/srv/projects/erp');
    await ops.setMembers(3, [12, 5, 12]);
    expect(f.calls()).toEqual([
      ['provision-user', '12'],
      ['ensure-project-group', '3', '/srv/projects/erp'],
      ['set-members', '3', '5', '12'],
    ]);
    expect(f.sudoCalls()[0]![0]).toBe(f.dfctl);
  });
  it('rejects bad ids and relative paths before calling sudo', async () => {
    const f = mkSeatFakes();
    const ops = new SudoSystemOps({ dfctlPath: f.dfctl, sudoBin: f.sudo });
    await expect(ops.provisionUser(0)).rejects.toThrow();
    await expect(ops.provisionUser(1.5)).rejects.toThrow();
    await expect(ops.ensureProjectGroup(1, 'rel/p')).rejects.toThrow();
    await expect(ops.ensureProjectGroup(1, '/a\nb')).rejects.toThrow();
    await expect(ops.setMembers(1, [2, -3])).rejects.toThrow();
    expect(f.calls()).toEqual([]);
  });
  it('a dfctl failure becomes a rejected promise carrying dfctl stderr', async () => {
    const f = mkSeatFakes();
    f.set('fail', '1');
    const ops = new SudoSystemOps({ dfctlPath: f.dfctl, sudoBin: f.sudo });
    await expect(ops.provisionUser(1)).rejects.toThrow(/boom/);
  });
  it('Noop does nothing', async () => {
    const n = new NoopSystemOps();
    await n.provisionUser(1);
    await n.ensureProjectGroup(1, '/x');
    await n.setMembers(1, []);
  });
});
