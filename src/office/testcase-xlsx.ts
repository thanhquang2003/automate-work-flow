import type ExcelJS from 'exceljs';
import { loadWorkbook } from './xlsx-load.js';
import { loadMapping, clearRow, colNo } from './mapping.js';

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
    if (tc.status1) row.getCell(col.pre1).value = tc.status1;
    if (tc.status2) row.getCell(col.pre2).value = tc.status2;
    if (tc.evidence && tc.evidence.length > 0) {
      row.getCell(col.evidence).value = { text: tc.evidence.join('\n'), hyperlink: tc.evidence[0]! };
    }
    if (tc.comment) row.getCell(col.comment).value = tc.comment;
  });

  const counts = { P: 0, F: 0, PE: 0 };
  for (const tc of rows) {
    const latest = tc.status2 ?? tc.status1;
    if (latest) counts[latest]++;
  }
  ws.getCell(map.summary.pass).value = counts.P;
  ws.getCell(map.summary.fail).value = counts.F;
  ws.getCell(map.summary.pending).value = counts.PE;
  ws.getCell(map.summary.total).value = counts.P + counts.F + counts.PE;

  wb.calcProperties.fullCalcOnLoad = true;
  await wb.xlsx.writeFile(outPath);
}
