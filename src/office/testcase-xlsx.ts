import type ExcelJS from 'exceljs';
import { loadWorkbook } from './xlsx-load.js';
import { loadMapping, clearRow, colNo } from './mapping.js';
import { cancelNote } from './ulnl-xlsx.js';

export interface TcSheetRow {
  id: string;
  purpose: string;
  data: string;
  steps: string;
  expected: string;
  real_result?: string;
  status1?: 'P' | 'F' | 'PE';
  status2?: 'P' | 'F' | 'PE';
  evidence?: string[];
  comment?: string;
  /** CR that cancelled the test case: the row stays visible, comment "Hủy theo CR-NN", no status (not counted). */
  cancelledBy?: string;
}

export async function writeTestCases(templatePath: string, rows: TcSheetRow[], outPath: string): Promise<void> {
  const map = (await loadMapping(templatePath)).testcase;
  const wb = await loadWorkbook(templatePath);
  const ws = wb.getWorksheet(map.sheet);
  if (!ws) throw new Error(`Sheet not found: ${map.sheet}`);
  const col = Object.fromEntries(Object.entries(map.columns).map(([k, v]) => [k, colNo(v)])) as Record<keyof typeof map.columns, number>;
  const first = map.firstDataRow;
  const allCols = Object.values(col);
  const minCol = Math.min(...allCols);
  const maxCol = Math.max(...allCols);

  // Remember the style of the first (example) data row per column, then clear example values.
  const styles = new Map<number, Partial<ExcelJS.Style>>();
  for (let c = minCol; c <= maxCol; c++) styles.set(c, { ...ws.getRow(first).getCell(c).style });
  for (let r = first; r <= ws.rowCount; r++) clearRow(ws, r, minCol, maxCol);

  rows.forEach((tc, i) => {
    const row = ws.getRow(first + i);
    for (const [c, st] of styles) row.getCell(c).style = { ...st };
    row.getCell(col.id).value = tc.id;
    row.getCell(col.purpose).value = tc.purpose;
    row.getCell(col.data).value = tc.data || null;
    row.getCell(col.steps).value = tc.steps;
    row.getCell(col.expected).value = tc.expected;
    if (tc.real_result) row.getCell(col.real).value = tc.real_result;
    const cancelled = tc.cancelledBy !== undefined;
    if (tc.status1 && !cancelled) row.getCell(col.pre1).value = tc.status1;
    if (tc.status2 && !cancelled) row.getCell(col.pre2).value = tc.status2;
    if (tc.evidence && tc.evidence.length > 0) {
      row.getCell(col.evidence).value = { text: tc.evidence.join('\n'), hyperlink: tc.evidence[0]! };
    }
    const comment = cancelled ? [cancelNote(tc.cancelledBy!), tc.comment].filter(Boolean).join('\n') : tc.comment;
    if (comment) row.getCell(col.comment).value = comment;
  });

  // Live COUNTIF formulas as in the template, over the first run (pre1) and second run (pre2) columns.
  // Range ends at the last written row, or at the template's own range end when that is larger.
  const tplF = (ws.getCell(map.summary.pass).value as { formula?: string } | null)?.formula ?? '';
  const tplEnd = Number(/:[A-Z]+(\d+)/.exec(tplF)?.[1] ?? 0);
  const lastRow = Math.max(first + rows.length - 1, tplEnd);
  const runs: [string, 'status1' | 'status2'][] = [[map.columns.pre1, 'status1'], [map.columns.pre2, 'status2']];
  for (const [letter, key] of runs) {
    const counts = { P: 0, F: 0, PE: 0 };
    for (const tc of rows) {
      if (tc.cancelledBy !== undefined) continue;
      const s = tc[key];
      if (s) counts[s]++;
    }
    const at = (cell: string): string => cell.replace(/^[A-Z]+/, letter);
    const range = `${letter}${first}:${letter}${lastRow}`;
    const [p, f, pe, t] = [at(map.summary.pass), at(map.summary.fail), at(map.summary.pending), at(map.summary.total)];
    ws.getCell(p).value = { formula: `COUNTIF(${range},"P")`, result: counts.P };
    ws.getCell(f).value = { formula: `COUNTIF(${range},"F")`, result: counts.F };
    ws.getCell(pe).value = { formula: `COUNTIF(${range},"PE")`, result: counts.PE };
    ws.getCell(t).value = { formula: `SUM(${p}:${pe})`, result: counts.P + counts.F + counts.PE };
  }


  wb.calcProperties.fullCalcOnLoad = true;
  await wb.xlsx.writeFile(outPath);
}
