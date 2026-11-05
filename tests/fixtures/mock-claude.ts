import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunOpts, RunResult } from '../../src/claude/runner.js';
import { outputPaths, roleOf } from '../engine/stage-helpers.js';

/** Fixture outputs of every mock Claude role used by the end-to-end tests. */

export const ANALYSIS_MD = '# Tổng quan yêu cầu\n\nNội dung phân tích.\n\n# Chỗ hổng đã phát hiện\n\nKhông.\n\n# Câu hỏi mở và giả định\n\nKhông.\n';
export const FEATURES = {
  features: [
    { id: 'F-01', code: 'DANGNHAP', name: 'Đăng nhập', description: 'Đăng nhập hệ thống', type_code: 'CN_WEB1', unit_test: true, note: 'TKCT: Thiết kế chi tiết > DANGNHAP', kind: 'function' },
    { id: 'F-02', code: 'BAOCAO', name: 'Báo cáo', description: 'Báo cáo doanh thu', type_code: 'BC2', unit_test: false, note: '', kind: 'function' },
    { id: 'NF-01', code: 'PM', name: 'Quản lý dự án', description: 'PM', type_code: 'PM', unit_test: false, note: '', kind: 'nonfunction' },
  ],
};
export const TKCT_MD = `# TỔNG QUAN
## Tổng quan dự án
Dự án mẫu.
## Yêu cầu chức năng
- DANGNHAP
## Yêu cầu phi chức năng
Không.
## Yêu cầu hiệu năng
100 người dùng đồng thời.
## Yêu cầu khác
Không.
# THIẾT KẾ TỔNG THỂ
## Mô hình tổng thể
Sơ đồ: Mô hình tổng thể
\`\`\`mermaid
graph TD; A-->B
\`\`\`
## Danh sách kết nối
| Nguồn | Đích |
|---|---|
| Web | API |
# THIẾT KẾ CHI TIẾT
## Thiết kế giao tiếp
REST.
## Cơ sở dữ liệu
Xem TKDB.
## DANGNHAP - Đăng nhập
### Tổng quan
Đăng nhập.
### Đối tượng sử dụng
Người dùng.
### Giao diện
Form.
### Luồng dữ liệu
A.
### Chi tiết
B.
## BAOCAO - Báo cáo
### Tổng quan
Báo cáo.
### Đối tượng sử dụng
Quản lý.
### Giao diện
Bảng.
### Luồng dữ liệu
A.
### Chi tiết
B.
# PHỤ LỤC
## Sơ đồ luồng dữ liệu nghiệp vụ
Không.
## Câu hỏi mở và giả định
- [GIẢ ĐỊNH] Không có.
`;

export const TKDB_MD = `# GIỚI THIỆU
## Mục tiêu tài liệu
Mô tả CSDL.
## Định nghĩa thuật ngữ và các từ viết tắt
Không.
## Tài liệu tham khảo
TKCT.
## Mô tả chung
PostgreSQL.
# CƠ SỞ DỮ LIỆU
## Các mô hình quan hệ dữ liệu
Sơ đồ: ERD
### Danh sách bảng
| Bảng | Mô tả |
|---|---|
| USERS | Người dùng |
### Danh sách mã lỗi
Không.
## Bảng USERS
### Mô tả cột
| Cột | Kiểu |
|---|---|
| ID | BIGINT |
### Constraint
PK.
### Index
Không.
### Trigger
Không.
### Partitions
Không.
### Script thay đổi
\`\`\`sql
CREATE TABLE USERS(ID BIGINT PRIMARY KEY);
\`\`\`
## Script rollback
\`\`\`sql
DROP TABLE USERS;
\`\`\`
`;

export const E2E_TASKS = {
  tasks: [
    { id: 'T-01', title: 'Màn hình đăng nhập', feature_id: 'F-01', depends_on: [] },
    { id: 'T-02', title: 'Báo cáo doanh thu', feature_id: 'F-02', depends_on: ['T-01'] },
  ],
};
export const E2E_TCS = {
  test_cases: [
    { id: 'TC-DANGNHAP-01', feature_id: 'F-01', purpose: 'Đăng nhập đúng mật khẩu', data: 'admin/123', steps: '1. Mở trang\n2. Nhập', expected: 'Vào trang chủ' },
    { id: 'TC-BAOCAO-01', feature_id: 'F-02', purpose: 'Xem báo cáo', data: '', steps: '1. Mở báo cáo', expected: 'Hiện bảng' },
  ],
};
/** The test case the Tester fails on its first run only. */
export const FAILS_FIRST = 'TC-DANGNHAP-01';

