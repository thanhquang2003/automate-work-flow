import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UnsafePathError } from '../../src/engine/safe-fs.js';
import { readEvidenceForUpload } from '../../src/engine/stages/test.js';
import { Workspace } from '../../src/engine/workspace.js';
import { setup } from './helpers.js';

/**
 * C1c (re-review): the TEST stage uploads the first evidence file to a GitLab issue. A seat that swaps the copied
 * artifacts/evidence/<TC>/<file> for a symlink (or a FIFO) must not get DevFlow to upload the target.
 */
function env() {
  const s = setup();
  const ws = Workspace.for(s.cfg, 'REQ-1').ensure();
  const dir = join(ws.artifactsDir, 'evidence', 'TC-01');
  mkdirSync(dir, { recursive: true });
  const out = mkdtempSync(join(tmpdir(), 'df-secret-'));
  writeFileSync(join(out, 'devflow.db'), 'SECRET_KEY=abc');
  return { ws, dir, out };
}

describe('evidence upload reads through safe-fs (C1c)', () => {
  it('reads a regular evidence file', () => {
    const { ws, dir } = env();
    writeFileSync(join(dir, 'a.png'), 'png');
    expect(readEvidenceForUpload(ws, 'evidence/TC-01/a.png')).toEqual({ name: 'a.png', data: Buffer.from('png') });
  });

  it('refuses a symlinked evidence file, a symlinked folder and a FIFO', () => {
    const { ws, dir, out } = env();
    symlinkSync(join(out, 'devflow.db'), join(dir, 'a.png'));
    expect(() => readEvidenceForUpload(ws, 'evidence/TC-01/a.png')).toThrow(UnsafePathError);
    symlinkSync(out, join(dir, 'sub'));
    expect(() => readEvidenceForUpload(ws, 'evidence/TC-01/sub/devflow.db')).toThrow(UnsafePathError);
    execFileSync('mkfifo', [join(dir, 'p.png')]);
    expect(() => readEvidenceForUpload(ws, 'evidence/TC-01/p.png')).toThrow(UnsafePathError);
  });

  it('refuses a file over the upload cap and a path escaping artifacts/', () => {
    const { ws, dir } = env();
    writeFileSync(join(dir, 'big.png'), '');
    truncateSync(join(dir, 'big.png'), 200 * 1024 * 1024);
    expect(() => readEvidenceForUpload(ws, 'evidence/TC-01/big.png')).toThrow(UnsafePathError);
    expect(() => readEvidenceForUpload(ws, '../inputs/x')).toThrow();
  });
});
