import { describe, it, expect } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnsafePathError, prepareWrite, safeCopyTree, safeOpenAppend, safeReadText, safeRemove, safeWriteFile,
} from '../../src/engine/safe-fs.js';
import { execFileSync } from 'node:child_process';
import { readFlowState, readProjectInfo, writeFlowState, writeJson } from '../../src/engine/stages/common.js';
import { readJsonOutput } from '../../src/engine/stages/claude-json.js';
import { Workspace } from '../../src/engine/workspace.js';
import { closeSync, writeSync } from 'node:fs';
import { z } from 'zod';

function env() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'df-safefs-')));
  const root = join(base, 'proj');
  const outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const secret = join(outside, 'secret.txt');
  writeFileSync(secret, 'SECRET');
  return { base, root, outside, secret };
}

describe('safe-fs', () => {
  it('writes and reads a normal file, creating folders', () => {
    const e = env();
    safeWriteFile(join(e.root, 'a', 'b', 'c.txt'), 'hello', e.root);
    expect(safeReadText(join(e.root, 'a', 'b', 'c.txt'), e.root)).toBe('hello');
    safeWriteFile(join(e.root, 'a', 'b', 'c.txt'), 'x', e.root);
    expect(readFileSync(join(e.root, 'a', 'b', 'c.txt'), 'utf8')).toBe('x');
  });

  it('refuses a planted symlink as the file and never touches the target', () => {
    const e = env();
    symlinkSync(e.secret, join(e.root, 'flow.json'));
    expect(() => safeWriteFile(join(e.root, 'flow.json'), 'pwned', e.root)).toThrow(UnsafePathError);
    expect(() => safeReadText(join(e.root, 'flow.json'), e.root)).toThrow(UnsafePathError);
    expect(readFileSync(e.secret, 'utf8')).toBe('SECRET');
  });

  it('refuses a symlinked folder on the way', () => {
    const e = env();
    symlinkSync(e.outside, join(e.root, 'docs'));
    expect(() => safeWriteFile(join(e.root, 'docs', 'secret.txt'), 'pwned', e.root)).toThrow(UnsafePathError);
    expect(() => safeReadText(join(e.root, 'docs', 'secret.txt'), e.root)).toThrow(UnsafePathError);
    expect(readFileSync(e.secret, 'utf8')).toBe('SECRET');
  });

  it('refuses to write a hard-linked file', () => {
    const e = env();
    linkSync(e.secret, join(e.root, 'h.txt'));
    expect(() => safeWriteFile(join(e.root, 'h.txt'), 'pwned', e.root)).toThrow(UnsafePathError);
    expect(readFileSync(e.secret, 'utf8')).toBe('SECRET');
  });

  it('append opens refuse symlinks; prepareWrite removes a planted link but not its target', () => {
    const e = env();
    symlinkSync(e.secret, join(e.root, 'run.log'));
    expect(() => safeOpenAppend(join(e.root, 'run.log'), e.root)).toThrow(UnsafePathError);
    prepareWrite(join(e.root, 'run.log'), e.root);
    expect(existsSync(join(e.root, 'run.log'))).toBe(false);
    expect(readFileSync(e.secret, 'utf8')).toBe('SECRET');
    const fd = safeOpenAppend(join(e.root, 'run.log'), e.root);
    writeSync(fd, 'line\n');
    closeSync(fd);
    expect(readFileSync(join(e.root, 'run.log'), 'utf8')).toBe('line\n');
  });

  it('copyTree skips symlinks', () => {
    const e = env();
    mkdirSync(join(e.root, 'src', 'sub'), { recursive: true });
    writeFileSync(join(e.root, 'src', 'sub', 'ok.txt'), 'ok');
    symlinkSync(e.secret, join(e.root, 'src', 'leak.txt'));
    symlinkSync(e.outside, join(e.root, 'src', 'dirlink'));
    const copied = safeCopyTree(join(e.root, 'src'), join(e.root, 'dst'), e.root, e.root);
    expect(copied).toEqual(['sub/ok.txt']);
    expect(existsSync(join(e.root, 'dst', 'leak.txt'))).toBe(false);
  });

  it('engine state files under a project refuse planted symlinks (flow-state, project.json, writeJson, Claude output)', async () => {
    const e = env();
    const ws = Workspace.forProject(e.root, 'ERP-1').ensure();
    symlinkSync(e.secret, join(ws.root, 'flow-state.json'));
    expect(() => writeFlowState(ws, readFlowStateSafeDefault())).toThrow(UnsafePathError);
    expect(() => readFlowState(ws)).toThrow(UnsafePathError);
    symlinkSync(e.secret, join(ws.root, 'project.json'));
    expect(() => readProjectInfo(ws)).toThrow(UnsafePathError);
    mkdirSync(join(ws.root, 'x'), { recursive: true });
    symlinkSync(e.secret, join(ws.root, 'x', 'answers.json'));
    expect(() => writeJson(join(ws.root, 'x', 'answers.json'), [])).toThrow(UnsafePathError);
    symlinkSync(e.secret, join(ws.root, 'out.json'));
    await expect(readJsonOutput(join(ws.root, 'out.json'), z.any())).rejects.toThrow(/symlink/);
    expect(readFileSync(e.secret, 'utf8')).toBe('SECRET');
  });
});

