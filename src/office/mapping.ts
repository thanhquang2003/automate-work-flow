import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type ExcelJS from 'exceljs';

export interface TestcaseMapping {
  sheet: string;
  firstDataRow: number;
  columns: Record<'id' | 'purpose' | 'data' | 'steps' | 'expected' | 'real' | 'pre1' | 'pre2' | 'prod1' | 'prod2' | 'evidence' | 'comment', string>;
  summary: Record<'pass' | 'fail' | 'pending' | 'total', string>;
}

export interface UlnlFunctionMapping {
  sheet: string;
  firstDataRow: number;
  totalsRow: number;
  minLastRow: number;
  columns: Record<'no' | 'code' | 'name' | 'desc' | 'sol' | 'dev' | 'ut' | 'test' | 'total' | 'typeCode' | 'typeName' | 'utFlag' | 'note', string>;
  unitTestRatio: number;
  typeLookup: { sheet: string; codeCol: string; nameCol: string; firstRow: number };
  effortLookup: { sheet: string; typeCol: string; workCol: string; mhCol: string; firstRow: number };
}

export interface UlnlNonFunctionMapping {
  sheet: string;
  firstDataRow: number;
  minRows: number;
  columns: Record<'no' | 'code' | 'name' | 'desc' | 'effort', string>;
  lookup: { sheet: string; codeCol: string; nameCol: string; mhCol: string; firstRow: number };
}

export interface UlnlMapping {
  title: { cell: string; sourceSheet: string; sourceCell: string };
  function: UlnlFunctionMapping;
  nonFunction: UlnlNonFunctionMapping;
}

export interface Mapping {
  testcase: TestcaseMapping;
  ulnl: UlnlMapping;
}

/** mapping.json next to the template, falling back to the bundled templates/default one. */
export async function loadMapping(templatePath: string): Promise<Mapping> {
  const candidates = [join(dirname(templatePath), 'mapping.json'), join(dirname(fileURLToPath(import.meta.url)), '../../templates/default/mapping.json')];
  for (const p of candidates) {
    try {
      return JSON.parse(await readFile(p, 'utf8')) as Mapping;
    } catch {
      /* try next */
    }
  }
  throw new Error('mapping.json not found');
}

/** Column letters to 1-based index (A=1, AA=27). */
export function colNo(letters: string): number {
  return letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

/** Plain value of a cell (formula results unwrapped, rich text flattened). */
export function plain(v: ExcelJS.CellValue | undefined): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  const o = v as unknown as Record<string, unknown>;
  if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
  if ('result' in o) return plain(o.result as ExcelJS.CellValue);
  if ('text' in o) return plain(o.text as ExcelJS.CellValue);
  return null;
}

/** Clears the value of every cell in a column range of a row, keeping styles. */
export function clearRow(ws: ExcelJS.Worksheet, rowNo: number, fromCol: number, toCol: number): void {
  const row = ws.getRow(rowNo);
  for (let c = fromCol; c <= toCol; c++) {
    const cell = row.getCell(c);
    if (cell.value !== null) cell.value = null;
  }
}
