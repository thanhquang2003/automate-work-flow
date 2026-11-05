# DevFlow v3 — Bổ sung vai trò hệ thống, nhiều người một vai, kế hoạch chạy bằng lah

Ngày: 2026-11-07 · Nền tảng: `docs/superpowers/specs/2026-11-06-v3-multiuser-projects-design.md` (gọi tắt "spec v3", đã được chủ dự án duyệt) và tag `v2`.

Tài liệu này **chỉ ghi phần khác hoặc thêm** so với spec v3. Phần nào không nhắc ở đây thì giữ nguyên spec v3 (Google SSO giới hạn tên miền, dự án = thư mục trên VPS, mỗi yêu cầu một git worktree, mỗi người chạy Claude bằng seat riêng qua tài khoản Linux `dfu-<id>` và `dfctl`, hộp việc, `awaiting_seat`...).

## 1. Hiện trạng đã kiểm tra
- Nhánh `feat/v3-multiuser` chỉ có tài liệu (spec v3, plan 7 task, `docs/HANDOFF.md`). **Chưa có dòng code v3 nào**; mã nguồn vẫn là v2 (`UserRole = 'admin' | 'member'` ở `src/domain/types.ts`, đăng nhập mật khẩu).
- Nhánh `refactor/split-web-repo` (chưa commit) đã tách `Repo` thành `Repo` + `WebRepo` (`repo.web.*` cho users, settings, templates, survey links). Kế hoạch v3 xây tiếp trên cấu trúc này.

## 2. Quyết định của chủ dự án (từ cuộc trao đổi)
- Mọi nhân sự đăng nhập bằng tài khoản email Google Workspace của công ty (đúng spec v3 mục 5.1).
- Vai trò dự án gồm PM, SE, BA, Dev, Tester, Reviewer (giữ tên **SE** như spec v3; "SA" chỉ là cách gọi khác, không đổi mã vai).
- **Trưởng phòng và phó phòng** là vai trò hệ thống mới. Họ **quản lý PM**: chỉ định ai được làm PM (được tạo dự án) và thu hồi; ngoài ra có quyền **xem giám sát** như CTO (mục 3.1b). Họ không có quyền admin kỹ thuật và không tự có quyền trong dự án.
- **CTO** là vai trò hệ thống mới, **chỉ xem**: danh sách người dùng, danh sách dự án, tiến độ dự án, vướng mắc, trạng thái công việc. CTO không sửa được gì.
- **VPS chưa chạy v2**: không có dữ liệu cũ cần giữ.
- **Admin vẫn là quyền cao nhất**: mọi quyền của trưởng/phó phòng, cộng cấu hình GitLab, thư mục gốc dự án, người dùng và quyền hệ thống, cấu hình đồng thời.
- PM tạo dự án trên web, thêm nhân sự và gán vào từng vai; **một vai trong dự án có thể có nhiều người**.
- Mỗi người làm việc bằng gói Claude subscription của chính mình (spec v3 mục 5.2, không đổi).
- Quy trình agile, mỗi dự án là dự án mới hoặc nâng cấp dự án có sẵn, nhiều yêu cầu cùng lúc, mỗi yêu cầu một worktree (spec v3 mục 5.3, không đổi).
- Triển khai theo kế hoạch chia task chạy tự động bằng `lah`.

## 3. Thay đổi so với spec v3