function readFlowStateSafeDefault() {
  return { runs: {}, issueUrls: {}, reviewRounds: {}, bugSynced: {}, clock: 0, lastFixSeq: 0 };
}

describe('safe-fs non-regular targets (never block the event loop)', () => {
  const kinds = (e: ReturnType<typeof env>) => {
    const fifo = join(e.root, 'flow-state.json');
    execFileSync('mkfifo', [fifo]);
    const dir = join(e.root, 'adir');
    mkdirSync(dir);
    const link = join(e.root, 'link.json');
    symlinkSync(e.secret, link);
    return { fifo, dir, link, dev: '/dev/null' };
  };

  it('reads refuse a FIFO, a directory, a symlink and a device quickly', () => {
    const e = env();
    const k = kinds(e);
    for (const p of [k.fifo, k.dir, k.link]) expect(() => safeReadText(p, e.root)).toThrow(UnsafePathError);
    expect(() => safeReadText(k.dev, '/dev')).toThrow(UnsafePathError);
  }, 5000);

  it('writes and appends refuse a FIFO, a directory, a symlink and a device quickly', () => {
    const e = env();
    const k = kinds(e);
    for (const p of [k.fifo, k.dir, k.link]) {
      expect(() => safeWriteFile(p, 'x', e.root)).toThrow(UnsafePathError);
      expect(() => safeOpenAppend(p, e.root)).toThrow(UnsafePathError);
    }
    expect(() => safeWriteFile(k.dev, 'x', '/dev')).toThrow(UnsafePathError);
    expect(readFileSync(e.secret, 'utf8')).toBe('SECRET');
  }, 5000);

  it('engine readers refuse a planted FIFO quickly', async () => {
    const e = env();
    const ws = Workspace.forProject(e.root, 'ERP-1').ensure();
    execFileSync('mkfifo', [join(ws.root, 'flow-state.json')]);
    expect(() => readFlowState(ws)).toThrow(UnsafePathError);
    execFileSync('mkfifo', [join(ws.root, 'out.json')]);
    await expect(readJsonOutput(join(ws.root, 'out.json'), z.any())).rejects.toThrow();
  }, 5000);

  it('safeRemove removes files and links (not their targets), refuses symlinked parents', () => {
    const e = env();
    writeFileSync(join(e.root, 'f.txt'), 'x');
    safeRemove(join(e.root, 'f.txt'), e.root);
    expect(existsSync(join(e.root, 'f.txt'))).toBe(false);
    symlinkSync(e.secret, join(e.root, 'l.txt'));
    safeRemove(join(e.root, 'l.txt'), e.root);
    expect(readFileSync(e.secret, 'utf8')).toBe('SECRET');
    safeRemove(join(e.root, 'missing.txt'), e.root);
    // A folder reached through a planted link is never deleted into.
    symlinkSync(e.outside, join(e.root, 'ev'));
    expect(() => safeRemove(join(e.root, 'ev', 'secret.txt'), e.root)).toThrow(UnsafePathError);
    expect(() => safeRemove(join(e.root, 'ev', 'x'), e.root, { recursive: true })).toThrow(UnsafePathError);
    expect(existsSync(e.secret)).toBe(true);
    // Recursive removal of a real folder does not follow links inside it.
    mkdirSync(join(e.root, 'tree', 'sub'), { recursive: true });
    writeFileSync(join(e.root, 'tree', 'sub', 'a'), 'a');
    symlinkSync(e.outside, join(e.root, 'tree', 'out'));
    safeRemove(join(e.root, 'tree'), e.root, { recursive: true });
    expect(existsSync(join(e.root, 'tree'))).toBe(false);
    expect(existsSync(e.secret)).toBe(true);
    // A directory where a file is expected is refused without recursive.
    mkdirSync(join(e.root, 'd'));
    expect(() => safeRemove(join(e.root, 'd'), e.root)).toThrow(UnsafePathError);
  });
});

