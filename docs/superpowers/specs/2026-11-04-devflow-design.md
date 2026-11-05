# DevFlow — Thiết kế công cụ tự động hóa quy trình phát triển phần mềm

Ngày: 2026-11-04 · Trạng thái: chủ dự án ủy quyền tự quyết các điểm còn lại ("làm luôn cả 2 đợt, tự chạy, hoàn thành toàn bộ").

## 1. Mục đích và lý do

Đội phát triển mất nhiều thời gian nhất ở khâu **đọc hiểu dự án có sẵn** và **hiểu rõ yêu cầu**; sai nhiều nhất ở khâu **làm rõ yêu cầu** và **code**. Khách hàng thường chỉ nêu mong muốn chung chung → đến lúc code hoặc nghiệm thu mới phát hiện thiếu tính năng.

DevFlow là một ứng dụng web chạy local (hoặc trên VPS) nhận yêu cầu phần mềm, dùng **Claude Code headless (gói subscription, có plugin superpowers)** để đi trọn quy trình:

phân tích yêu cầu → hỏi lại khách hàng → bóc tách chức năng → thiết kế (TKCT gồm HLD+LLD, TKDB, lựa chọn công nghệ, mô hình hệ thống) → chia task → viết test case → code → review → kiểm thử + evidence → log bug lên GitLab + test case → sửa → lặp lại tới khi đạt.

Ưu tiên số 1: **lộ ra các chỗ hổng của yêu cầu trước khi viết code**.

## 2. Mục tiêu / Không làm / Phản mục tiêu

**Mục tiêu**
- Áp dụng cho cả dự án mới lẫn thêm/sửa chức năng trên dự án có sẵn (repo GitLab).
- Đa dạng loại phần mềm: web, mobile, API, tiến trình ngầm; đa ngôn ngữ (Java, Python, NodeJS…).
- Mỗi yêu cầu chọn: **chạy tự động toàn trình** hoặc **dừng ở từng bước để review**.
- Tài liệu xuất ra **đúng mẫu công ty** (TKCT, TKDB .docx; Test case, ULNL .xlsx).
- Hai chế độ triển khai, chung một mã nguồn:
  - `local`: chạy trên máy cá nhân của nhân viên, Claude của chính họ, khảo sát chỉ bằng file Excel.
  - `server`: chạy trên một VPS riêng (không phải VPS GitLab), nhiều người dùng, có thêm **trang khảo sát public** cho khách hàng.

**Không làm**
- Không deploy lên môi trường production/pre-production thật. Kiểm thử chạy trên chính máy chạy DevFlow.
- Không thay thế GitLab CI.
- Không tự gửi email/chat cho khách hàng (nhân viên tự gửi file hoặc link).

**Phản mục tiêu (dù chạy được vẫn là thất bại nếu xảy ra)**
- Tự bịa câu trả lời thay khách hàng. Mọi giả định phải nằm trong mục "Câu hỏi mở và giả định" và được đánh dấu.
- Đánh dấu test case Pass mà không có evidence.
- Push/merge thẳng vào nhánh mặc định (main/master/develop) của repo khách.
- Lặp vô hạn: bug quá 3 lần sửa không qua thì phải dừng và báo người.

## 3. Định nghĩa hoàn thành một yêu cầu

- Tất cả test case có trạng thái **P** (Pass) kèm evidence rõ ràng, **hoặc PE** (Pending) khi không thể test do thiếu môi trường hoặc điều kiện bắt buộc không giả lập được, có ghi lý do ở cột Comment.
- File test case được điền đủ: Real Result, Status (PRE-PRODUCTION lần 1/lần 2), Evidences, Comment; bảng tổng hợp P/F/PE/Total đúng.
- Bug nào sửa > 3 lần mà vẫn Fail → yêu cầu chuyển sang `NEEDS_HUMAN`, GitLab issue được gắn label `needs-human`, UI hiển thị cảnh báo. Yêu cầu không được coi là hoàn thành.
- Code nằm trên nhánh tích hợp `devflow/<REQ-ID>` với MR mở vào nhánh mặc định, để người merge.

## 4. Quy trình (state machine)

