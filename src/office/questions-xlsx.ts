import ExcelJS from 'exceljs';
import type { Question } from '../domain/types.js';

const SHEET = 'Câu hỏi';
const HEADERS = ['ID', 'Nhóm', 'Câu hỏi', 'Lý do cần hỏi', 'Lựa chọn', 'Đề xuất', 'Trả lời của khách hàng', 'Ghi chú'];
const ANSWER_COL = 7;
const FIRST_DATA_ROW = 4;

export async function exportQuestions(reqId: string, round: number, qs: Question[], answers: Map<string, string>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = [10, 16, 50, 40, 30, 28, 45, 30].map((width) => ({ width }));

  ws.mergeCells('A1:H1');
  const title = ws.getCell('A1');
  title.value = `Bộ câu hỏi làm rõ yêu cầu ${reqId} – vòng ${round}`;
  title.font = { bold: true, size: 14 };
  title.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 26;

  const header = ws.getRow(3);
  HEADERS.forEach((h, i) => {
    const c = header.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
    c.alignment = { vertical: 'middle', wrapText: true };
    c.border = border();
  });

  qs.forEach((q, i) => {
    const row = ws.getRow(FIRST_DATA_ROW + i);
    row.getCell(1).value = q.id;
    row.getCell(2).value = q.category;
    row.getCell(3).value = q.question;
    row.getCell(4).value = q.why;
    row.getCell(5).value = q.options.join('\n');
    row.getCell(6).value = q.suggested_answer;
    const a = answers.get(q.id);
    if (a) row.getCell(ANSWER_COL).value = a;
    row.getCell(8).value = '';
    for (let c = 1; c <= 8; c++) {
      const cell = row.getCell(c);
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = border();
    }
    row.getCell(ANSWER_COL).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
    // Inline list validation only works without commas and up to 255 chars.
    const joined = q.options.join(',');
    if (q.options.length > 0 && !q.options.some((o) => o.includes(',') || o.includes('"')) && joined.length <= 255) {
      row.getCell(ANSWER_COL).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${joined}"`],
        showErrorMessage: true,
        // multi-choice answers may combine several options, so only warn
        errorStyle: q.type === 'multi' ? 'warning' : 'stop',
        errorTitle: 'Giá trị không hợp lệ',
        error: 'Vui lòng chọn một trong các lựa chọn.',
      };
    }
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function border(): Partial<ExcelJS.Borders> {
  const s = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } };
  return { top: s, left: s, bottom: s, right: s };
}

function cellText(v: ExcelJS.CellValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((r) => r.text ?? '').join('');
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if ('formula' in o || 'sharedFormula' in o) return '';
    if ('text' in o) return cellText(o.text as ExcelJS.CellValue);
    if ('error' in o) return '';
  }
  return String(v);
}

/**
 * Reads customer answers keyed by ID. unknownRows counts rows that carry an answer but cannot be
 * mapped to a question: no ID, or an ID that is not of the form Q-<n>.
 */
export async function importAnswers(buf: Buffer): Promise<{ answers: { id: string; answer: string }[]; unknownRows: number; duplicateIds: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(SHEET) ?? wb.worksheets[0];
  if (!ws) return { answers: [], unknownRows: 0, duplicateIds: [] };

  let headerRow = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (cellText(ws.getRow(r).getCell(1).value).trim().toUpperCase() === 'ID') {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) return { answers: [], unknownRows: 0, duplicateIds: [] };

  let answerCol = ANSWER_COL;
  ws.getRow(headerRow).eachCell((c, n) => {
    if (cellText(c.value).trim().toLowerCase() === HEADERS[6]!.toLowerCase()) answerCol = n;
  });

  const byId = new Map<string, string>();
  let unknownRows = 0;
  const duplicateIds = new Set<string>();
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const id = cellText(row.getCell(1).value).trim().toUpperCase();
    const answer = cellText(row.getCell(answerCol).value).trim();
    if (!answer) continue;
    if (!/^Q-\d+$/i.test(id)) {
      unknownRows++;
      continue;
    }
    if (byId.has(id)) duplicateIds.add(id); // last one wins
    byId.set(id, answer);
  }
  return { answers: [...byId].map(([id, answer]) => ({ id, answer })), unknownRows, duplicateIds: [...duplicateIds] };
}