const QUESTION = {
  id: 'Q-01', category: 'Chức năng', question: 'Ai được đăng nhập?', why: 'Phân quyền', type: 'single',
  options: ['Nhân viên', 'Khách hàng'], suggested_answer: 'Nhân viên', priority: 'must',
};

export interface E2eMock {
  /** Roles in call order. */
  roles: string[];
  prompts: { role: string; prompt: string }[];
  handler(opts: RunOpts): RunResult;
}

/**
 * Mock Claude for the full pipeline: every role writes its fixture (detected from the prompt's `ROLE: <role>` line).
 * Analyst asks one "must" question in round 1 and nothing afterwards; the Tester fails FAILS_FIRST on its first run only.
 */
export function e2eMock(): E2eMock {
  const roles: string[] = [];
  const prompts: { role: string; prompt: string }[] = [];
  let analysts = 0;
  let developers = 0;
  const handler = (opts: RunOpts): RunResult => {
    const role = roleOf(opts.prompt);
    roles.push(role);
    prompts.push({ role, prompt: opts.prompt });
    const dir = join(opts.cwd, 'docs', 'devflow');
    mkdirSync(dir, { recursive: true });
    const outs = outputPaths(opts.prompt);
    const write = (p: string, body: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };
    switch (role) {
      case 'explorer':
        write(join(dir, 'codebase-map.md'), '# Bản đồ mã nguồn\n\nỨng dụng mẫu.\n');
        break;
      case 'analyst':
        analysts++;
        write(join(dir, 'analysis.md'), ANALYSIS_MD);
        write(join(dir, 'questions.json'), JSON.stringify({ questions: analysts === 1 ? [QUESTION] : [] }));
        break;
      case 'analyst-breakdown':
        write(join(dir, 'features.json'), JSON.stringify(FEATURES));
        break;
      case 'architect': {
        const d = join(dir, 'design');
        write(join(d, 'tech-stack.md'), '# Lựa chọn công nghệ\n\nNode.js\n');
        write(join(d, 'tkct.md'), TKCT_MD);
        write(join(d, 'tkdb.md'), TKDB_MD);
        write(join(d, 'tong-the.mmd'), 'graph TD; A-->B\n');
        break;
      }
      case 'planner':
        write(join(dir, 'tasks.json'), JSON.stringify(E2E_TASKS));
        write(join(dir, 'testcases.json'), JSON.stringify(E2E_TCS));
        break;
      case 'developer':
        developers++;
        write(join(opts.cwd, 'src', `code-${developers}.txt`), `change ${developers}\n`);
        for (const p of outs) write(p, `Đã làm lần ${developers}\n`);
        break;
      case 'reviewer':
        for (const p of outs) write(p, JSON.stringify({ approved: true, comments: [] }));
        break;
      case 'tester': {
        // Targets: "- `TC-ID` — purpose (lần chạy thứ N; evidence: `dir`)"
        const results = [...opts.prompt.matchAll(/^- `([^`]+)` — .*lần chạy thứ (\d+); evidence: `([^`]+)`\)/gm)].map(m => {
          const [, id, run, evDir] = m as unknown as [string, string, string, string];
          const status = id === FAILS_FIRST && run === '1' ? 'F' : 'P';
          const file = join(evDir, `run${run}.png`);
          write(file, 'PNGDATA');
          return { tc_id: id, status, real_result: status === 'F' ? 'Báo lỗi 500' : 'Đúng như mong đợi', comment: '', evidence: [file] };
        });
        write(join(dir, 'test-results.json'), JSON.stringify({ results }));
        break;
      }
    }
    return { ok: true, resultText: 'ok' };
  };
  return { roles, prompts, handler };
}
