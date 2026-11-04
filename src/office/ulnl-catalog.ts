import { loadWorkbook } from './xlsx-load.js';
import { loadMapping, plain } from './mapping.js';

export interface UlnlType { code: string; name: string; group: string; explain: string }
export interface UlnlNonFuncType { code: string; name: string; scope: string; effort: string }
export interface UlnlCatalog { types: UlnlType[]; nonFunctions: UlnlNonFuncType[] }

const text = (v: ReturnType<typeof plain>): string => (v === null ? '' : String(v)).replace(/\s+/g, ' ').trim();

/**
 * Function type codes (sheet `DEFINE TYPE OF FUNCTION`) and non-function task codes (`DATA BASE_NON - FUNCTION`)
 * of a ULNL template, so the BREAKDOWN prompt can offer exactly the codes the template's effort lookups know.
 */
export async function readUlnlCatalog(templatePath: string): Promise<UlnlCatalog> {
  const map = (await loadMapping(templatePath)).ulnl;
  const wb = await loadWorkbook(templatePath);
  const types: UlnlType[] = [];
  const tl = map.function.typeLookup;
  const ts = wb.getWorksheet(tl.sheet);
  if (ts) {
    for (let r = tl.firstRow; r <= ts.rowCount; r++) {
      const code = text(plain(ts.getCell(`${tl.codeCol}${r}`).value));
      if (!code) continue;
      types.push({
        code,
        name: text(plain(ts.getCell(`${tl.nameCol}${r}`).value)),
        group: text(plain(ts.getCell(`${tl.groupCol ?? 'D'}${r}`).value)),
        explain: text(plain(ts.getCell(`${tl.explainCol ?? 'E'}${r}`).value)),
      });
    }
  }
  const nonFunctions: UlnlNonFuncType[] = [];
  const nl = map.nonFunction.lookup;
  const ns = wb.getWorksheet(nl.sheet);
  if (ns) {
    for (let r = nl.firstRow; r <= ns.rowCount; r++) {
      const code = text(plain(ns.getCell(`${nl.codeCol}${r}`).value));
      if (!code) continue;
      nonFunctions.push({
        code,
        name: text(plain(ns.getCell(`${nl.nameCol}${r}`).value)),
        scope: text(plain(ns.getCell(`${nl.scopeCol ?? 'D'}${r}`).value)),
        effort: text(plain(ns.getCell(`${nl.mhCol}${r}`).value)),
      });
    }
  }
  return { types, nonFunctions };
}
