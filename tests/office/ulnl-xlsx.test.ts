import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkbook } from '../../src/office/xlsx-load.js';
import { writeUlnl, type UlnlFeature, type UlnlNonFunc } from '../../src/office/ulnl-xlsx.js';

const TEMPLATE = join(process.cwd(), 'templates/default/ulnl.xlsx');
let dir: string;
let tplBefore: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devflow-ulnl-'));
  tplBefore = (await readFile(TEMPLATE)).toString('base64');
});
afterAll(async () => {
  expect((await readFile(TEMPLATE)).toString('base64')).toBe(tplBefore);
  await rm(dir, { recursive: true, force: true });
});

const features: UlnlFeature[] = [
  { code: 'F01-LOG', name: 'Đăng nhập', description: 'Mô tả đăng nhập', type_code: 'NVJ2-PTM', unit_test: true, note: 'ghi chú 1' },
  { code: 'F02-RPT', name: 'Báo cáo', description: 'Mô tả báo cáo', type_code: 'BC1', unit_test: false, note: '' },
];
const nonFunc: UlnlNonFunc[] = [
  { code: 'PM', name: 'Quản lý dự án', description: 'PM', effort_mh: 12 },
  { code: 'SIT', name: 'Test tích hợp', description: 'SIT' },
];

// exceljs does not persist a cached result of 0, so a formula without one reads as 0
const val = (v: unknown) => (v && typeof v === 'object' && 'formula' in (v as object) ? ((v as { result?: unknown }).result ?? 0) : v);
const formula = (v: unknown) => (v as { formula: string }).formula;

describe('ulnl-xlsx', () => {
  it('ulnl fills rows and type name from lookup', async () => {
    const out = join(dir, 'a.xlsx');
    await writeUlnl(TEMPLATE, features, nonFunc, 'REQ-001 - Tiêu đề thử', out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet('EFFORT_FUNCTION')!;
    expect(ws.getCell('A9').value).toBe(1);
    expect(ws.getCell('B9').value).toBe('F01-LOG');
    expect(ws.getCell('C9').value).toBe('Đăng nhập');
    expect(ws.getCell('D9').value).toBe('Mô tả đăng nhập');
    expect(ws.getCell('K9').value).toBe('NVJ2-PTM');
    expect(val(ws.getCell('L9').value)).toBe('Medium business handling');
    expect(ws.getCell('M9').value).toBe('Yes');
    expect(ws.getCell('M10').value).toBe('No');
    expect(ws.getCell('X9').value).toBe('ghi chú 1');
    expect(val(ws.getCell('L10').value)).toBe('Simple columnar report design');
    // example rows beyond the written ones are cleared
    expect(ws.getCell('B11').value ?? null).toBeNull();
    expect(ws.getCell('K20').value ?? null).toBeNull();
    // title feeds A2 through TOTAL EFFORT!A3
    expect(wb.getWorksheet('TOTAL EFFORT')!.getCell('A3').value).toBe('REQ-001 - Tiêu đề thử');
    expect(val(ws.getCell('A2').value)).toBe('REQ-001 - Tiêu đề thử');
    // non-function
    const nf = wb.getWorksheet('EFFORT NON-FUNCTION')!;
    expect(nf.getCell('B10').value).toBe('PM');
    expect(val(nf.getCell('C10').value)).toBe('Quản lý dự án');
    expect(val(nf.getCell('E10').value)).toBe(12);
    expect(val(nf.getCell('E11').value)).toBe(12); // from DATA BASE_NON - FUNCTION (SIT = 12)
    expect(nf.getCell('B12').value ?? null).toBeNull();
  });

  it('ulnl effort from DATA BASE_FUNCTION (NVJ2-PTM → 10/20/6/14/50)', async () => {
    const out = join(dir, 'b.xlsx');
    await writeUlnl(TEMPLATE, features, nonFunc, 't', out);
    const ws = (await loadWorkbook(out)).getWorksheet('EFFORT_FUNCTION')!;
    expect(['E9', 'F9', 'G9', 'H9', 'I9'].map((a) => val(ws.getCell(a).value))).toEqual([10, 20, 6, 14, 50]);
    // BC1 (6/7/6) without unit test
    expect(['E10', 'F10', 'G10', 'H10', 'I10'].map((a) => val(ws.getCell(a).value))).toEqual([6, 7, 0, 6, 19]);
    // formulas kept with rewritten row refs
    expect(formula(ws.getCell('N10').value)).toContain('K10&$N$7');
    expect(formula(ws.getCell('E8').value)).toBe('SUM(E9:E20)');
  });

  it('extends rows and total formulas beyond the template example rows', async () => {
    const many: UlnlFeature[] = Array.from({ length: 15 }, (_, i) => ({ code: `F${i}`, name: `n${i}`, description: 'd', type_code: 'NVJ1-PTM', unit_test: true, note: '' }));
    const nf: UlnlNonFunc[] = Array.from({ length: 7 }, (_, i) => ({ code: `X${i}`, name: `x${i}`, description: '', effort_mh: 1 }));
    const out = join(dir, 'c.xlsx');
    await writeUlnl(TEMPLATE, many, nf, 't', out);
    const wb = await loadWorkbook(out);
    const ws = wb.getWorksheet('EFFORT_FUNCTION')!;
    expect(ws.getCell('B23').value).toBe('F14');
    expect(formula(ws.getCell('E8').value)).toBe('SUM(E9:E23)');
    const n = wb.getWorksheet('EFFORT NON-FUNCTION')!;
    expect(n.getCell('B16').value).toBe('X6');
    expect(n.getCell('D17').value).toBe('Total');
    expect(formula(n.getCell('E17').value)).toBe('SUM(E10:E16)');
    expect(formula(wb.getWorksheet('TOTAL EFFORT')!.getCell('F10').value)).toBe("'EFFORT NON-FUNCTION'!E17");
  });
});
