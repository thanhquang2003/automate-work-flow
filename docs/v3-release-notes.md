# DevFlow v3: ghi chú phát hành

## Có gì mới so với v2

- **Nhiều người trên một VPS.** Đăng nhập Google bằng email công ty (OIDC), hai phòng ban DEV và SGLOBAL, vai trò hệ thống (`admin`, `cto`, `head`, `deputy`, `member` và cờ `can_be_pm`) và vai trò dự án (`PM`, `BA`, `SE`, `DEV`, `REVIEWER`, `TESTER`, mỗi vai có thể nhiều người).
- **Dự án là một thư mục git.** Nhiều yêu cầu chạy song song; mỗi yêu cầu và mỗi task một git worktree riêng, tài liệu nằm trong `docs/devflow/<mã>/`, file bàn giao ở `docs/devflow/<mã>/deliverables/`. Mã yêu cầu do PM nhập.
- **Mỗi lần gọi Claude chạy bằng seat của người phụ trách.** Tài khoản Linux riêng cho từng người, `dfctl` là công cụ đặc quyền duy nhất; seat hết hạn thì yêu cầu chờ ở `awaiting_seat` rồi chạy tiếp khi người đó kết nối lại.
- **Duyệt theo vai.** Mỗi cổng có người duyệt theo vai (PLANNING và DONE chỉ PM); PM duyệt được mọi cổng. Đổi người chạy hoặc gỡ thành viên giữa chừng thì bước chạy lại bằng seat người mới, không tính là lỗi.
- **Hộp việc, phân công, trang "Claude của tôi", trang quản trị người dùng.**
- **Khu vực giám sát chỉ đọc** cho CTO, trưởng/phó phòng, admin: tiến độ, điểm nghẽn, công việc theo người, nội dung dự án và log (file bí mật bị ẩn, mọi lần xem được ghi audit).
- Task của nhiều Dev chạy song song trên worktree riêng, merge được xếp hàng lần lượt.

## Thay đổi gây lỗi tương thích

- **Server mode chỉ chạy trên Linux** và **không khởi động nếu thiếu `dfctl`** (cài bằng `scripts/install-server.sh`).
- **Bắt buộc Google SSO** ở server mode (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL_DOMAINS` khác rỗng). Đăng nhập mật khẩu và trang `/setup` bị bỏ, trừ tài khoản break-glass (`BREAKGLASS_ADMIN`).
- **Dữ liệu v2 không được chuyển sang.** Không có lệnh migrate; VPS bắt đầu từ lược đồ v3. Yêu cầu không thuộc dự án (legacy) không được hỗ trợ ở server mode.
- Ở server mode không còn tạo yêu cầu ngoài dự án; mọi yêu cầu nằm trong một dự án và do PM tạo.
- `MAX_CONCURRENT_JOBS` mặc định ở server mode là 4; thêm `SEAT_CONCURRENCY` (mặc định 1).
- Local mode giữ hành vi v2 (một người dùng ngầm định, mọi quyền).

## Giới hạn đã biết

- Chưa kiểm chứng trên VPS thật: `dfctl`, đăng nhập seat với `claude` thật, managed settings (`forceLoginOrgUUID` kiểu chuỗi hay mảng), luồng Google thật, hiển thị trình duyệt. Xem `docs/deploy-vps.md` mục 9.
- Dịch vụ `devflow` bị chiếm quyền thì chạm được mọi seat; seat khác đang chạy trong cùng dự án có thể ghi vào thư mục git dùng chung; seat độc hại có thể thoát process group (không thoát scope).
- Che bí mật trong log chỉ là lớp phòng thủ bổ sung; CTO, trưởng/phó phòng và admin đọc được mã nguồn và log dự án. Cờ `-p <từ>` bị che quá tay.
- Clone thất bại có thể để lại thư mục không rỗng (dọn tay). Lưu trữ dự án không gỡ thành viên khỏi group Linux.
- Mã yêu cầu `ERP` và `ERP-1` không cùng tồn tại trong một dự án.
- Xác nhận với Anthropic mô hình "nhiều seat Claude Team trên một máy chủ dùng chung" trước khi dùng thật.
