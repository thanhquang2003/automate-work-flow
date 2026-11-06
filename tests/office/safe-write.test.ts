import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderDocx } from '../../src/office/docx.js';
import { writeTestCases } from '../../src/office/testcase-xlsx.js';
import { writeUlnl } from '../../src/office/ulnl-xlsx.js';

/**
 * C1b (re-review): office writers render asynchronously and used to write by name afterwards (follow-symlink
 * O_TRUNC). A concurrent seat can plant `artifacts/<name> -> <DATA_DIR>/devflow.db` (or swap artifacts/) while the
 * template renders. The writers must write only through safe-fs: the target stays untouched and the write fails.
 */
afterEach(() => vi.restoreAllMocks());

const ORIGINAL = 'precious service-owned data';

function env() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'df-office-')));
  const root = join(base, 'proj');
  const art = join(root, '.devflow', 'requests', 'R1', 'artifacts');
  mkdirSync(art, { recursive: true });
  const outside = join(base, 'data');
  mkdirSync(outside);
  const victim = join(outside, 'devflow.db');
  writeFileSync(victim, ORIGINAL);
  return { root, art, outside, victim };
}

const docxHook = (plant: () => void) => {
  const orig = JSZip.prototype.generateAsync;
  return vi.spyOn(JSZip.prototype, 'generateAsync').mockImplementation(function (this: JSZip, ...a: Parameters<JSZip['generateAsync']>) {
    plant();
    return orig.apply(this, a);
  } as never);
};
const xlsxHook = (plant: () => void) => {
  const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as { writeBuffer: (...a: unknown[]) => Promise<unknown> };
  const orig = proto.writeBuffer;
  return vi.spyOn(proto, 'writeBuffer').mockImplementation(function (this: unknown, ...a: unknown[]) {
    plant();
    return orig.apply(this, a);
  });
};

const writers = (): { name: string; file: string; hook: (plant: () => void) => unknown; run: (out: string, root: string) => Promise<void> }[] => [
  { name: 'renderDocx', file: 'TKDB_R1_v1.docx', hook: docxHook, run: (out, root) => renderDocx('templates/default/tkdb.docx', '# A\n\nb', out, root) },
  { name: 'writeTestCases', file: 'TestCase_R1_v1.xlsx', hook: xlsxHook, run: (out, root) => writeTestCases('templates/default/testcase.xlsx', [], out, root) },
  { name: 'writeUlnl', file: 'ULNL_R1_v1.xlsx', hook: xlsxHook, run: (out, root) => writeUlnl('templates/default/ulnl.xlsx', [], [], 't', out, root) },
];

describe('office writers write only through safe-fs (C1b)', () => {
  for (const w of writers()) {
    it(`${w.name}: a symlink planted between render and write is refused; target untouched`, async () => {
      const e = env();
      const out = join(e.art, w.file);
      w.hook(() => symlinkSync(e.victim, out));
      await expect(w.run(out, e.root)).rejects.toThrow(/symlink|regular file|refusing/);
      expect(readFileSync(e.victim, 'utf8')).toBe(ORIGINAL);
    });

    it(`${w.name}: artifacts/ swapped for a directory symlink during render is refused; nothing lands outside`, async () => {
      const e = env();
      const out = join(e.art, w.file);
      writeFileSync(join(e.outside, w.file), ORIGINAL);
      w.hook(() => { renameSync(e.art, `${e.art}.old`); symlinkSync(e.outside, e.art); });
      await expect(w.run(out, e.root)).rejects.toThrow(/symlink|refusing/);
      expect(readFileSync(join(e.outside, w.file), 'utf8')).toBe(ORIGINAL);
      expect(readdirSync(e.outside).sort()).toEqual(['devflow.db', w.file].sort());
    });

    it(`${w.name}: normal write works and leaves no temp file`, async () => {
      const e = env();
      const out = join(e.art, w.file);
      await w.run(out, e.root);
      expect(readFileSync(out).subarray(0, 2).toString()).toBe('PK');
      expect(readdirSync(e.art)).toEqual([w.file]);
    });
  }
});
