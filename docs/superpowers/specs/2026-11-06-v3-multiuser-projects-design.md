# DevFlow v3 — Máy chủ dùng chung: Google SSO, dự án theo thư mục, vai trò & seat Claude riêng

Ngày: 2026-11-06 · Nền tảng: DevFlow v2 (tag `v2`).

## 1. Mục đích

Triển khai DevFlow trên **một VPS dùng chung** cho cả đội. Nhân viên đăng nhập bằng **Google SSO**, làm việc theo **dự án**; mỗi dự án là **một thư mục trên VPS** chứa toàn bộ mã nguồn và tài liệu của dự án (DevFlow không giữ tài liệu dự án trong thư mục dữ liệu chung của nó). Nhiều nhân sự cùng làm một dự án với **vai trò** khác nhau; mỗi người **duyệt bước mình phụ trách**; **PM** có quyền cao nhất trong dự án. Mọi lần chạy Claude dùng **seat Claude Team của chính người phụ trách** bước đó.

## 2. Quyết định của chủ dự án
- Công ty dùng **Claude Team**; mỗi người dùng seat riêng của mình trên server (không dùng chung một tài khoản, không dùng API key chung).
- Vai trò dự án: **PM, BA, SE, Dev, Code Reviewer, Tester** (không có Coordinator). SE phụ trách thiết kế và thiết kế chạy bằng seat của SE. **Code Reviewer** review code (chạy bằng seat của Reviewer) và duyệt bước phát triển.
- DevFlow được dùng **sudo** (qua script quản trị `dfctl`, mục 6b.2) để tạo tài khoản, quản lý nhóm và chạy Claude dưới tài khoản riêng của từng người.
- **Mã yêu cầu do PM nhập** (DevFlow gợi ý `<KEY>-NNN`).
- Một thư mục dự án có thể có **nhiều yêu cầu làm song song**; mỗi yêu cầu làm trên **git worktree riêng** để không ghi đè nhau.
- Một dự án = một thư mục trên VPS (repo mã nguồn); một dự án có **nhiều yêu cầu** nối tiếp; tài liệu từng yêu cầu ở `docs/devflow/<REQ>/` trong dự án.
- Mỗi yêu cầu: PM chỉ định **một người phụ trách cho mỗi vai trò** (mặc định là thành viên đầu tiên của vai trò). **Task code được giao cho từng Dev**, chạy bằng seat của Dev đó.
- Chỉ email Google thuộc **tên miền công ty** được đăng nhập. **Admin** hệ thống chỉ định ai được làm PM (tạo dự án), cấu hình GitLab và các **thư mục gốc** được phép đặt dự án. **PM** tạo dự án (chọn thư mục có sẵn, clone repo vào thư mục mới, hoặc tạo repo mới) và tự thêm thành viên.

## 3. Mục tiêu / Không làm / Phản mục tiêu

**Mục tiêu**
- Google OIDC SSO, giới hạn tên miền; phiên đăng nhập như v1 (cookie ký HMAC).
- Quyền hệ thống: `admin`, `pm` (được tạo dự án), `member`. Quyền dự án: tập vai trò {PM, BA, SE, DEV, REVIEWER, TESTER} cho mỗi thành viên (một người có thể giữ nhiều vai trò).
- Kết nối seat Claude của từng người trên server, chạy Claude bằng đúng seat đó, có trang trạng thái seat.
- Phân công theo yêu cầu và theo task; người duyệt mỗi bước là người phụ trách vai trò của bước đó (PM duyệt thay được).
- Hộp việc "Việc của tôi": các bước chờ tôi duyệt, task giao cho tôi, CR chờ PM, seat cần đăng nhập lại.
- Tài liệu, đầu vào, evidence, log của yêu cầu nằm trong thư mục dự án.
- Nhiều yêu cầu của cùng dự án chạy song song an toàn (mỗi yêu cầu một git worktree).

**Không làm**
- Không gửi email/Google Chat thông báo (chỉ hộp việc trong ứng dụng + badge). 
- Không quản lý seat Claude Team (mời/xóa seat làm ở trang admin của claude.ai).
- Không hỗ trợ đăng nhập mật khẩu ở chế độ server nữa, trừ tài khoản khẩn cấp (mục 5.1).

