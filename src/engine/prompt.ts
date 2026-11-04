import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectKind, SoftwareType } from '../domain/types.js';

/** prompts/ at the app root (src/engine or dist/engine → ../../prompts). */
export const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts');

export interface PromptRequest {
  id: string;
  title: string;
  description: string;
  perfReq: string;
  nonfuncReq: string;
  softwareTypes: SoftwareType[];
  projectKind: ProjectKind;
}

export interface PromptOutput {
  /** Absolute path of the file Claude must write. */
  path: string;
  description: string;
  /** JSON shape example, rendered as a fenced json block. */
  example?: unknown;
}

export interface PromptExtras {
  request?: PromptRequest;
  /** Absolute paths of the input files (attachments). */
  inputs?: string[];
  /** Reviewer feedback from a rejected run. */
  feedback?: string;
  outputs?: PromptOutput[];
}

const SOFTWARE_LABEL: Record<SoftwareType, string> = { web: 'Web', mobile: 'Mobile', api: 'API', background: 'Tiến trình ngầm' };
const orNone = (s: string): string => (s.trim() ? s.trim() : '(không ghi)');

/**
 * Reads `prompts/<role>.md` (first line `ROLE: <role>`), substitutes `{{var}}` (every placeholder must be supplied)
 * and appends the request context, input files, reviewer feedback and the "Đầu ra bắt buộc" section.
 */
export function buildPrompt(role: string, vars: Record<string, string>, extras: PromptExtras = {}): string {
  if (!/^[\w-]+$/.test(role)) throw new Error(`Invalid prompt role: ${role}`);
  const tpl = readFileSync(resolve(PROMPTS_DIR, `${role}.md`), 'utf8').replace(/\r\n/g, '\n');
  const missing = new Set<string>();
  const body = tpl.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (!(name in vars)) { missing.add(name); return ''; }
    return vars[name]!;
  });
  if (missing.size) throw new Error(`Prompt ${role}.md thiếu biến: ${[...missing].join(', ')}`);

  const parts = [body.trimEnd()];
  const r = extras.request;
  if (r) {
    parts.push([
      '## Thông tin yêu cầu',
      '',
      `- Mã yêu cầu: ${r.id}`,
      `- Tiêu đề: ${r.title}`,
      `- Loại dự án: ${r.projectKind === 'new' ? 'Dự án mới' : 'Thêm/sửa chức năng trên dự án có sẵn'}`,
      `- Loại phần mềm: ${r.softwareTypes.length ? r.softwareTypes.map(t => SOFTWARE_LABEL[t] ?? t).join(', ') : '(không ghi)'}`,
      '',
      '### Mô tả yêu cầu (nguyên văn từ khách hàng/nhân viên)',
      '',
      orNone(r.description),
      '',
      '### Yêu cầu hiệu năng',
      '',
      orNone(r.perfReq),
      '',
      '### Yêu cầu phi chức năng',
      '',
      orNone(r.nonfuncReq),
    ].join('\n'));
  }
  if (extras.inputs) {
    parts.push([
      '## File đầu vào (đọc toàn bộ trước khi làm)',
      '',
      ...(extras.inputs.length ? extras.inputs.map(p => `- ${p}`) : ['(không có file đính kèm)']),
    ].join('\n'));
  }
  if (extras.feedback?.trim()) {
    parts.push([
      '## Nhận xét của người duyệt cho lần chạy trước (BẮT BUỘC xử lý hết)',
      '',
      extras.feedback.trim(),
      '',
      'Đọc lại đầu ra hiện có, sửa đúng các điểm trên, giữ nguyên phần đã đúng.',
    ].join('\n'));
  }
  if (extras.outputs?.length) {
    const lines = ['## Đầu ra bắt buộc', '', 'Phải ghi đúng các file sau (đường dẫn tuyệt đối, ghi đè nếu đã có). DevFlow sẽ đọc và kiểm tra tự động; thiếu file hoặc sai định dạng thì lần chạy bị coi là hỏng.', ''];
    for (const o of extras.outputs) {
      lines.push(`- \`${o.path}\` — ${o.description}`);
      if (o.example !== undefined) lines.push('', '  Định dạng JSON (UTF-8, không có chú thích, không bọc trong markdown):', '', '```json', JSON.stringify(o.example, null, 2), '```', '');
    }
    lines.push('', 'Khi xong, trả lời ngắn gọn (1–3 câu) những gì đã ghi. Không hỏi lại người dùng: không có ai trả lời trong phiên chạy tự động này.');
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n') + '\n';
}
