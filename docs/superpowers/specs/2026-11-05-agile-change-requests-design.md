# DevFlow v2 — Quy trình Agile: điều chỉnh yêu cầu và phạm vi ở bất kỳ bước nào

Ngày: 2026-11-05 · Chủ dự án bỏ qua phần hỏi đáp; mọi điểm dưới đây là quyết định của Claude trừ yêu cầu gốc.

## 1. Mục đích

DevFlow v1 chạy một chiều: Tiếp nhận → … → Hoàn thành. Thực tế khách hàng đổi ý giữa chừng; đội phải có thể **điều chỉnh yêu cầu, phạm vi (scope) tại bất kỳ bước nào**, kể cả sau khi đã hoàn thành, mà không phải tạo yêu cầu mới và không mất những gì đã làm đúng.

Yêu cầu gốc của chủ dự án: "Điều chỉnh lại quy trình theo quy trình agile, trong tất cả các bước có thể điều chỉnh lại yêu cầu, scope của dự án bất kì bước nào."

## 2. Mục tiêu / Không làm / Phản mục tiêu

**Mục tiêu**
- Gửi **Yêu cầu thay đổi (CR)** ở mọi trạng thái của một yêu cầu (đang chạy, chờ duyệt, chờ khách hàng, tạm dừng, lỗi, cần người xử lý, đã hoàn thành). Chỉ trạng thái đã hủy là không nhận CR.
- Mỗi CR được **phân tích tác động** (Claude): phạm vi thêm/sửa/bỏ, chức năng–task–test case bị ảnh hưởng, câu hỏi mới cho khách hàng, chênh lệch nỗ lực, rủi ro, bước cần quay lại.
- Quy trình **quay lại đúng bước sớm nhất bị ảnh hưởng** rồi chạy tiếp theo kiểu **tăng dần (incremental)**: giữ nguyên phần không bị ảnh hưởng (ID, task đã xong, test case đã Pass), chỉ làm lại phần bị ảnh hưởng.
- **Truy vết**: mỗi CR có mã `CR-01…`, phiên bản yêu cầu (baseline) tăng 1 mỗi khi CR được chấp nhận; tài liệu được xuất theo phiên bản, có mục "Lịch sử thay đổi"; chức năng/task/test case bị bỏ được đánh dấu **Hủy** (không xóa).
- Sau khi Hoàn thành, CR mở ra **vòng lặp (iteration) mới** trên cùng nhánh và cùng MR cuối.
- Khách hàng cũng đề xuất thay đổi được qua trang khảo sát (ô "Đề xuất thay đổi/bổ sung khác") → tạo CR ở trạng thái **Đề xuất**, nhân viên xác nhận mới xử lý.

**Không làm**
- Không làm sprint planning/backlog board, story point, burndown.
- Không tự gửi CR cho khách hàng duyệt; nhân viên là người chấp nhận phạm vi.
- Không hoàn tác (revert) code đã merge cho chức năng bị bỏ một cách tự động bằng git revert; việc gỡ bỏ chức năng được làm như một task phát triển bình thường (có review, có test).

**Phản mục tiêu**
- CR làm mất công việc không bị ảnh hưởng (sinh lại toàn bộ task/test case với ID mới, chạy lại toàn bộ code).
- Một CR bị "nuốt" khi đang có stage chạy (gửi xong mà không có hiệu lực, hoặc bị xử lý hai lần).
- Tài liệu cũ bị ghi đè không còn bản trước để đối chiếu.
- Hoàn thành mà vẫn còn test case thuộc phạm vi mới chưa chạy.

## 3. Khái niệm