**Phản mục tiêu**
- DevFlow đọc, lưu, hiển thị hoặc ghi log token/credential Claude của nhân viên.
- Claude chạy cho người A đọc được credential Claude hoặc thư mục dự án mà A không thuộc.
- Người không có vai trò phù hợp duyệt được một bước (trừ PM, admin không tự động có quyền dự án).
- Hai yêu cầu của cùng dự án ghi đè lên nhau trong cùng một working tree.

## 4. Tuân thủ điều khoản Anthropic (bắt buộc)
Theo trang Legal & compliance của Claude Code: OAuth của gói Team dành cho người mua gói dùng Claude Code thông thường; ứng dụng **không được thu thập/lưu/trung gian credential hay session token claude.ai**, đăng nhập phải hoàn tất qua luồng của Anthropic; người dùng cuối **được** đăng nhập binary Claude Code nguyên bản bằng subscription của chính mình kể cả khi nền tảng host Claude Code. Do đó:
- DevFlow chạy **binary `claude` nguyên bản**; mỗi người có thư mục cấu hình riêng (`CLAUDE_CONFIG_DIR`), credential do chính Claude Code ghi (`.credentials.json`, mode 0600).
- Không dùng `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` (sẽ buộc DevFlow giữ token).
- README ghi rõ: nên xác nhận với Anthropic (sales) về mô hình máy chủ dùng chung này; bật `forceLoginMethod: "claudeai"` + `forceLoginOrgUUID` (org Team của công ty) trong managed settings của server để chỉ seat của công ty đăng nhập được.

## 5. Thiết kế

