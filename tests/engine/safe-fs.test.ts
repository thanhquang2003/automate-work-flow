import { describe, it, expect } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnsafePathError, prepareWrite, safeCopyTree, safeOpenAppend, safeReadText, safeWriteFile,
} from '../../src/engine/safe-fs.js';
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
