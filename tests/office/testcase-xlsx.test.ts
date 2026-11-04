import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkbook } from '../../src/office/xlsx-load.js';
import { writeTestCases, type TcSheetRow } from '../../src/office/testcase-xlsx.js';

const TEMPLATE = join(process.cwd(), 'templates/default/testcase.xlsx');
let dir: string;
let tplBefore: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devflow-tc-'));
  tplBefore = (await readFile(TEMPLATE)).toString('base64');
});
afterAll(async () => {
  expect((await readFile(TEMPLATE)).toString('base64')).toBe(tplBefore);
  await rm(dir, { recursive: true, force: true });
});

const rows: TcSheetRow[] = [
  { id: 'TC-LOGIN-01', purpose: 'Đăng nhập đúng', data: 'u/p', steps: '1. Mở trang', expected: 'Vào trang chủ', real_result: 'OK', status1: 'P', evidence: ['evidence/TC-LOGIN-01/a.png', 'evidence/TC-LOGIN-01/b.png'], comment: 'tốt' },
  { id: 'TC-LOGIN-02', purpose: 'Sai mật khẩu', data: 'u/x', steps: '1. Mở trang', expected: 'Báo lỗi', status1: 'F', status2: 'P' },
  { id: 'TC-LOGIN-03', purpose: 'Khoá tài khoản', data: '', steps: '1.', expected: 'Khoá', status1: 'PE' },
  { id: 'TC-LOGIN-04', purpose: 'Lỗi', data: '', steps: '1.', expected: 'x', status1: 'P', status2: 'F' },
  { id: 'TC-LOGIN-05', purpose: 'Chưa chạy', data: '', steps: '1.', expected: 'x' },
];

describe('testcase-xlsx', () => {
  it('writes test rows from row 12 and clears examples', async () => {
    const out = join(dir, 'a.xlsx');
    await writeTestCases(TEMPLATE, rows, out);
    const ws = (await loadWorkbook(out)).getWorksheet('2. FUNCTIONAL TESTCASE')!;
    expect(ws.getCell('A12').value).toBe('TC-LOGIN-01');
    expect(ws.getCell('B12').value).toBe('Đăng nhập đúng');
    expect(ws.getCell('E12').value).toBe('Vào trang chủ');
    expect(ws.getCell('F12').value).toBe('OK');
    expect(ws.getCell('I12').value).toBe('P');
    expect(ws.getCell('N12').value).toBe('tốt');
    expect(ws.getCell('A16').value).toBe('TC-LOGIN-05');
    for (let r = 17; r <= 40; r++) expect(ws.getCell(`A${r}`).value ?? null).toBeNull();
    expect(ws.getCell('C16').value ?? null).toBeNull();
  });

  it('summary counts P/F/PE', async () => {
    const out = join(dir, 'b.xlsx');
    await writeTestCases(TEMPLATE, rows, out);
    const ws = (await loadWorkbook(out)).getWorksheet('2. FUNCTIONAL TESTCASE')!;
    // latest status: 01 P, 02 P (2nd), 03 PE, 04 F (2nd), 05 none
    expect(ws.getCell('I3').value).toBe(2);
    expect(ws.getCell('I4').value).toBe(1);
    expect(ws.getCell('I5').value).toBe(1);
    expect(ws.getCell('I6').value).toBe(4);
    expect(ws.getCell('J13').value).toBe('P');
  });

  it('evidence hyperlink', async () => {
    const out = join(dir, 'c.xlsx');
    await writeTestCases(TEMPLATE, rows, out);
    const ws = (await loadWorkbook(out)).getWorksheet('2. FUNCTIONAL TESTCASE')!;
    const v = ws.getCell('M12').value as { text: string; hyperlink: string };
    expect(v.hyperlink).toBe('evidence/TC-LOGIN-01/a.png');
    expect(v.text).toBe('evidence/TC-LOGIN-01/a.png\nevidence/TC-LOGIN-01/b.png');
    expect(ws.getCell('M13').value ?? null).toBeNull();
  });
});
