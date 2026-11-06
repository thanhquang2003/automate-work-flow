# DevFlow — Ghi chú bàn giao (cập nhật 2026-11-06)

## 1. Trạng thái hiện tại
- Repo: `D:\source\automationWorkFlow\devflow` · remote `origin` = GitHub `thanhquang2003/automate-work-flow`.
- `main` = **v2** (tag `v2`, commit `56a0931`) — đã push lên GitHub. Tag `v1` = `56d28b8`.
- Nhánh đang làm: **`feat/v3-multiuser`** (chưa push) — mới có tài liệu, **chưa có code v3**:
  - Thiết kế: `docs/superpowers/specs/2026-11-06-v3-multiuser-projects-design.md` (đã được chủ dự án duyệt)
  - Kế hoạch: `docs/superpowers/plans/2026-11-06-v3-multiuser.md` (7 task, đã được duyệt)
- Test hiện tại trên `main`: 300/300 pass, build OK.

## 2. Các phiên bản đã có
- **v1** (`docs/superpowers/specs/2026-11-04-devflow-design.md`): quy trình tự động Tiếp nhận → Đọc hiểu dự án → Phân tích → Làm rõ (Excel + web khảo sát) → Bóc tách (ULNL) → Thiết kế (TKCT/TKDB) → Kế hoạch & Test case → Phát triển + review (MR GitLab) → Kiểm thử + evidence → Sửa lỗi (≤3 lần) → Hoàn thành (MR cuối không merge).
- **v2** (`docs/superpowers/specs/2026-11-05-agile-change-requests-design.md`): Yêu cầu thay đổi (CR) ở mọi bước, bước CHANGE phân tích tác động, duyệt từng CR, quay lại bước sớm nhất bị ảnh hưởng, chạy tăng dần, tài liệu theo phiên bản `_vN`, "Hủy theo CR-NN", vòng lặp.

## 3. v3 — yêu cầu của chủ dự án (tóm tắt)
- Chạy trên **một VPS dùng chung**; đăng nhập **Google SSO** (chỉ `@arabicatech.vn`); Admin chỉ định ai làm PM.
- **Dự án = một thư mục trên VPS** (repo mã nguồn + toàn bộ tài liệu); nhiều yêu cầu, có thể **chạy song song**, mỗi yêu cầu (và mỗi task) một **git worktree riêng**.
- Vai trò dự án: **PM, BA, SE, Dev, Code Reviewer, Tester**. Mỗi bước chạy Claude bằng **seat của người phụ trách** và người đó duyệt; PM quyền cao nhất (thêm người, phân vai, duyệt thay, quyết định CR, chốt hoàn thành). Task code giao cho từng Dev. **Mã yêu cầu do PM nhập**.
- **Claude**: công ty dùng **Claude Team**; mỗi người dùng seat riêng của mình trên server (không dùng chung tài khoản). DevFlow dùng **sudo** (script `dfctl`) để chạy Claude dưới tài khoản Linux riêng của từng người; DevFlow không đọc/lưu token Claude.

## 4. Tư vấn tài khoản Claude (đã trả lời chủ dự án)
- Dùng chung 1 subscription cho nhiều người: **không được** (điều khoản cá nhân; cấm route thay người khác).
- Mỗi người tự đăng nhập seat của mình vào binary Claude Code nguyên bản trên server: **được** — ứng dụng không được thu thập/lưu token. → Hướng đã chọn: **Claude Team seat riêng** (standard $25/tháng, premium $125/tháng; trả năm $20/$100).
- Phương án thay thế: API key Console của công ty (được phép cho người dùng nội bộ, trả theo token).
- Nên xác nhận với Anthropic sales về mô hình máy chủ dùng chung. Nguồn: https://code.claude.com/docs/en/legal-and-compliance , https://code.claude.com/docs/en/authentication , https://claude.com/pricing

## 5. Cách tiếp tục (phiên Claude Code mới)
1. `cd D:\source\automationWorkFlow\devflow && git checkout feat/v3-multiuser`
2. Yêu cầu Claude: *"Đọc docs/HANDOFF.md, rồi triển khai kế hoạch docs/superpowers/plans/2026-11-06-v3-multiuser.md bằng /superpowers:subagent-driven-development"*.
3. Quy trình đã dùng cho v1/v2: mỗi task một subagent cài đặt (TDD) → reviewer độc lập → sửa → review tổng thể cuối → merge vào `main` → tag.
4. Sau khi xong: chạy `scripts/spike-claude-login.sh` trên VPS Linux để kiểm chứng đăng nhập seat (máy Windows hiện tại không kiểm thử được phần Linux/sudo).

## 6. Lưu ý vận hành
- Không chạy `npm audit fix --force` (hạ phiên bản exceljs/archiver, làm hỏng build). Lỗ hổng đã xử lý bằng `overrides` trong `package.json`.
- `git push` từ Claude bị chặn tự động — chủ dự án tự push: `git push origin <nhánh>` và `git push origin --tags`.
- Có một `git stash` cũ ("npm audit fix --force …") — có thể xóa bằng `git stash drop`.
- Thư mục gốc `D:\source\automationWorkFlow` chứa bộ khung `/lah` cá nhân của chủ dự án — không liên quan DevFlow, không sửa.
- Mẫu tài liệu công ty gốc: `D:\source\automationWorkFlow\templates\` (bản copy trong `devflow/templates/default/`).

## 7. Tiến độ v3 (cập nhật theo từng task)
Kế hoạch: `docs/superpowers/plans/2026-11-07-v3-implementation.md` (Task N = FEAT-00N trong `lah status`). Không push/PR; chủ dự án push.
- FEAT-002 (Task 2: quyền hạn và Google SSO) xong — commit 79a82c3, 6aba3ed.
- FEAT-003 (Task 3: dự án, thành viên, workspace theo thư mục) xong — commit 5cd4e67.
- FEAT-004 (Task 4: dfctl, SeatRunner, đăng nhập seat) xong — commits ad52b31..ae3b62b. CẦN kiểm chứng trên VPS: chạy 'sudo scripts/spike-claude-login.sh' (bước 8, 9) trước khi bật seat; xem rủi ro còn lại trong báo cáo Task 4.