Mỗi yêu cầu (`Request`, mã `REQ-NNN`) đi qua các stage sau. Ở chế độ **review**, sau mỗi stage có cờ ⏸ thì yêu cầu dừng ở `AWAITING_APPROVAL`: người duyệt bấm Approve để đi tiếp, hoặc Reject kèm nhận xét để chạy lại stage đó với nhận xét làm đầu vào. Ở chế độ **auto**, các cờ ⏸ bị bỏ qua, nhưng việc chờ khách hàng trả lời thì **luôn** dừng.

| # | Stage | Vai trò Claude | Đầu ra (trong workspace) | ⏸ |
|---|-------|----------------|---------------------------|---|
| 1 | INTAKE | — | Request + file đính kèm, repo URL (tuỳ chọn), loại dự án | |
| 2 | CODEBASE_SCAN (chỉ với dự án có sẵn) | Explorer | `docs/devflow/codebase-map.md`: module, entry point, convention, lệnh build/test, vùng bị ảnh hưởng | ⏸ |
| 3 | ANALYSIS | Analyst | `analysis.md` (yêu cầu chức năng, phi chức năng, hiệu năng; actor; use case; chỗ hổng) + `questions.json` | ⏸ |
| 4 | CLARIFY | — | Excel câu hỏi + (server) link khảo sát; chờ câu trả lời; quay lại 3 nếu còn câu hỏi mới (tối đa 5 vòng, sau đó buộc chuyển các điểm còn lại thành giả định) | luôn chờ |
| 5 | BREAKDOWN | Analyst | `features.json` + file ULNL .xlsx đã điền | ⏸ |
| 6 | DESIGN | Architect | `design/tech-stack.md`, TKCT .docx (tổng quan, thiết kế tổng thể, thiết kế chi tiết từng chức năng, phụ lục câu hỏi mở và giả định), TKDB .docx, sơ đồ `.mmd` | ⏸ |
| 7 | PLANNING | Planner + Test designer | `tasks.json` (task dev có phụ thuộc, map tới feature), test case .xlsx (trạng thái trống) | ⏸ |
| 8 | DEVELOP (lặp theo task) | Developer → Reviewer | commit trên nhánh `devflow/<REQ>-<TASK>`, MR vào `devflow/<REQ>`; review comment ghi lên MR; tối đa 3 vòng review/sửa mỗi task | ⏸ (sau khi xong tất cả task) |
| 9 | TEST | Tester | chạy test tự động + thủ công qua công cụ, evidence ở `evidence/<TC-ID>/`, test case .xlsx được điền | |
| 10 | BUGFIX (lặp) | Developer → Reviewer → Tester | GitLab Issue cho mỗi TC fail; sửa; test lại (cột lần 2, rồi lần 3+ ghi vào Comment); đếm số lần sửa mỗi bug | |
| 11 | DONE / NEEDS_HUMAN / FAILED | — | Báo cáo tổng kết `report.md` | |

Mọi stage có **checkpoint** (học từ `/lah`): kết quả của stage được lưu trong DB và trong workspace, nên khi bị ngắt (khởi động lại server, chạm giới hạn subscription) DevFlow chạy tiếp từ stage dở dang, không làm lại các stage đã xong.

Mỗi role kiểm tra lại đầu ra của role trước (Reviewer kiểm tra Developer; Tester đối chiếu test case với yêu cầu). Đây là "quality gate" học từ chuỗi vai trò của `/lah`.

> Điều chỉnh yêu cầu giữa chừng (bước CHANGE, phiên bản tài liệu, vòng lặp): xem [spec v2](2026-11-05-agile-change-requests-design.md).

## 5. Kiến trúc

```
Browser (nhân viên) ──► DevFlow server (Fastify, Node 24, TS) ──► SQLite (node:sqlite)
Browser (khách hàng) ─► /s/<token> (chỉ server mode)
                              │
                              ├─ Job queue + worker (trong cùng process)
                              │     └─ spawn `claude -p` (stream-json) trong workspace của request
                              ├─ GitLab client (REST v4, PAT) + git CLI
                              ├─ Office module: Excel (exceljs), Word (OOXML trực tiếp qua jszip)
                              └─ SSE: đẩy log/tiến trình thời gian thực lên UI
```