### 3.1 Quyền hệ thống
Thay `admin | pm | member` bằng: `admin`, `head` (trưởng phòng), `deputy` (phó phòng), `cto`, `member`, **và** cờ độc lập `can_be_pm` trên người dùng.
- `head` và `deputy` có quyền giống nhau. Họ đặt/gỡ cờ `can_be_pm` cho người dùng khác, xem giám sát (mục 3.1b). Họ không đổi được `sys_role` của ai (chỉ admin đổi).
- Người có `can_be_pm` (hoặc admin) tạo được dự án; người tạo trở thành PM của dự án đó. Một người `head`/`deputy` muốn tự làm PM thì phải được đặt `can_be_pm` như mọi người.
- `admin` không tự động có quyền trong dự án (giữ spec v3 mục 5.4); admin muốn duyệt trong dự án phải là thành viên.
- Mọi lần đổi `sys_role` hoặc `can_be_pm` ghi vào `audit_log` (ai, đổi gì, cho ai).
- **Hai phòng phát triển tách biệt: `DEV` và `SGLOBAL`** (mục 3.1c). `head` và `deputy` thuộc đúng một phòng; `cto` và `admin` không thuộc phòng nào và nhìn xuyên suốt hai phòng.
- **Ngày đầu triển khai chủ dự án tự cấu hình** tài khoản của admin, CTO, trưởng và phó phòng của từng phòng (mục 3.1d).

### 3.1b Giám sát (CTO, trưởng phòng, phó phòng, admin)
Quyền **chỉ đọc**, áp dụng cho `cto`, `head`, `deputy` và `admin`, trên **phạm vi** của họ (mục 3.1c: CTO và admin xem cả hai phòng; trưởng/phó phòng xem phòng mình):
- danh sách người dùng (email, vai hệ thống, phòng, cờ `can_be_pm`, seat Claude đã kết nối hay chưa; **không** bao giờ hiển thị credential);
- danh sách dự án (tên, phòng, PM, thành viên theo vai);
- tiến độ dự án và từng yêu cầu (bước hiện tại, tỷ lệ task xong, trạng thái bước);
- vướng mắc: yêu cầu hoặc task đang `awaiting_seat`, bị từ chối chờ sửa, chờ khách trả lời, CR chờ PM quyết định, lỗi/failed, bug đã chạm giới hạn sửa;
- trạng thái công việc theo người (task giao cho ai, đang chạy hay chờ duyệt);
- **nội dung dự án**: tài liệu của yêu cầu (markdown, Office đã xuất, evidence), mã nguồn (cây thư mục và nội dung file của nhánh mặc định và nhánh `devflow/<REQ>`) và log của yêu cầu/job, trong mọi dự án thuộc phạm vi.
Giới hạn kỹ thuật (quyết định của Claude): xem nội dung qua **trang chỉ đọc do DevFlow phục vụ** (tiến trình `devflow` đọc file), không cấp quyền nhóm Linux `dfp-*` hay quyền chạy Claude cho người xem; không có endpoint ghi nào mở cho vai giám sát. Đường dẫn được resolve và phải nằm trong thư mục dự án (chống `..` và symlink thoát). Các file bí mật thường gặp (`.env*`, `*.pem`, `*.key`, `.claude/`, `.git/config`) không hiển thị nội dung. Log chạy Claude đã được lọc credential từ v2 (mục 5.2 spec v3). Mọi lần xem nội dung ghi vào `audit_log` (ai, dự án, đường dẫn) để truy vết; xem danh sách và tiến độ thì không ghi.

### 3.1c Hai phòng: DEV và SGLOBAL
- Bảng `departments(id, code, name)` với hai dòng khởi tạo: `DEV` và `SGLOBAL`. `users.department_id` (null với `cto`, `admin`). `projects.department_id` bắt buộc.
- Trưởng/phó phòng chỉ quản lý (đặt/gỡ `can_be_pm`) và chỉ thấy người dùng và dự án của **phòng mình**; họ không đặt được cờ cho người phòng kia.
- Một dự án thuộc đúng một phòng (phòng của PM tạo dự án). Thành viên dự án chỉ lấy từ **cùng phòng**; không trộn nhân sự hai phòng trong một dự án.
- Người đăng nhập lần đầu mà chưa được gán phòng là `member` chưa có phòng; họ chưa được thêm vào dự án cho đến khi có phòng. Admin gán phòng cho bất kỳ ai; trưởng/phó phòng gán phòng mình cho người chưa có phòng.
- Cấu hình hệ thống (GitLab, thư mục gốc, `SEAT_CONCURRENCY`...) dùng chung hai phòng, chỉ admin sửa.

