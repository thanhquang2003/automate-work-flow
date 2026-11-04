import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';

/**
 * Load a workbook with exceljs. Templates produced by other tools (e.g. openpyxl) name comment/VML
 * parts differently (xl/comments/commentN.xml, absolute rel targets) which exceljs cannot resolve;
 * normalise those names to the layout exceljs expects before loading.
 */
export async function loadWorkbook(path: string): Promise<ExcelJS.Workbook> {
  const zip = await JSZip.loadAsync(await readFile(path));
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    let m = name.match(/^xl\/comments\/comment(\d+)\.xml$/);
    if (m) {
      zip.file(`xl/comments${m[1]}.xml`, await zip.file(name)!.async('nodebuffer'));
      zip.remove(name);
      changed = true;
      continue;
    }
    m = name.match(/^xl\/drawings\/commentsDrawing(\d+)\.vml$/);
    if (m) {
      zip.file(`xl/drawings/vmlDrawing${m[1]}.vml`, await zip.file(name)!.async('nodebuffer'));
      zip.remove(name);
      changed = true;
    }
  }
  for (const name of Object.keys(zip.files)) {
    if (!/^xl\/worksheets\/_rels\/.*\.rels$/.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    const fixed = xml
      .replace(/Target="\/xl\/comments\/comment(\d+)\.xml"/g, 'Target="../comments$1.xml"')
      .replace(/Target="\/xl\/drawings\/commentsDrawing(\d+)\.vml"/g, 'Target="../drawings/vmlDrawing$1.vml"');
    if (fixed !== xml) {
      zip.file(name, fixed);
      changed = true;
    }
  }
  const wb = new ExcelJS.Workbook();
  if (changed) await wb.xlsx.load((await zip.generateAsync({ type: 'nodebuffer' })) as unknown as ArrayBuffer);
  else await wb.xlsx.readFile(path);
  return wb;
}