- **CR (change_requests)**: `id CR-NN` (đếm theo request), `request_id`, `title`, `description`, `kind` ∈ {`add` bổ sung, `modify` sửa đổi, `remove` bỏ bớt, `nfr` phi chức năng/hiệu năng, `other`}, `source` ∈ {`staff`, `customer`}, `status` ∈ {`proposed` (khách đề xuất, chờ nhân viên), `pending` (chờ phân tích), `analyzing`, `awaiting_decision` (chờ duyệt tác động), `accepted`, `rejected`, `applied` (đã hoàn tất qua các bước)}, `created_by`, `created_at`, `decided_by`, `decided_at`, `baseline_from`, `baseline_to`, `reenter_stage`, `impact_summary`, file đính kèm (thư mục `inputs/changes/CR-NN/`).
- **Baseline**: `requests.baseline_version` (bắt đầu 1). CR được chấp nhận → +1. `requests.iteration` (bắt đầu 1) tăng khi CR được chấp nhận lúc request đã `done`.
- **Trạng thái phạm vi** trên `features`, `tasks`, `test_cases`: cột `scope_status` ∈ {`active`, `cancelled`} và `changed_by_cr` (CR gần nhất làm thay đổi phần tử). Task còn có `status` đưa về `todo` khi bị CR sửa; test case bị sửa thì xóa kết quả lần chạy cuối khỏi việc tính "đã Pass".

## 4. Luồng xử lý

### 4.1 Gửi CR
- UI: nút **"Yêu cầu thay đổi"** hiện trên trang chi tiết ở mọi trạng thái trừ `cancelled`; form: tiêu đề, mô tả, loại, đính kèm nhiều file. Tab mới **"Thay đổi"** liệt kê CR với trạng thái, tác động, quyết định.
- Tab **"Phạm vi"**: danh sách chức năng (mã, tên, trạng thái phạm vi, CR liên quan) với nút "Đề xuất bỏ khỏi phạm vi"/"Đề xuất sửa" → mở form CR đã điền sẵn.
- `Pipeline.submitChange(reqId, cr)`:
  1. Lưu CR `pending`.
  2. Nếu có stage đang chạy: **ngắt** (abort Claude, tăng generation như `rerunStage`, hủy job đang chờ). Stage bị ngắt được ghi lại `interrupted_stage` trên CR để có thể quay lại khi CR bị từ chối.
  3. Nếu request đang `awaiting_customer`: giữ nguyên các câu hỏi đang chờ; CHANGE chạy ngay, các câu hỏi mới (nếu có) được gộp vào vòng hỏi tiếp theo.
  4. Đặt `status=running`, `stage=CHANGE`, enqueue `CHANGE`.
  5. Nhiều CR `pending` cùng lúc → **gộp** vào một lần chạy CHANGE (mỗi CR vẫn có báo cáo tác động riêng trong cùng một lần chạy).
- CR `proposed` (từ khách hàng) không làm gì cho tới khi nhân viên bấm "Tiếp nhận" (→ `pending`, như trên) hoặc "Từ chối".

### 4.2 Stage CHANGE (mới) — phân tích tác động
- Vai trò `change-analyst` (prompt `prompts/change-analyst.md`). Đầu vào: nội dung + đính kèm của các CR `pending`, `analysis.md`, `answers.json`/`assumptions.json`, `features.json`, `design/*.md`, `tasks.json`, `testcases.json`, kết quả test gần nhất, `codebase-map.md`, stage hiện tại của request.
- Đầu ra cho mỗi CR: `docs/devflow/changes/CR-NN/impact.md` (tiếng Việt: tóm tắt, phạm vi thay đổi, phần tử bị ảnh hưởng, chênh lệch nỗ lực MH, rủi ro, câu hỏi mới) và `impact.json`:
  ```json
  { "cr_id": "CR-01", "summary": "...", "scope": { "add": [{"name":"...", "description":"..."}],
    "modify": [{"feature_id":"F-02", "change":"..."}], "remove": ["F-03"] },
    "affected": { "features": ["F-02"], "tasks": ["T-04"], "test_cases": ["TC-..."] },
    "questions": [ /* cùng schema câu hỏi §8 v1, ID tiếp nối Q-xx */ ],
    "effort_delta_mh": 12, "risks": ["..."],
    "reenter": "ANALYSIS|BREAKDOWN|DESIGN|PLANNING|DEVELOP|TEST" }
  ```
