import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectPath } from '../../src/projects/paths.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'devflow-paths-')));
const root = join(base, 'roots'); const outside = join(base, 'outside'); const sibling = join(base, 'roots-evil');
mkdirSync(root); mkdirSync(outside); mkdirSync(sibling);
symlinkSync(outside, join(root, 'link'));
mkdirSync(join(root, 'real'));
symlinkSync(join(root, 'real'), join(root, 'inlink'));

describe('resolveProjectPath', () => {
  it('project path must resolve under roots', () => {
    expect(resolveProjectPath(join(root, 'new', 'app'), [root])).toBe(join(root, 'new', 'app'));
    expect(resolveProjectPath(join(root, 'real'), [root])).toBe(join(root, 'real'));
    expect(resolveProjectPath(join(root, 'inlink'), [root])).toBe(join(root, 'real'));
    expect(() => resolveProjectPath(`${root}/../outside`, [root])).toThrow(/\.\./);
    expect(() => resolveProjectPath(`${root}/a/../../outside`, [root])).toThrow();
    expect(() => resolveProjectPath(join(root, 'link'), [root])).toThrow(/ngoài/);
    expect(() => resolveProjectPath(join(root, 'link', 'sub'), [root])).toThrow(/ngoài/);
    expect(() => resolveProjectPath(outside, [root])).toThrow(/ngoài/);
    expect(() => resolveProjectPath(join(sibling, 'x'), [root])).toThrow(/ngoài/);
  });
  it('rejects root itself, relative, empty, NUL and missing roots', () => {
    expect(() => resolveProjectPath(root, [root])).toThrow();
    expect(() => resolveProjectPath('rel/x', [root])).toThrow();
    expect(() => resolveProjectPath('', [root])).toThrow();
    expect(() => resolveProjectPath(join(root, 'a\0b'), [root])).toThrow();
    expect(() => resolveProjectPath(join(root, 'x'), [])).toThrow(/PROJECT_ROOTS/);
  });
});
