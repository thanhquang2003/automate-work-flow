import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrKind, ProjectKind, SoftwareType } from '../domain/types.js';
import type { StageContext } from './pipeline.js';

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
  /** "Thay đổi đã chấp nhận" section (changesSection); also keeps the role's change-only block of the template. */
  changes?: string;
  outputs?: PromptOutput[];
}

/**
 * Role templates may hold a block that only applies after accepted change requests, between these markers.
 * buildPrompt keeps its content when `extras.changes` is set and drops the whole block otherwise.
 */
export const CHANGE_BLOCK_START = '<!-- khi-co-thay-doi -->';
export const CHANGE_BLOCK_END = '<!-- /khi-co-thay-doi -->';

const CR_KIND_LABEL: Record<CrKind, string> = { add: 'Thêm mới', modify: 'Sửa đổi', remove: 'Bỏ chức năng', nfr: 'Phi chức năng', other: 'Khác' };
const listOr = (xs: string[], none = '(không có)'): string => (xs.length ? xs.join(', ') : none);

/**
 * "## Thay đổi đã chấp nhận": every accepted, not yet applied CR (id, title, kind, impact summary, scope delta, path of
 * impact.md) and the shared incremental-update rules of spec §4.4.
 */
export function changesSection(ctx: Pick<StageContext, 'changes' | 'baseline' | 'ws'>): string {
  const lines = [
    '## Thay đổi đã chấp nhận',
    '',
    `Yêu cầu đã được thay đổi sau khi bắt đầu làm. Phiên bản yêu cầu hiện tại: **v${ctx.baseline}**. Các yêu cầu thay đổi (CR) dưới đây đã được chấp nhận và đã cập nhật trạng thái phạm vi trong DevFlow; đầu ra của bạn phải phản ánh chúng.`,
  ];
  for (const { cr, impact } of ctx.changes) {
    lines.push(
      '',
      `### ${cr.id} — ${cr.title} (${CR_KIND_LABEL[cr.kind] ?? cr.kind})`,
      '',
      `- Tóm tắt tác động: ${impact.summary}`,
      `- Thêm: ${listOr(impact.scope.add.map(a => `${a.name} — ${a.description}`))}`,
      `- Sửa: ${listOr(impact.scope.modify.map(m => `${m.feature_id}: ${m.change}`))}`,
      `- Bỏ: ${listOr(impact.scope.remove)}`,
      `- Chức năng / task / test case bị ảnh hưởng: ${listOr(impact.affected.features)} / ${listOr(impact.affected.tasks)} / ${listOr(impact.affected.test_cases)}`,
      `- Nỗ lực thay đổi ước tính: ${impact.effort_delta_mh >= 0 ? '+' : ''}${impact.effort_delta_mh} MH`,
      `- Báo cáo tác động đầy đủ (đọc trước khi làm): \`${join(ctx.ws.devflowDir, 'changes', cr.id, 'impact.md')}\``,
    );
  }
  lines.push(
    '',
    '### Quy tắc khi cập nhật theo thay đổi',
    '',
    '1. **Cập nhật, không viết lại từ đầu**: đọc file đầu ra hiện có, giữ nguyên ID hiện có, không đổi nội dung các phần tử không bị ảnh hưởng.',
    '2. **Phần tử bị bỏ** → vẫn giữ trong file, thêm trường `"scope_status": "cancelled"` (mặc định là `"active"`). Không xóa, không tái sử dụng ID của phần tử đã hủy.',
    '3. **Phần tử mới** → ID tiếp nối ID lớn nhất hiện có (ví dụ F-05, T-09, TC-<code>-NN tiếp theo).',
    '4. Phần tử đã hủy không được làm, không được tham chiếu như phạm vi còn hiệu lực.',
  );
  return lines.join('\n');
}

/** Keeps (changes) or drops (no changes) the change-only blocks of a role template. */
function applyChangeBlocks(tpl: string, keep: boolean): string {
  const re = new RegExp(`[ \\t]*${CHANGE_BLOCK_START}[ \\t]*\\n?([\\s\\S]*?)[ \\t]*${CHANGE_BLOCK_END}[ \\t]*\\n?`, 'g');
  return tpl.replace(re, (_m, body: string) => (keep ? body : ''));
}

const SOFTWARE_LABEL: Record<SoftwareType, string> = { web: 'Web', mobile: 'Mobile', api: 'API', background: 'Tiến trình ngầm' };
const orNone = (s: string): string => (s.trim() ? s.trim() : '(không ghi)');

/**
 * Reads `prompts/<role>.md` (first line `ROLE: <role>`), substitutes `{{var}}` (every placeholder must be supplied)
 * and appends the request context, input files, reviewer feedback and the "Đầu ra bắt buộc" section.
 */
export function buildPrompt(role: string, vars: Record<string, string>, extras: PromptExtras = {}): string {
  if (!/^[\w-]+$/.test(role)) throw new Error(`Invalid prompt role: ${role}`);
  const tpl = applyChangeBlocks(readFileSync(resolve(PROMPTS_DIR, `${role}.md`), 'utf8').replace(/\r\n/g, '\n'), !!extras.changes);
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
  if (extras.changes) parts.push(extras.changes);
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
