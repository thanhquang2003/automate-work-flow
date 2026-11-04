import type ExcelJS from 'exceljs';
import { loadWorkbook } from './xlsx-load.js';
import { loadMapping, plain, clearRow, colNo, type UlnlNonFunctionMapping } from './mapping.js';

export interface UlnlFeature {
  code: string;
  name: string;
  description: string;
  type_code: string;
  unit_test: boolean;
  note: string;
}

export interface UlnlNonFunc {
  code: string;
  name: string;
  description: string;
  effort_mh?: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Re-points relative row references of a template formula from one row to another ($-anchored rows are kept). */
function shiftFormula(f: string, fromRow: number, toRow: number): string {
  return f.replace(new RegExp(`(\\$?[A-Z]{1,3})${fromRow}(?!\\d)`, 'g'), `$1${toRow}`);
}

function formulaOf(cell: ExcelJS.Cell): string | undefined {
  const v = cell.value as { formula?: string } | null;
  return v && typeof v === 'object' && typeof v.formula === 'string' ? v.formula : undefined;
}

export async function writeUlnl(templatePath: string, features: UlnlFeature[], nonFunc: UlnlNonFunc[], reqTitle: string, outPath: string): Promise<void> {
  const map = (await loadMapping(templatePath)).ulnl;
  const wb = await loadWorkbook(templatePath);
  const fn = map.function;
  const ws = wb.getWorksheet(fn.sheet);
  if (!ws) throw new Error(`Sheet not found: ${fn.sheet}`);

  // ---- lookups
  const typeNames = new Map<string, string>();
  const tl = wb.getWorksheet(fn.typeLookup.sheet);
  if (tl) {
    for (let r = fn.typeLookup.firstRow; r <= tl.rowCount; r++) {
      const code = plain(tl.getCell(`${fn.typeLookup.codeCol}${r}`).value);
      if (code !== null && code !== '') typeNames.set(String(code).trim(), String(plain(tl.getCell(`${fn.typeLookup.nameCol}${r}`).value) ?? ''));
    }
  }
  const effort = new Map<string, number>(); // `${type}|${work}`
  const el = wb.getWorksheet(fn.effortLookup.sheet);
  if (el) {
    for (let r = fn.effortLookup.firstRow; r <= el.rowCount; r++) {
      const type = plain(el.getCell(`${fn.effortLookup.typeCol}${r}`).value);
      const work = plain(el.getCell(`${fn.effortLookup.workCol}${r}`).value);
      const mh = plain(el.getCell(`${fn.effortLookup.mhCol}${r}`).value);
      if (type && work && typeof mh === 'number') effort.set(`${String(type).trim()}|${String(work).trim()}`, mh);
    }
  }

  // ---- title: EFFORT_FUNCTION!A2 is a formula pointing at TOTAL EFFORT!A3
  const totalSheet = wb.getWorksheet(map.title.sourceSheet);
  if (totalSheet) totalSheet.getCell(map.title.sourceCell).value = reqTitle;
  ws.getCell(map.title.cell).value = { formula: `'${map.title.sourceSheet}'!${map.title.sourceCell}`, result: reqTitle };

  // ---- function rows
  const c = Object.fromEntries(Object.entries(fn.columns).map(([k, v]) => [k, colNo(v)])) as Record<keyof typeof fn.columns, number>;
  const first = fn.firstDataRow;
  const maxCol = colNo('X');
  const lastData = Math.max(first + features.length - 1, fn.minLastRow);

  const styles = new Map<number, Partial<ExcelJS.Style>>();
  for (let col = 1; col <= maxCol; col++) styles.set(col, { ...ws.getRow(first).getCell(col).style });
  const calcCols = [c.sol, c.dev, c.ut, c.test, c.total, c.typeName, ...['N', 'O', 'P', 'Q', 'R'].map(colNo)];
  const tplFormulas = new Map<number, string>();
  for (const col of calcCols) {
    const f = formulaOf(ws.getRow(first).getCell(col));
    if (f) tplFormulas.set(col, f);
  }
  const validation = ws.getRow(first).getCell(c.utFlag).dataValidation;

  for (let r = first; r <= lastData; r++) clearRow(ws, r, 1, maxCol);

  const sums = { sol: 0, dev: 0, ut: 0, test: 0, total: 0 };
  features.forEach((f, i) => {
    const r = first + i;
    const row = ws.getRow(r);
    for (const [col, st] of styles) row.getCell(col).style = { ...st };
    if (r > fn.minLastRow && validation?.type) row.getCell(c.utFlag).dataValidation = { ...validation };

    const typeCode = f.type_code.trim();
    const sol = effort.get(`${typeCode}|Solution`) ?? 0;
    const dev = effort.get(`${typeCode}|Development`) ?? 0;
    const test = effort.get(`${typeCode}|Test`) ?? 0;
    const ut = f.unit_test ? round3(dev * fn.unitTestRatio) : 0;
    const total = round3(sol + dev + ut + test);
    sums.sol += sol;
    sums.dev += dev;
    sums.ut += ut;
    sums.test += test;
    sums.total += total;

    row.getCell(c.no).value = i + 1;
    row.getCell(c.code).value = f.code;
    row.getCell(c.name).value = f.name;
    row.getCell(c.desc).value = f.description;
    row.getCell(c.typeCode).value = typeCode;
    row.getCell(c.utFlag).value = f.unit_test ? 'Yes' : 'No';
    for (const letter of ['S', 'T', 'U', 'W']) row.getCell(colNo(letter)).value = 0; // reuse % and outsource effort
    row.getCell(c.note).value = f.note || null;

    const results = new Map<number, string | number>([
      [c.sol, sol], [c.dev, dev], [c.ut, ut], [c.test, test], [c.total, total],
      [c.typeName, typeNames.get(typeCode) ?? ''],
      [colNo('N'), sol], [colNo('O'), dev], [colNo('P'), ut], [colNo('Q'), test], [colNo('R'), total],
    ]);
    for (const [col, tpl] of tplFormulas) {
      row.getCell(col).value = { formula: shiftFormula(tpl, first, r), result: results.get(col) };
    }
  });

  // totals row: SUM ranges follow the last data row
  const totalsRow = ws.getRow(fn.totalsRow);
  const totalResults: Record<string, number> = { E: sums.sol, F: sums.dev, G: sums.ut, H: sums.test, N: sums.sol, O: sums.dev, P: sums.ut, Q: sums.test };
  for (const [letter, res] of Object.entries(totalResults)) {
    totalsRow.getCell(letter).value = { formula: `SUM(${letter}${first}:${letter}${lastData})`, result: round3(res) };
  }
  totalsRow.getCell('I').value = { formula: 'SUM(E8:H8)', result: round3(sums.sol + sums.dev + sums.ut + sums.test) };
  totalsRow.getCell('R').value = { formula: 'SUM(N8:Q8)', result: round3(sums.sol + sums.dev + sums.ut + sums.test) };

  const nws = wb.getWorksheet(map.nonFunction.sheet);
  if (nws) writeNonFunc(wb, nws, map.nonFunction, nonFunc, sums.total);

  wb.calcProperties.fullCalcOnLoad = true;
  await wb.xlsx.writeFile(outPath);
}

function writeNonFunc(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, m: UlnlNonFunctionMapping, items: UlnlNonFunc[], functionTotal: number): void {
  const col = Object.fromEntries(Object.entries(m.columns).map(([k, v]) => [k, colNo(v)])) as Record<keyof typeof m.columns, number>;
  const first = m.firstDataRow;
  const totalRow = first + m.minRows; // the "Total" row of the template
  const extra = Math.max(0, items.length - m.minRows);

  if (extra > 0) {
    // rows below the total carry merges that exceljs does not shift on splice
    const below = (ws.model.merges ?? []).filter((x: string) => Number(/\d+/.exec(x)![0]) >= totalRow);
    for (const mg of below) ws.unMergeCells(mg);
    const styleRow = ws.getRow(totalRow - 1);
    const styleCopy = [1, 2, 3, 4, 5].map((cc) => ({ ...styleRow.getCell(cc).style }));
    ws.spliceRows(totalRow, 0, ...Array.from({ length: extra }, () => [] as unknown[]));
    for (let i = 0; i < extra; i++) styleCopy.forEach((st, k) => (ws.getRow(totalRow + i).getCell(k + 1).style = { ...st }));
    for (const mg of below) ws.mergeCells(mg.replace(/\d+/g, (d: string) => String(Number(d) + extra)));
  }

  const lookup = wb.getWorksheet(m.lookup.sheet);
  const byCode = new Map<string, { name: string; mh: string | number | boolean | null }>();
  if (lookup) {
    for (let r = m.lookup.firstRow; r <= lookup.rowCount; r++) {
      const code = plain(lookup.getCell(`${m.lookup.codeCol}${r}`).value);
      if (code) byCode.set(String(code).trim(), { name: String(plain(lookup.getCell(`${m.lookup.nameCol}${r}`).value) ?? ''), mh: plain(lookup.getCell(`${m.lookup.mhCol}${r}`).value) });
    }
  }

  let sum = 0;
  for (let i = 0; i < Math.max(items.length, m.minRows); i++) {
    const row = ws.getRow(first + i);
    for (let cc = 1; cc <= 5; cc++) row.getCell(cc).value = null;
    const it = items[i];
    if (!it) continue;
    const ref = byCode.get(it.code.trim());
    row.getCell(col.no).value = i + 1;
    row.getCell(col.code).value = it.code;
    row.getCell(col.name).value = it.name || ref?.name || '';
    row.getCell(col.desc).value = it.description || null;
    const pct = typeof ref?.mh === 'string' ? /(\d+(?:\.\d+)?)\s*%/.exec(ref.mh) : null;
    if (typeof it.effort_mh === 'number') {
      row.getCell(col.effort).value = it.effort_mh;
      sum += it.effort_mh;
    } else if (typeof ref?.mh === 'number') {
      row.getCell(col.effort).value = ref.mh;
      sum += ref.mh;
    } else if (pct) {
      // template convention (e.g. PM = 10% of the function effort): keep it a live formula
      const ratio = Number(pct[1]) / 100;
      const res = round3(functionTotal * ratio);
      row.getCell(col.effort).value = { formula: `EFFORT_FUNCTION!I8*${ratio}`, result: res };
      sum += res;
    } else {
      row.getCell(col.effort).value = 0;
    }
  }

  const newTotalRow = totalRow + extra;
  const eCol = m.columns.effort;
  ws.getCell(`${eCol}${newTotalRow}`).value = { formula: `SUM(${eCol}${first}:${eCol}${newTotalRow - 1})`, result: round3(sum) };
  ws.getCell('D6').value = { formula: `${eCol}${newTotalRow}`, result: round3(sum) };
  const total = wb.getWorksheet('TOTAL EFFORT');
  const f = total ? formulaOf(total.getCell('F10')) : undefined;
  if (total && f) total.getCell('F10').value = { formula: f.replace(/!E\d+/, `!E${newTotalRow}`), result: round3(sum) };
}