- **Ngôn ngữ/stack** (quyết định của Claude, chủ dự án đã OK): Node.js 24 + TypeScript, Fastify, SQLite qua `node:sqlite` có sẵn trong Node (tránh build native trên Windows), giao diện render phía server bằng template (Eta) + htmx + một ít JS thuần, SSE cho log. Test: Vitest.
- **Workspace**: `DATA_DIR/workspaces/<REQ-ID>/` chứa `repo/` (git clone hoặc repo mới), `inputs/` (đính kèm), `artifacts/` (tài liệu xuất ra), `evidence/`, `logs/`.
- **Claude runner**: gọi `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode bypassPermissions --add-dir <workspace>` với cwd = `repo/`. Prompt của mỗi role nằm trong `prompts/<role>.md` (có thể chỉnh), được ghép thêm ngữ cảnh: đường dẫn input, yêu cầu định dạng đầu ra, nhận xét reject (nếu có). Prompt yêu cầu dùng skill superpowers phù hợp (brainstorming-style phân tích chỗ hổng, writing-plans, test-driven-development, systematic-debugging, requesting-code-review). Đầu ra có cấu trúc (JSON) được validate bằng schema (zod); sai schema → chạy lại tối đa 2 lần với thông báo lỗi.
- **Giới hạn subscription**: worker phát hiện thông báo usage/rate limit từ Claude → job chuyển `PAUSED_RATE_LIMIT`, tự thử lại sau thời điểm reset (đọc từ thông báo nếu có, mặc định 30 phút). Số job Claude chạy đồng thời: `MAX_CONCURRENT_JOBS` (local mặc định 1, server mặc định 2).
- **Lệnh claude**: đường dẫn cấu hình được (`CLAUDE_BIN`); có chế độ `CLAUDE_MOCK=1` dùng cho test tự động của chính DevFlow.

## 6. GitLab

- Cấu hình: `GITLAB_URL`, `GITLAB_TOKEN` (PAT scope `api`, `write_repository`); server mode cho phép mỗi user nhập token riêng.
- Dự án có sẵn: chọn project (id/path) → clone bằng HTTPS + token. Dự án mới: tạo project mới trong group cấu hình (`GITLAB_DEFAULT_GROUP`) hoặc dùng project trống đã có.
- Nhánh: `devflow/<REQ>` tách từ nhánh mặc định; mỗi task một nhánh `devflow/<REQ>-<TASK>` → MR vào `devflow/<REQ>`, Reviewer ghi nhận xét lên MR (discussion), DevFlow merge MR task sau khi review đạt. Cuối cùng mở MR `devflow/<REQ>` → nhánh mặc định và **không merge**. Sửa bug dùng nhánh `devflow/<REQ>-fix-<TC>` → MR vào `devflow/<REQ>` (không dùng `devflow/<REQ>/...` vì xung đột git ref với nhánh `devflow/<REQ>`).
- Bug: `POST /projects/:id/issues` với title `[<REQ>][<TC-ID>] <mô tả>`, description gồm bước tái hiện, mong đợi/thực tế, evidence (upload qua `/uploads`), link MR; label `bug`, `devflow`, `<REQ>`. Mỗi lần sửa/test lại thì thêm comment. Pass → đóng issue. Quá 3 lần → label `needs-human`.
- Cột Comment của test case ghi link issue; issue ghi mã TC → liên kết hai chiều.

## 7. Tài liệu theo mẫu công ty

Mẫu được quản lý trong UI (trang Templates): upload thay thế từng loại `tkct`, `tkdb`, `testcase`, `ulnl`. Mặc định dùng 4 file trong `templates/` của chủ dự án (copy vào `devflow/templates/default/`).