### 5.1 Đăng nhập & người dùng
- OIDC Authorization Code + PKCE với Google (`openid email profile`), kiểm tra `email_verified` và `hd`/đuôi email ∈ `ALLOWED_EMAIL_DOMAINS` (danh sách, ví dụ `arabicatech.vn`). Người đăng nhập lần đầu được tạo tự động với quyền `member`; email trong `ADMIN_EMAILS` được tạo là `admin`.
- Cấu hình: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL` (callback `/auth/google/callback`), `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`.
- Tài khoản khẩn cấp: biến `BREAKGLASS_ADMIN` (username) + mật khẩu scrypt đặt bằng lệnh CLI `npm run admin:set-password`; trang `/login/local` chỉ hiện khi biến này được đặt.
- Chế độ `local` (một người trên máy cá nhân) giữ nguyên như v2: không đăng nhập, mọi quyền.

### 5.2 Seat Claude của từng người
- **Cô lập bằng tài khoản Linux riêng** (chế độ server, Linux): mỗi người dùng DevFlow có một tài khoản hệ điều hành `dfu-<id>` (không shell đăng nhập, home `/var/lib/devflow/users/<id>`), `CLAUDE_CONFIG_DIR=<home>/.claude`. Tiến trình DevFlow chạy `claude` cho người đó bằng `sudo -n -u dfu-<id> -- /usr/bin/env CLAUDE_CONFIG_DIR=… <claude> …` với một quy tắc sudoers chỉ cho phép đúng lệnh này. Script cài đặt `scripts/provision-user.sh` tạo tài khoản; DevFlow gọi nó (qua sudo) khi người dùng đăng nhập lần đầu.
- **Quyền thư mục dự án**: mỗi dự án có nhóm Linux `dfp-<projectId>`; thư mục dự án thuộc nhóm đó (setgid, umask 002); thành viên dự án được thêm/bớt khỏi nhóm khi PM thay đổi thành viên. Như vậy Claude chạy cho A chỉ đọc/ghi được dự án mà A là thành viên và không đọc được credential của người khác.
- **Kết nối seat** (trang "Claude của tôi"): DevFlow chạy `claude auth login` (binary nguyên bản, dưới tài khoản `dfu-<id>`) trong một pseudo-terminal; hiển thị **URL đăng nhập** do Claude Code in ra để người dùng mở trên trình duyệt của họ (luồng của Anthropic); nếu trình duyệt hiện mã, người dùng dán mã vào ô trên trang và DevFlow chuyển nguyên văn vào stdin của tiến trình đó, không lưu, không ghi log. Kết quả do Claude Code tự lưu. Hết 10 phút không hoàn tất → hủy tiến trình.
- **Trạng thái seat**: `claude auth status` (hoặc lệnh tương đương của phiên bản đang cài; nếu không có thì một lệnh `claude -p` rất ngắn khi người dùng bấm "Kiểm tra") → hiển thị Đã kết nối / Hết hạn / Chưa kết nối, email & tổ chức nếu Claude Code in ra. Nút "Đăng xuất Claude" chạy `claude auth logout`.
- **Khi chạy một bước**: xác định người phụ trách (5.4); seat chưa kết nối hoặc lỗi "Login expired" → bước chuyển trạng thái `awaiting_seat` (mới) với thông báo trong hộp việc của người đó; khi họ kết nối lại → tự chạy tiếp. Giới hạn subscription (rate limit) xử lý như v1 nhưng **theo seat**: chỉ các job dùng seat đó bị dừng.
- **Đồng thời**: tối đa `SEAT_CONCURRENCY` (mặc định 1) job Claude cùng lúc cho mỗi seat; tổng toàn server `MAX_CONCURRENT_JOBS` (mặc định 4 ở server mode).
- Chế độ `local` và môi trường Windows: không có tài khoản riêng; dùng Claude đang đăng nhập của máy (như v2).

### 5.3 Dự án
- Bảng `projects(id, key, name, path, gitlab_project, default_branch, created_by, created_at, archived)`; `key` 2–10 chữ in hoa (ví dụ `ERP`), dùng làm gợi ý mã yêu cầu `ERP-001` (PM có thể nhập mã khác); `requests` có khóa duy nhất (project_id, code).
- `project_members(project_id, user_id, roles JSON, added_by, added_at)`; PM luôn có ít nhất một người.
- Admin cấu hình `PROJECT_ROOTS` (danh sách thư mục gốc, ví dụ `/srv/projects`). Thư mục dự án phải nằm trong một thư mục gốc (đã resolve symlink).
- PM tạo dự án theo một trong ba cách: (a) **thư mục có sẵn** (phải là repo git hoặc rỗng), (b) **clone** repo GitLab vào thư mục mới, (c) **tạo mới** (git init + tùy chọn tạo project GitLab). Người tạo trở thành PM.
- Bố cục trong thư mục dự án:
  - Mã nguồn: repo git của dự án (nhánh mặc định không bị DevFlow sửa).
  - `.devflow/` (được thêm vào `.git/info/exclude`): `worktrees/<REQ>/` (git worktree của nhánh `devflow/<REQ>`), `requests/<REQ>/{inputs,artifacts,evidence,logs}`.
  - Tài liệu markdown của yêu cầu commit trên nhánh `devflow/<REQ>` tại `docs/devflow/<REQ>/` (thay cho `docs/devflow/` chung của v2).
  - Tài liệu Office (TKCT/TKDB/ULNL/TestCase _vN, bộ câu hỏi), evidence: `.devflow/requests/<REQ>/artifacts|evidence`; khi hoàn thành, bản cuối được copy vào `docs/devflow/<REQ>/deliverables/` trên nhánh và commit (để nằm trong repo dự án).
- Lưu trữ dự án (archive) thay vì xóa; DevFlow không bao giờ xóa thư mục dự án.

### 5.4 Vai trò, phân công, duyệt
| Bước | Vai trò phụ trách (seat chạy Claude) | Người duyệt (gate) |
|---|---|---|
| INTAKE | — (không Claude) | — |
| CODEBASE_SCAN | SE | SE |
| ANALYSIS | BA | BA |
| CLARIFY | — | BA nhập/nhận trả lời, bấm Tiếp tục |
| BREAKDOWN | BA | BA |
| DESIGN | SE | SE |
| PLANNING | Dev (tasks) và Tester (test cases) — hai lần chạy Claude riêng | cả Dev và Tester phụ trách đều phải duyệt |
| DEVELOP | Dev được giao từng task (seat của người đó); review từng task bằng seat của **Code Reviewer** phụ trách yêu cầu | **Code Reviewer** |
| TEST | Tester | — |
| BUGFIX | Dev được giao task của chức năng có test case lỗi (không có → Dev phụ trách); review bản sửa bằng seat Code Reviewer | — |
| CHANGE (phân tích CR) | BA | **PM** quyết định từng CR |
| DONE | — | PM chốt (gate mới ở chế độ review; ở auto thì tự hoàn thành) |
- `request_assignees(request_id, role, user_id)`; PM đổi người phụ trách bất kỳ lúc nào (áp dụng cho lần chạy kế tiếp). `tasks.assignee_id` — PM hoặc Dev phụ trách giao; task chưa giao → Dev phụ trách.
- PM duyệt thay được mọi gate; admin không có quyền dự án trừ khi là thành viên.
- Mọi thao tác ghi (`approve`, `reject`, quyết định CR, gửi CR, giao task, nhập câu trả lời, tạo link khảo sát) kiểm tra quyền phía server; nhật ký `audit_log(project_id, request_id, user_id, action, detail, at)`.
- Ai được tạo yêu cầu/gửi CR: PM, BA (mặc định). Các thành viên khác xem được mọi thứ trong dự án.

### 5.5 Giao diện
- Trang chủ "Việc của tôi" + danh sách dự án của tôi.
- Trang dự án: thông tin, thành viên & vai trò (PM sửa), danh sách yêu cầu, nút tạo yêu cầu.
- Trang yêu cầu (như v2) + khối "Phụ trách" (vai trò → người, PM sửa), tab Task có cột người được giao; nút duyệt chỉ hiện với người có quyền.
- Trang "Claude của tôi" (kết nối seat), trang Admin (người dùng & quyền hệ thống, thư mục gốc, GitLab, cấu hình đồng thời).

### 5.6 Di chuyển từ v2
- Lệnh `npm run migrate:v3 -- --project-key LEGACY --path <thư mục>` tạo dự án "Legacy", gán các yêu cầu cũ vào, giữ workspace cũ ở chỗ cũ (đánh dấu `legacy_workspace=1`) — không di chuyển file. Yêu cầu mới luôn dùng bố cục 5.3.

## 6. Quyết định của Claude (chủ dự án xem lại)
1. Cô lập seat và dự án bằng tài khoản/nhóm Linux riêng + sudoers giới hạn (an toàn nhất khi Claude chạy `bypassPermissions`); chế độ server yêu cầu Linux.
2. Kết nối seat qua `claude auth login` chạy trong pseudo-terminal, người dùng tự đăng nhập trên trình duyệt; DevFlow chỉ chuyển mã dán vào stdin, không lưu.
3. Mỗi yêu cầu một git worktree trong `.devflow/worktrees/` của dự án; Office/evidence ở `.devflow/requests/`, bản cuối commit vào `docs/devflow/<REQ>/deliverables/`.
4. PLANNING tách hai lần chạy (Dev: tasks, Tester: test cases) và cần hai người duyệt.
5. Review code dùng seat của Code Reviewer phụ trách yêu cầu (chủ dự án bổ sung vai trò này).
6. Thông báo chỉ trong ứng dụng; không email.
7. Mã yêu cầu do PM nhập (duy nhất trong dự án, 1–40 ký tự `A-Za-z0-9._-`, không trùng nhánh git hiện có), gợi ý mặc định `<KEY>-NNN`; mã dùng làm tên nhánh `devflow/<mã>` và thư mục worktree.
8. Bỏ đăng nhập mật khẩu ở server mode, giữ một tài khoản khẩn cấp.
9. Trạng thái mới `awaiting_seat` khi seat của người phụ trách chưa kết nối/hết hạn.

## 6b. Chi tiết kỹ thuật bổ sung (quyết định của Claude sau vòng đọc thử)
1. **Sở hữu file & tiến trình**: DevFlow chạy bằng tài khoản dịch vụ `devflow`, là thành viên mọi nhóm `dfp-*`. Thư mục dự án: owner `devflow`, group `dfp-<id>`, `chmod 2770`, repo đặt `core.sharedRepository=group`. DevFlow (user `devflow`) làm mọi thao tác git/Office/worktree; Claude chạy bằng `dfu-<id>` (thành viên các nhóm dự án của người đó) và chỉ sửa file trong worktree được giao; commit do DevFlow thực hiện sau lần chạy với `user.name/user.email` = tên/email Google của người phụ trách. Khi một người bị gỡ khỏi dự án: hủy các job đang chạy bằng seat của họ trong dự án đó rồi mới gỡ nhóm.
2. **Sudo**: một script wrapper duy nhất do root sở hữu `/usr/local/lib/devflow/dfctl` (chỉ đọc với `devflow`) có các lệnh con kiểm tra tham số chặt chẽ: `provision-user <id>`, `ensure-project-group <projectId> <path>`, `set-members <projectId> <userIds…>`, `run-claude <userId> <cwd> -- <args…>` (cwd phải nằm trong worktree của một dự án mà user là thành viên; args truyền nguyên vẹn cho binary `claude` cấu hình sẵn; prompt qua stdin), `claude-auth <userId> login|status|logout`. Sudoers: `devflow ALL=(root) NOPASSWD: /usr/local/lib/devflow/dfctl`. Script cài đặt `scripts/install-server.sh` cài wrapper, sudoers, managed settings của Claude Code (`/etc/claude-code/managed-settings.json` với `forceLoginMethod`/`forceLoginOrgUUID` lấy từ biến `CLAUDE_TEAM_ORG_UUID`).
3. **Spike trước tiên**: task đầu của kế hoạch là spike kiểm chứng `claude auth login|status|logout` chạy được trong pseudo-terminal dưới một user không có shell đăng nhập (in URL, nhận mã dán). Nếu không được: phương án dự phòng là trang hướng dẫn + lệnh `sudo dfctl claude-auth <id> login` do admin mở phiên SSH cùng người dùng; phần còn lại của thiết kế không đổi.
4. **DEVELOP**: mỗi task có worktree riêng `.devflow/worktrees/<REQ>-<TASK>` trên nhánh `devflow/<REQ>-<TASK>`; các task độc lập (phụ thuộc đã xong) của **những Dev khác nhau** chạy song song (mỗi seat tối đa `SEAT_CONCURRENCY`); merge vào `devflow/<REQ>` được tuần tự hóa bằng khóa theo yêu cầu (MR GitLab như v2 hoặc merge local). MR cuối `devflow/<REQ>` → nhánh mặc định chỉ được mở, con người merge.
5. **Di chuyển v2**: người chạy `migrate:v3` (admin) thành PM và giữ mọi vai trò của dự án Legacy; các yêu cầu cũ giữ mã `REQ-NNN`; mọi bước của yêu cầu cũ dùng seat của người phụ trách được gán (mặc định là người đó).
6. **PLANNING bị từ chối**: người từ chối là Dev → chạy lại phần tasks; Tester → chạy lại phần test cases; PM → chọn phần. Tạo yêu cầu bị chặn (thông báo rõ) nếu dự án thiếu thành viên cho một trong các vai trò BA, SE, Dev, Code Reviewer, Tester.
7. **Chế độ**: giữ `DEVFLOW_MODE=local|server`; server mode từ chối khởi động nếu không phải Linux hoặc thiếu `dfctl`; DB SQLite v2 được nâng cấp tại chỗ bằng migration.
8. **Hàng đợi**: FIFO theo seat + giới hạn toàn server; `awaiting_seat` tự chạy lại khi người đó kết nối seat, và kiểm tra lại mỗi 10 phút; trạng thái tạm dừng vì giới hạn subscription hiển thị theo seat trong hộp việc của người đó và trên trang yêu cầu.
9. **GitLab**: token GitLab dùng chung do admin cấu hình (như v2) để clone/push/tạo MR/issue; token GitLab cá nhân (tùy chọn, như v2) chỉ dùng để ghi tên người trên GitLab. Commit git mang tên/email Google của người phụ trách.

## 7. Để lại cho người xây dựng
Chi tiết UI, cấu trúc module, thư viện OIDC (ưu tiên `openid-client`), thư viện pseudo-terminal (`node-pty` nếu build được trên Node 24; nếu không, chạy `claude auth login` với stdin/stdout pipe khi CLI hỗ trợ), cách đọc trạng thái seat theo phiên bản Claude Code đang cài.