- Validate bằng zod; ID được tham chiếu phải tồn tại; retry ≤2 như v1.
- Gate: luôn dừng ở `awaiting_approval` **trong cả hai chế độ** khi CR có `remove` hoặc `effort_delta_mh` > `CR_AUTO_ACCEPT_MAX_MH` (mặc định 40); còn lại theo chế độ chạy (auto → tự chấp nhận). Màn hình duyệt hiển thị impact.md của từng CR với nút **Chấp nhận** / **Từ chối** (kèm lý do) cho từng CR.

### 4.3 Chấp nhận / Từ chối
- **Chấp nhận** (`Pipeline.decideChange(reqId, crId, 'accept'|'reject', note)`): khi mọi CR trong lần phân tích đã có quyết định:
  - CR chấp nhận → `accepted`, `baseline_version += 1`, `baseline_to` ghi lại; nếu request đang `done` → `iteration += 1`.
  - Áp dụng phạm vi ngay vào DB: `remove` → feature `cancelled` và các task/test case của nó `cancelled`; `modify` → feature giữ ID, task/test case trong `affected` đưa về `todo`/xóa trạng thái Pass; `add` → ghi chú để BREAKDOWN tạo feature mới (ID tiếp nối).
  - Câu hỏi mới được upsert vào vòng hỏi kế tiếp.
  - **Điểm quay lại** = sớm nhất giữa (a) `reenter` của các CR chấp nhận, (b) `CLARIFY` nếu có câu hỏi mới `must`, nhưng **không sớm hơn ANALYSIS** và **không muộn hơn stage hiện tại** (nếu request chưa tới bước đó thì cứ chạy tiếp từ stage bị ngắt — CR sẽ được các bước sau tự đọc). Có câu hỏi mới → đi qua ANALYSIS (cập nhật analysis.md) rồi CLARIFY như v1.
  - Bộ đếm: `clarify_round` không reset (vẫn tối đa 5 vòng *mỗi baseline*: reset về 0 khi baseline tăng); `review_rounds` của task được đưa về `todo` reset về 0; `fix_attempts` của bug thuộc test case bị CR sửa reset về 0 và bug đóng với ghi chú "Đóng do CR-NN".
- **Từ chối** toàn bộ → CR `rejected`; request quay lại đúng nơi trước khi có CR: enqueue lại `interrupted_stage` (hoặc khôi phục `awaiting_customer`/`awaiting_approval`/`done`/`needs_human` như trước).

### 4.4 Các bước sau chạy tăng dần
Mọi stage nhận thêm `ctx.changes`: danh sách CR `accepted` chưa `applied` (kèm impact.json) và `ctx.baseline`. Prompt của mỗi vai trò có thêm mục "Thay đổi đã chấp nhận" với quy tắc chung:
- **Cập nhật, không viết lại từ đầu**: giữ nguyên ID hiện có, không đổi nội dung phần tử không bị ảnh hưởng.
- Phần tử bị bỏ → giữ trong file với `scope_status: "cancelled"` (JSON có thêm trường tùy chọn `scope_status`, mặc định `active`).
- Phần tử mới → ID tiếp nối (F-05, T-09, TC-…-NN tiếp theo).
- ANALYSIS: cập nhật analysis.md, thêm mục "Thay đổi theo CR-NN".
- BREAKDOWN: cập nhật features.json; ULNL xuất bản mới `ULNL_<REQ>_v<baseline>.xlsx`; dòng chức năng bị hủy ghi "Hủy theo CR-NN" ở cột ghi chú và không tính effort.
- DESIGN: cập nhật tkct.md/tkdb.md; TKCT có thêm mục PHỤ LỤC › "Lịch sử thay đổi" (bảng: phiên bản, CR, ngày, nội dung, người duyệt) — DevFlow tự sinh bảng này từ DB, không để Claude viết; xuất `TKCT_<REQ>_v<baseline>.docx`, `TKDB_<REQ>_v<baseline>.docx`; bản cũ giữ nguyên.
- PLANNING: cập nhật tasks.json/testcases.json; task mới có thể phụ thuộc task đã xong; xuất `TestCase_<REQ>_v<baseline>.xlsx`; test case hủy: cột Comment "Hủy theo CR-NN", không tính vào tổng P/F/PE (dòng vẫn hiển thị).
- DEVELOP: chỉ làm task `todo` và `active`; task "gỡ bỏ chức năng" do Planner sinh khi có `remove` là task bình thường.
- TEST: chạy test case `active` chưa Pass ở baseline hiện tại + quy tắc hồi quy v1 (mở rộng: **mọi merge** sau lần Pass cuối của một test case, không chỉ merge sửa lỗi, đều kích hoạt hồi quy). Kết quả mới ghi vào file test case theo phiên bản.
- DONE: guard v1 + không còn test case `active` thiếu kết quả; CR của baseline này chuyển `applied`; report.md có mục "Các thay đổi trong vòng này"; MR cuối được cập nhật mô tả (không mở MR mới nếu MR cũ còn mở).