- **Word (TKCT, TKDB)**: giữ nguyên phần đầu của mẫu (trang ký, mục lục, styles, header/footer, numbering); thay phần thân từ Heading1 đầu tiên tới hết bằng nội dung sinh từ markdown của Claude. Bộ chuyển đổi markdown → OOXML hỗ trợ: heading 1–4 (dùng style id của mẫu: `Heading1..4`), đoạn văn, in đậm/nghiêng/code inline, danh sách gạch đầu dòng/đánh số, bảng (dùng table style đầu tiên tìm thấy trong mẫu, mặc định có viền), code block (font monospace). Sơ đồ: Claude viết mermaid → lưu `.mmd` và chèn vào tài liệu dưới dạng code block có chú thích "Sơ đồ: <tên>" (chưa render ảnh — quyết định của Claude để tránh phụ thuộc trình duyệt headless; có thể bổ sung sau).
- Dàn ý TKCT theo đúng mẫu: TỔNG QUAN (Tổng quan dự án, Yêu cầu chức năng, Yêu cầu phi chức năng, Yêu cầu hiệu năng, Yêu cầu khác) / THIẾT KẾ TỔNG THỂ (Mô hình tổng thể, Danh sách kết nối) / THIẾT KẾ CHI TIẾT (Thiết kế giao tiếp, Cơ sở dữ liệu, rồi mỗi chức năng: Tổng quan, Đối tượng sử dụng, Giao diện, Luồng dữ liệu, Chi tiết) / PHỤ LỤC (Sơ đồ luồng dữ liệu nghiệp vụ, Câu hỏi mở và giả định).
- Dàn ý TKDB: GIỚI THIỆU (Mục tiêu tài liệu, Định nghĩa thuật ngữ, Tài liệu tham khảo, Mô tả chung) / CƠ SỞ DỮ LIỆU (Các mô hình quan hệ dữ liệu, Danh sách bảng, Danh sách mã lỗi, mỗi bảng: mô tả cột, Constraint, Index, Trigger, Partitions, Script thay đổi) / Script rollback.
- **Excel test case**: sheet `2. FUNCTIONAL TESTCASE`, header dòng 9–11, dữ liệu từ dòng 12. Cột: A mã TC, B mục đích, C dữ liệu test, D các bước, E kết quả mong đợi, F kết quả thực tế, I/J trạng thái PRE-PROD lần 1/2, K/L PROD lần 1/2 (để trống), M evidence (đường dẫn tương đối + hyperlink), N comment. Ô tổng hợp I3–I6 (P/F/PE/Total) ghi số. Xóa các dòng ví dụ cũ của mẫu trước khi ghi.
- **Excel ULNL**: sheet `EFFORT_FUNCTION`, dữ liệu từ dòng 9: A STT, B mã yêu cầu, C tên chức năng, D mô tả, K mã loại chức năng (chọn từ sheet `DEFINE TYPE OF FUNCTION`), L tên loại, M Unit test Yes/No, X ghi chú tham chiếu TKCT. Các cột effort giữ nguyên công thức của mẫu nếu có; nếu ô ví dụ là giá trị tĩnh thì DevFlow tra bảng `DATA BASE_FUNCTION` để điền Solution/Development/Test (MH). `EFFORT NON-FUNCTION`: điền các mục phi chức năng Claude đề xuất (mã từ `DATA BASE_NON - FUNCTION`).
- Ánh xạ sheet/dòng/cột nằm trong `templates/mapping.json` để có thể chỉnh khi mẫu đổi.

## 8. Khảo sát khách hàng

- `questions.json`: `{id, category (Chức năng|Phi chức năng|Hiệu năng|Dữ liệu|Tích hợp|Giao diện|Khác), question, why (vì sao cần hỏi), type (single|multi|text), options[], suggested_answer, priority (must|should)}`.
- **Excel**: DevFlow xuất `Questions_<REQ>_round<N>.xlsx` (cột: ID, Nhóm, Câu hỏi, Lý do, Lựa chọn, Đề xuất, **Trả lời của khách hàng**, Ghi chú), cột trả lời có data validation khi có options. Nhân viên upload lại file → DevFlow đọc theo ID.
- **Web (server mode)**: link `https://<host>/s/<token>`: token ngẫu nhiên 32 byte, hết hạn sau 14 ngày (cấu hình được), không cần đăng nhập, khách lưu nháp và bấm "Gửi". Rate limit theo IP. Giao diện tiếng Việt, thân thiện mobile. Nhân viên thấy tiến độ trả lời trên UI.
- Hai kênh dùng chung một bảng `answers`; câu đã có trả lời thì lấy bản mới nhất. Nhân viên có thể nhập/sửa câu trả lời thay khách (ghi nguồn).
- Khi đủ câu `must` (hoặc nhân viên bấm "Tiếp tục với giả định"), Analyst chạy lại: cập nhật `analysis.md`, sinh câu hỏi vòng mới nếu cần.

## 9. Kiểm thử và evidence