### 3.1d Cấu hình ngày đầu triển khai
Chủ dự án tự khai báo trong biến môi trường (sau đó quản lý trên trang Admin): `ADMIN_EMAILS`, `CTO_EMAILS`, `HEAD_EMAILS` và `DEPUTY_EMAILS` theo dạng `DEV:email1,email2;SGLOBAL:email3`. Các tài khoản này được tạo với đúng vai và phòng ở lần đăng nhập Google đầu tiên. Nhân sự còn lại tự đăng nhập, rồi được gán phòng như mục 3.1c.

### 3.2 (bỏ) Đổi tên SE thành SA
Không làm. Giữ mã vai `SE`; toàn bộ tài liệu này dùng `SE`.

### 3.2b PLANNING
Bước PLANNING vẫn chạy hai lần Claude riêng (Dev: task, Tester: test case) nhưng **chỉ PM duyệt** gate này. Dev và Tester không duyệt PLANNING.

### 3.3 Nhiều người một vai
- `project_members.roles` đã cho một người giữ nhiều vai; nay mỗi vai được phép có **nhiều thành viên** (không giới hạn), PM luôn còn ít nhất một người.
- `request_assignees` cho phép **nhiều dòng cho cùng (request, role)**. Người đầu tiên (thứ tự `position`) là **người chạy**: Claude của bước đó chạy bằng seat người này. Mọi người cùng vai trong yêu cầu đều **duyệt được** gate của vai đó; PM duyệt thay như cũ.
- Task code: PM hoặc Dev trưởng nhóm giao từng task cho một Dev bất kỳ trong dự án; task chưa giao thuộc người chạy của vai Dev.
- Khi người chạy mất seat (`awaiting_seat`) PM có thể đưa người khác cùng vai lên đầu danh sách để bước chạy tiếp.

### 3.4 "Dev multi-agent"
Hiểu là: các task độc lập trong đồ thị phụ thuộc chạy **song song**, mỗi task một worktree và một phiên Claude (có thể là seat của các Dev khác nhau), bị giới hạn bởi `SEAT_CONCURRENCY` theo seat và `MAX_CONCURRENT_JOBS` toàn server (spec v3 mục 6b.4). Bên trong một task, phiên Claude được phép dùng subagent của superpowers. Không thêm cơ chế điều phối agent nào khác.

## 4. Mục tiêu / Không làm / Phản mục tiêu (phần thêm)
**Mục tiêu**: trưởng/phó phòng quản lý PM đúng phạm vi phòng mình; hai phòng DEV và SGLOBAL tách biệt dữ liệu và nhân sự; một vai có nhiều người, mọi người cùng vai duyệt được; CTO, trưởng/phó phòng xem được tiến độ và vướng mắc mà không sửa được gì.
**Không làm**: không thêm vai trò dự án ngoài 6 vai; không cho CTO/trưởng/phó phòng sửa bất cứ thứ gì ngoài việc đặt cờ `can_be_pm` (chỉ trưởng/phó phòng); không cho họ chỉnh cấu hình hệ thống; không thêm thông báo email/chat.
**Phản mục tiêu**: `head`/`deputy`/`cto` tự nâng mình thành `admin`; vai giám sát ghi được dữ liệu; người không thuộc dự án và không có vai giám sát duyệt được bước hoặc xem được nội dung dự án; trưởng/phó phòng này xem hay sửa được người dùng và dự án của phòng kia (nếu chưa được chủ dự án cho phép); lộ credential seat Claude trong màn hình giám sát.