### 4.5 Bảo toàn tính nhất quán
- `submitChange` không bao giờ chạy song song với một stage: dùng cơ chế generation + abort của v1; nếu stage đang ở giữa thao tác GitLab, stage đó vẫn được ngắt — các bước v1 đã idempotent khi chạy lại.
- CR gửi khi CHANGE đang chạy → lưu `pending`; khi CHANGE xong, nếu còn CR `pending` mới → CHANGE chạy thêm một lần trước khi vào gate.
- Tất cả thao tác DB của chấp nhận/từ chối nằm trong một transaction.

## 5. Giao diện (tiếng Việt)
- Thanh tiến trình: thêm nhãn "Thay đổi" (hiện khi stage = CHANGE) và hiển thị "Phiên bản yêu cầu vN · Vòng lặp M".
- Trang chi tiết: nút "Yêu cầu thay đổi" (mọi trạng thái trừ đã hủy); tab "Thay đổi" (danh sách CR, xem impact.md, quyết định), tab "Phạm vi" (feature list + trạng thái + đề xuất CR); tab Tài liệu nhóm theo phiên bản (mới nhất ở trên).
- Khi `awaiting_approval` ở stage CHANGE: khối duyệt từng CR thay cho nút Approve/Reject chung.
- Trang khảo sát khách hàng: thêm ô tùy chọn "Đề xuất thay đổi hoặc bổ sung khác" → mỗi lần gửi có nội dung sẽ tạo 1 CR `proposed` (source `customer`).
- Dashboard: cột "Phiên bản" và số CR đang chờ.

## 6. Dữ liệu
- Bảng mới `change_requests` (mục 3) + `cr_attachments(cr_id, request_id, filename, path)`.
- Cột mới: `requests.baseline_version int default 1`, `requests.iteration int default 1`; `features/tasks/test_cases.scope_status text default 'active'`, `changed_by_cr text`; `test_cases.baseline int` (baseline của lần chạy cuối). Migration idempotent (`alter table … add column` có kiểm tra).
- `STAGES` thêm `CHANGE` (không nằm trong luồng `nextStage`; chỉ tới bằng `submitChange`).

## 7. Cấu hình mới
- `CR_AUTO_ACCEPT_MAX_MH` (mặc định 40): ngưỡng nỗ lực để CR trong chế độ auto vẫn phải chờ người duyệt.

## 8. Quyết định của Claude (chủ dự án xem lại)
1. CR luôn ngắt stage đang chạy ngay lập tức (không đợi stage xong) — phản hồi nhanh, chấp nhận mất phần việc dở của stage đó.
2. CR có bỏ phạm vi hoặc nỗ lực > 40 MH luôn chờ người duyệt kể cả chế độ tự động.
3. Không quay lại sớm hơn ANALYSIS (không chạy lại Tiếp nhận / Đọc hiểu dự án); không xóa phần tử bị hủy mà đánh dấu Hủy.
4. Tài liệu xuất theo phiên bản `_v<N>`, giữ bản cũ.
5. Mọi merge (không chỉ merge sửa lỗi) đều kích hoạt hồi quy cho test case đã Pass trước đó.
6. Vòng hỏi khách hàng tối đa 5 vòng cho mỗi phiên bản yêu cầu.
7. Gỡ bỏ chức năng là task phát triển thường do Planner sinh, không tự động revert git.