describe('safe-fs: web helpers (C1)', () => {
  it('safeListTree lists regular files recursively and never follows links', async () => {
    const { safeListTree } = await import('../../src/engine/safe-fs.js');
    const e = env();
    mkdirSync(join(e.root, 'art', 'sub'), { recursive: true });
    writeFileSync(join(e.root, 'art', 'a.txt'), 'a');
    writeFileSync(join(e.root, 'art', 'sub', 'b.txt'), 'bb');
    symlinkSync(e.secret, join(e.root, 'art', 'leak.txt'));
    symlinkSync(e.outside, join(e.root, 'art', 'dirlink'));
    execFileSync('mkfifo', [join(e.root, 'art', 'pipe')]);
    expect(safeListTree(join(e.root, 'art'), e.root).map(x => [x.rel, x.size])).toEqual([['a.txt', 1], ['sub/b.txt', 2]]);
    expect(safeListTree(join(e.root, 'missing'), e.root)).toEqual([]);
    expect(() => safeListTree(join(e.root, 'art', 'dirlink'), e.root)).toThrow(UnsafePathError);
  });

  it('safeOpenRead / SafeFileStream refuse links, FIFOs and symlinked folders; lazy streams skip them', async () => {
    const { safeOpenRead, SafeFileStream } = await import('../../src/engine/safe-fs.js');
    const e = env();
    writeFileSync(join(e.root, 'ok.txt'), 'fine');
    symlinkSync(e.secret, join(e.root, 'leak.txt'));
    symlinkSync(e.outside, join(e.root, 'dir'));
    execFileSync('mkfifo', [join(e.root, 'pipe')]);
    for (const p of ['leak.txt', 'dir/secret.txt', 'pipe']) expect(() => safeOpenRead(join(e.root, p), e.root), p).toThrow(UnsafePathError);
    const read = async (s: NodeJS.ReadableStream) => { let t = ''; for await (const c of s) t += String(c); return t; };
    const { fd } = safeOpenRead(join(e.root, 'ok.txt'), e.root);
    expect(await read(new SafeFileStream(join(e.root, 'ok.txt'), e.root, fd))).toBe('fine');
    for (const p of ['leak.txt', 'dir/secret.txt', 'pipe', 'nope']) {
      const s = new SafeFileStream(join(e.root, p), e.root);
      expect(await read(s), p).toBe('');
      expect(s.skipped, p).toBe(true);
    }
  });

  it('safeMkdirp creates folders but refuses a symlink anywhere on the way', async () => {
    const { safeMkdirp } = await import('../../src/engine/safe-fs.js');
    const e = env();
    safeMkdirp(join(e.root, 'x', 'y', 'z'), e.root);
    expect(existsSync(join(e.root, 'x', 'y', 'z'))).toBe(true);
    symlinkSync(e.outside, join(e.root, 'inputs'));
    expect(() => safeMkdirp(join(e.root, 'inputs', 'changes', 'CR-1'), e.root)).toThrow(UnsafePathError);
    expect(() => safeMkdirp(join(e.root, 'inputs'), e.root)).toThrow(UnsafePathError);
    expect(existsSync(join(e.outside, 'changes'))).toBe(false);
  });
});
