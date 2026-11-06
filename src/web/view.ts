import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import { STAGES, STAGE_LABELS } from '../domain/types.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export { STAGE_LABELS };
export const STATUS_LABELS: Record<string, string> = {
  running: 'Đang chạy', awaiting_approval: 'Chờ duyệt', awaiting_customer: 'Chờ khách hàng', paused: 'Tạm dừng',
  needs_human: 'Cần người xử lý', failed: 'Lỗi', done: 'Hoàn thành', cancelled: 'Đã hủy',
  awaiting_seat: 'Chờ kết nối Claude',
};
export const TASK_STATUS_LABELS: Record<string, string> = {
  todo: 'Chưa làm', in_progress: 'Đang làm', in_review: 'Đang review', done: 'Xong', failed: 'Lỗi', needs_human: 'Cần người xử lý', cancelled: 'Đã hủy',
};
export const STAGE_RUN_LABELS: Record<string, string> = {
  running: 'Đang chạy', done: 'Xong', failed: 'Lỗi', cancelled: 'Đã dừng', paused: 'Tạm dừng', needs_human: 'Cần người xử lý', awaiting_seat: 'Chờ kết nối Claude',
};
export const JOB_KIND_LABELS: Record<string, string> = { run_stage: 'Chạy giai đoạn', run_task: 'Chạy task' };
export const JOB_STATUS_LABELS: Record<string, string> = { queued: 'Đang xếp hàng', running: 'Đang chạy', done: 'Xong', failed: 'Lỗi', paused: 'Đang chờ' };
/** What a stage handler decided (StageOutcome.kind). */
export const OUTCOME_LABELS: Record<string, string> = {
  next: 'Sang bước tiếp theo', wait: 'Chờ các task hoàn tất', goto: 'Quay lại giai đoạn trước', await_customer: 'Chờ khách hàng',
  needs_human: 'Cần người xử lý', retry_later: 'Thử lại sau', fail: 'Lỗi',
};
export const SYS_ROLE_LABELS: Record<string, string> = { admin: 'Quản trị viên', cto: 'CTO', head: 'Trưởng phòng', deputy: 'Phó phòng', member: 'Thành viên' };
export const PROJECT_ROLE_LABELS: Record<string, string> = { PM: 'PM', BA: 'BA', SE: 'SE (thiết kế)', DEV: 'Dev', REVIEWER: 'Reviewer', TESTER: 'Tester' };
export const SEAT_STATE_LABELS: Record<string, string> = { connected: 'Đã kết nối', expired: 'Đã hết hạn đăng nhập', disconnected: 'Chưa kết nối', unknown: 'Chưa rõ' };
export const CR_STATUS_LABELS: Record<string, string> = {
  proposed: 'Đề xuất', pending: 'Chờ phân tích', analyzing: 'Đang phân tích', awaiting_decision: 'Chờ quyết định',
  accepted: 'Đã chấp nhận', rejected: 'Đã từ chối', applied: 'Đã áp dụng',
};
export const CR_KIND_LABELS: Record<string, string> = { add: 'Thêm mới', modify: 'Sửa đổi', remove: 'Loại bỏ', nfr: 'Phi chức năng', other: 'Khác' };
export const CR_SOURCE_LABELS: Record<string, string> = { staff: 'Nhân viên', customer: 'Khách hàng' };
export const RUN_MODE_LABELS: Record<string, string> = { auto: 'Tự động', review: 'Duyệt từng bước' };

export const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const eta = new Eta({ views: `${ROOT}views`, cache: true, autoEscape: true });
const helpers = { TASK_STATUS_LABELS, STAGE_RUN_LABELS, JOB_KIND_LABELS, JOB_STATUS_LABELS, OUTCOME_LABELS, SYS_ROLE_LABELS, PROJECT_ROLE_LABELS, SEAT_STATE_LABELS, CR_STATUS_LABELS, CR_KIND_LABELS, CR_SOURCE_LABELS, STAGES, STAGE_LABELS, STATUS_LABELS, RUN_MODE_LABELS, fmtTime, fmtSize };

export interface LayoutData { user?: { username: string; role: string; sysRole?: string } | undefined; mode: string; title: string; flash?: string | undefined; flashKind?: string }

/** Renders `views/<name>.eta` inside the shared layout. */
export function render(name: string, layout: LayoutData, data: Record<string, unknown> = {}): string {
  const body = eta.render(name, { ...helpers, ...layout, ...data });
  return eta.render('layout', { ...helpers, ...layout, body });
}
export function renderPartial(name: string, data: Record<string, unknown> = {}): string {
  return eta.render(name, { ...helpers, ...data });
}