- Tester role chạy trên máy: build/run dự án theo lệnh trong codebase-map, viết test tự động phù hợp loại phần mềm:
  - Web UI: Playwright (Claude cài vào repo dưới dạng devDependency hoặc thư mục `e2e/` riêng) → screenshot PNG mỗi bước kiểm chứng.
  - API: script gọi HTTP → lưu request/response `.json`/`.txt`.
  - Tiến trình ngầm: chạy job với dữ liệu giả lập → log + truy vấn DB trước/sau `.txt`.
  - Mobile: nếu có Android SDK/emulator (`ANDROID_HOME`) thì dùng Maestro/Appium, nếu không thì kiểm tra lớp logic/API và đánh dấu phần UI là **PE** với lý do "thiếu môi trường mobile".
- Tester ghi `test-results.json`: `{tc_id, status: P|F|PE, real_result, evidence: [paths], comment}`. DevFlow **từ chối** status P nếu thiếu file evidence tồn tại trong `evidence/<TC-ID>/` → tự hạ thành F với comment "thiếu evidence" và yêu cầu Tester chạy lại.
- Evidence được copy vào `artifacts/evidence/` cạnh file Excel để đường dẫn tương đối dùng được khi nén gửi đi; nút "Tải gói kết quả (.zip)".

## 10. Giao diện web

- **Dashboard**: danh sách request (mã, tiêu đề, stage, chế độ auto/review, trạng thái, người tạo), bộ lọc.
- **Tạo request**: tiêu đề, mô tả yêu cầu, yêu cầu hiệu năng, yêu cầu phi chức năng, đính kèm nhiều file, loại dự án (mới/có sẵn), GitLab project (có sẵn) hoặc tên project mới, loại phần mềm (web/mobile/api/background, chọn nhiều), chế độ chạy.
- **Chi tiết request**: thanh tiến trình theo stage; log Claude realtime (SSE); tab Phân tích, Câu hỏi (xuất/nhập Excel, link khảo sát, sửa trả lời), Tài liệu (tải TKCT/TKDB/ULNL/Test case), Task, Test (bảng TC + trạng thái + evidence xem trực tiếp), Bug (link GitLab); nút Approve/Reject (review mode), Pause/Resume/Cancel, "Chạy lại stage".
- **Templates**, **Cài đặt** (GitLab, Claude bin, concurrency), **Users** (server mode).
- Tiếng Việt toàn bộ UI.

## 11. Bảo mật và triển khai

- `local`: bind `127.0.0.1`, không đăng nhập.
- `server`: bind `0.0.0.0` (đặt sau reverse proxy HTTPS, hướng dẫn Caddy trong README); đăng nhập bằng username/password (scrypt), session cookie httpOnly; vai trò `admin`/`member`; route `/s/*` là phần duy nhất public không cần đăng nhập; giới hạn kích thước upload (50MB/file); token GitLab mã hoá AES-GCM bằng `SECRET_KEY` khi lưu DB.
- Claude chạy với `bypassPermissions` trong workspace riêng → cảnh báo trong README: chỉ chạy trên máy/VPS dành riêng.
- Triển khai: `npm ci && npm run build && npm start`; script `scripts/install-service` hướng dẫn chạy như service (pm2 hoặc systemd). Yêu cầu máy: Node 24, git, Claude Code đã `claude login` và cài plugin superpowers.

## 12. Dữ liệu (SQLite)

`users`, `requests`, `attachments`, `stage_runs` (request, stage, attempt, status, started/finished, claude_session_id, cost/time, error), `jobs` (queue), `questions`, `answers`, `survey_links`, `features`, `tasks`, `test_cases`, `test_runs`, `bugs` (tc, gitlab_iid, fix_attempts, status), `events` (log hiển thị), `settings`, `templates`.

## 13. Phân chia công việc giao cho người xây dựng

Đã quyết (bởi chủ dự án): toàn bộ quy trình ở mục 4, hai chế độ local/server, khảo sát Excel + web, GitLab tự cài, Claude subscription, test trên máy, mẫu tài liệu công ty, điều kiện hoàn thành và ngưỡng 3 lần.

Claude tự quyết (chủ dự án xem lại): stack Node/TS/Fastify/SQLite/htmx; TKCT gộp HLD+LLD theo đúng mẫu; điền cột PRE-PRODUCTION; sơ đồ dạng mermaid chưa render ảnh; nhánh tích hợp + MR cuối không merge; tối đa 5 vòng hỏi, 3 vòng review/task; token khảo sát 14 ngày; mobile → PE khi thiếu emulator.

Để người xây dựng: chi tiết prompt cho từng role, cấu trúc module, chi tiết UI.
