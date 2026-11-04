import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { exportQuestions, importAnswers } from '../../src/office/questions-xlsx.js';
import type { Question } from '../../src/domain/types.js';

const qs: Question[] = [
  { id: 'Q-01', category: 'Chức năng', question: 'Ai được duyệt?', why: 'Phân quyền', type: 'single', options: ['Trưởng phòng', 'Giám đốc'], suggested_answer: 'Trưởng phòng', priority: 'must' },
  { id: 'Q-02', category: 'Dữ liệu', question: 'Dung lượng tối đa?', why: 'Thiết kế lưu trữ', type: 'text', options: [], suggested_answer: '', priority: 'should' },
  { id: 'Q-03', category: 'Khác', question: 'Ghi chú thêm?', why: 'Khác', type: 'text', options: [], suggested_answer: '', priority: 'should' },
];

async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe('questions-xlsx', () => {
  it('exports header and rows', async () => {
    const wb = await load(await exportQuestions('REQ-001', 2, qs, new Map([['Q-01', 'Giám đốc']])));
    const ws = wb.getWorksheet('Câu hỏi')!;
    expect(ws.getCell('A1').value).toBe('Bộ câu hỏi làm rõ yêu cầu REQ-001 – vòng 2');
    expect(ws.getRow(3).values).toEqual([undefined, 'ID', 'Nhóm', 'Câu hỏi', 'Lý do cần hỏi', 'Lựa chọn', 'Đề xuất', 'Trả lời của khách hàng', 'Ghi chú']);
    expect(ws.getCell('A4').value).toBe('Q-01');
    expect(ws.getCell('C4').value).toBe('Ai được duyệt?');
    expect(ws.getCell('E4').value).toBe('Trưởng phòng\nGiám đốc');
    expect(ws.getCell('F4').value).toBe('Trưởng phòng');
    expect(ws.getCell('G4').value).toBe('Giám đốc');
    expect(ws.getCell('A6').value).toBe('Q-03');
    expect((ws.getCell('G4').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFFF00');
    expect(ws.getCell('G4').alignment?.wrapText).toBe(true);
    expect(ws.getCell('G4').dataValidation.type).toBe('list');
    expect(ws.getCell('G5').dataValidation?.type).toBeUndefined();
  });

  it('roundtrip answers', async () => {
    const buf = await exportQuestions('REQ-001', 1, qs, new Map([['Q-01', 'Giám đốc'], ['Q-02', '10 GB']]));
    const r = await importAnswers(buf);
    expect(r.answers).toEqual([{ id: 'Q-01', answer: 'Giám đốc' }, { id: 'Q-02', answer: '10 GB' }]);
    expect(r.unknownRows).toBe(0);
  });

  it('imports answers by id regardless of row order', async () => {
    const wb = await load(await exportQuestions('REQ-001', 1, qs, new Map()));
    const ws = wb.getWorksheet('Câu hỏi')!;
    ws.getRow(4).getCell(1).value = 'Q-03';
    ws.getRow(4).getCell(7).value = '  ghi chú  ';
    ws.getRow(6).getCell(1).value = 'Q-01';
    ws.getRow(6).getCell(7).value = 'Giám đốc';
    ws.getRow(8).getCell(1).value = 'Q-02'; // after two blank rows
    ws.getRow(8).getCell(7).value = '5 GB';
    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await importAnswers(out);
    const m = new Map(r.answers.map((a) => [a.id, a.answer]));
    expect(m.get('Q-03')).toBe('ghi chú');
    expect(m.get('Q-01')).toBe('Giám đốc');
    expect(m.get('Q-02')).toBe('5 GB');
    expect(r.answers).toHaveLength(3);
  });

  it('ignores blank answers', async () => {
    const wb = await load(await exportQuestions('REQ-001', 1, qs, new Map()));
    const ws = wb.getWorksheet('Câu hỏi')!;
    ws.getCell('G4').value = '   ';
    ws.getCell('G5').value = 'ok';
    const r = await importAnswers(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.answers).toEqual([{ id: 'Q-02', answer: 'ok' }]);
  });

  it('reads rich text cell', async () => {
    const wb = await load(await exportQuestions('REQ-001', 1, qs, new Map()));
    const ws = wb.getWorksheet('Câu hỏi')!;
    ws.getCell('G4').value = { richText: [{ text: 'Giám ' }, { text: 'đốc', font: { bold: true } }] };
    ws.getCell('G5').value = { formula: '"a"&"b"', result: 'ab' };
    const r = await importAnswers(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.answers).toEqual([{ id: 'Q-01', answer: 'Giám đốc' }, { id: 'Q-02', answer: 'ab' }]);
  });

  it('normalises ids to upper case and reports duplicate ids (last wins)', async () => {
    const wb = await load(await exportQuestions('REQ-001', 1, qs, new Map()));
    const ws = wb.getWorksheet('Câu hỏi')!;
    ws.getCell('A4').value = ' q-01 ';
    ws.getCell('G4').value = 'a';
    ws.getCell('A5').value = 'Q-01';
    ws.getCell('G5').value = 'b';
    const r = await importAnswers(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.answers).toEqual([{ id: 'Q-01', answer: 'b' }]);
    expect(r.duplicateIds).toEqual(['Q-01']);
  });
});
