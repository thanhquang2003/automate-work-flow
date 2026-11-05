import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import { STAGES, STAGE_LABELS } from '../domain/types.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export { STAGE_LABELS };
export const STATUS_LABELS: Record<string, string> = {
  running: 'Đang chạy', awaiting_approval: 'Chờ duyệt', awaiting_customer: 'Chờ khách hàng', paused: 'Tạm dừng',
  needs_human: 'Cần người xử lý', failed: 'Lỗi', done: 'Hoàn thành', cancelled: 'Đã hủy',
};
export const RUN_MODE_LABELS: Record<string, string> = { auto: 'Tự động', review: 'Duyệt từng bước' };

export const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const eta = new Eta({ views: `${ROOT}views`, cache: true, autoEscape: true });
const helpers = { STAGES, STAGE_LABELS, STATUS_LABELS, RUN_MODE_LABELS, fmtTime, fmtSize };

export interface LayoutData { user?: { username: string; role: string } | undefined; mode: string; title: string; flash?: string | undefined; flashKind?: string }

/** Renders `views/<name>.eta` inside the shared layout. */
export function render(name: string, layout: LayoutData, data: Record<string, unknown> = {}): string {
  const body = eta.render(name, { ...helpers, ...layout, ...data });
  return eta.render('layout', { ...helpers, ...layout, body });
}
export function renderPartial(name: string, data: Record<string, unknown> = {}): string {
  return eta.render(name, { ...helpers, ...data });
}