## 5. Kế hoạch thực thi với lah (quyết định của Claude)
- Khởi tạo `lah` trong thư mục `devflow/` (repo độc lập, hiện chưa có `state/`), các task v3 nằm trong `state/task_list.json` của repo này, thêm bằng `lah add task`, không sửa JSON trực tiếp.
- Dựa trên kế hoạch 7 task của `docs/superpowers/plans/2026-11-06-v3-multiuser.md`, cập nhật cho phần 3 ở trên (Task 1 mô hình dữ liệu (không còn migration v2), Task 2 SSO và quyền, Task 6 giao diện chịu ảnh hưởng nhiều nhất), thêm task trang quản lý PM cho trưởng/phó phòng và task trang giám sát chỉ đọc cho CTO/trưởng/phó phòng. **Không có task migrate từ v2** (VPS chưa chạy v2): bỏ `migrate:v3` của spec v3 mục 5.6.
- Mỗi task đi theo chuỗi role của `lah` (Developer → Cleaner → Reviewer, task lớn có thêm Planner/Tester), TDD, một PR vào nhánh `feat/v3-multiuser`.
- Task spike đăng nhập seat (`claude auth login` trong pseudo-terminal, spec v3 mục 6b.3) chạy **trước** các task phụ thuộc vào nó; máy phát triển hiện tại không phải VPS nên bước kiểm chứng trên VPS Linux do chủ dự án chạy.

## 5b. Các điểm đã chốt sau vòng đọc thử
Do chủ dự án quyết:
1. **Không có dữ liệu v2 cần giữ** (VPS chưa chạy v2): schema v3 là schema khởi đầu, không cần lệnh `migrate:v3`. Người dùng chỉ được tạo qua Google SSO.
2. **PLANNING chỉ PM duyệt** (mục 3.2b).
3. **Đổi người chạy giữa chừng**: job tiếp tục bằng **seat của người mới**.

Do Claude tự quyết (chủ dự án xem lại):
4. **Cách thực hiện điểm 3**: phiên Claude đang chạy thuộc về tài khoản `dfu-<id>` của người cũ nên không chuyển sang seat khác giữa chừng được. DevFlow dừng lần chạy hiện tại, **không tính là lỗi hay một lần thử lại**, và chạy lại cùng bước (các bước đã có checkpoint nên không làm lại phần đã xong) bằng seat của người mới. Phần việc dở dang của bước đó được làm lại từ checkpoint gần nhất.
5. **Ngày đầu triển khai**: admin tạo dự án được mà không cần cờ `can_be_pm`; cách khai báo tài khoản theo mục 3.1d (định dạng biến môi trường là lựa chọn của Claude).
6. **Duyệt khi nhiều người một vai** (trừ PLANNING): một lần duyệt của bất kỳ người nào thuộc vai đó là đủ; một lần từ chối của bất kỳ người nào trả bước về trạng thái chờ sửa. Ghi người duyệt vào `audit_log`.
7. **Người giao task**: PM hoặc Dev đứng đầu danh sách (`position` nhỏ nhất) của yêu cầu. Không thêm cờ "trưởng nhóm".
8. **Thiếu người cho một vai**: giữ spec v3 mục 6b.6, yêu cầu chỉ chạy được khi mọi vai mà pipeline dùng đều có ít nhất một người.
9. **Gỡ người khỏi dự án**: job đang chạy bằng seat của họ bị dừng và chuyển cho người kế tiếp cùng vai (spec v3 mục 6b.1), cùng cách như điểm 4.
10. **"Vướng mắc" trên màn hình giám sát** gồm các trạng thái liệt kê ở mục 3.1b; ngưỡng "quá hạn" không có (chưa có deadline trong mô hình dữ liệu).
11. **Giám sát nội dung**: các giới hạn kỹ thuật ở mục 3.1b (trang chỉ đọc, ẩn file bí mật, ghi `audit_log` khi xem nội dung) là lựa chọn của Claude.

## 6. Việc để người xây dựng quyết định
Tên cột và bảng cụ thể, giao diện chi tiết trang trưởng/phó phòng, cách đặt thứ tự `position` trên giao diện, và các chi tiết kỹ thuật khác không nêu ở đây.
