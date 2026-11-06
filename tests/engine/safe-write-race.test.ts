import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeFsTestHooks, safeOpenAppend, safeWriteFile, UnsafePathError } from '../../src/engine/safe-fs.js';
import { closeSync } from 'node:fs';

/**
 * Round 2 item 1: the write path must not be redirectable by swapping the parent folder for a symlink at any race
 * window (between the checks and the open, between the open and the final check), and a failed write must never
 * delete or create anything outside the trust root (cleanup only through the verified parent descriptor).
 */
afterEach(() => { delete safeFsTestHooks.beforeParentOpen; delete safeFsTestHooks.beforeFileOpen; delete safeFsTestHooks.afterFileOpen; });

function env() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'df-race-')));
  const root = join(base, 'proj');
  const art = join(root, '.devflow', 'requests', 'R1', 'artifacts');
  mkdirSync(art, { recursive: true });
  const x = join(base, 'X'); // decoy without the name
  const y = join(base, 'Y'); // decoy with a same-named DevFlow file
  mkdirSync(x); mkdirSync(y);
  writeFileSync(join(y, 'flow.json'), 'Y-ORIGINAL');
  const pointAt = (target: string): void => {
    try { unlinkSync(art); } catch { renameSync(art, `${art}.orig`); }
    symlinkSync(target, art);
  };
  const decoysUntouched = (): void => {
    expect(readdirSync(x)).toEqual([]);
    expect(readdirSync(y)).toEqual(['flow.json']);
    expect(readFileSync(join(y, 'flow.json'), 'utf8')).toBe('Y-ORIGINAL');
  };
  return { base, root, art, x, y, pointAt, decoysUntouched };
}

const WINDOWS = ['beforeParentOpen', 'beforeFileOpen', 'afterFileOpen'] as const;

describe('safeWriteFile: parent swapped for a symlink at each race window', () => {
  for (const w of WINDOWS) {
    for (const existed of [false, true]) {
      it(`${w}, ${existed ? 'existing' : 'new'} file: fails loudly, nothing outside changes, original untouched`, () => {
        const e = env();
        const target = join(e.art, 'flow.json');
        if (existed) writeFileSync(target, 'MINE');
        safeFsTestHooks[w] = () => e.pointAt(e.y);
        expect(() => safeWriteFile(target, 'NEW DATA', e.root)).toThrow(UnsafePathError);
        e.decoysUntouched();
        const orig = join(`${e.art}.orig`, 'flow.json');
        if (existed) expect(readFileSync(orig, 'utf8')).toBe('MINE'); // never truncated
        else expect(readdirSync(`${e.art}.orig`)).toEqual([]); // the empty file this call made is gone
      });
    }
  }

  it('flip to X before the open, then re-point to Y before the cleanup: Y/<name> survives, X stays empty', () => {
    const e = env();
    const target = join(e.art, 'flow.json');
    safeFsTestHooks.beforeFileOpen = () => e.pointAt(e.x);
    safeFsTestHooks.afterFileOpen = () => e.pointAt(e.y);
    expect(() => safeWriteFile(target, 'NEW DATA', e.root)).toThrow(UnsafePathError);
    e.decoysUntouched();
    expect(readdirSync(`${e.art}.orig`)).toEqual([]);
  });

  it('safeOpenAppend goes through the same verified parent', () => {
    const e = env();
    safeFsTestHooks.afterFileOpen = () => e.pointAt(e.y);
    expect(() => safeOpenAppend(join(e.art, 'flow.json'), e.root)).toThrow(UnsafePathError);
    e.decoysUntouched();
  });

  it('normal writes and appends still work; refusals kept (symlink, hard link, FIFO, directory)', () => {
    const e = env();
    const f = join(e.art, 'a.txt');
    safeWriteFile(f, 'one', e.root);
    safeWriteFile(f, 'two', e.root);
    expect(readFileSync(f, 'utf8')).toBe('two');
    const fd = safeOpenAppend(f, e.root);
    closeSync(fd);
    symlinkSync(join(e.y, 'flow.json'), join(e.art, 'link'));
    expect(() => safeWriteFile(join(e.art, 'link'), 'x', e.root)).toThrow(UnsafePathError);
    mkdirSync(join(e.art, 'dir'));
    expect(() => safeWriteFile(join(e.art, 'dir'), 'x', e.root)).toThrow(UnsafePathError);
    rmSync(join(e.art, 'dir'), { recursive: true });
    e.decoysUntouched();
  });
});
