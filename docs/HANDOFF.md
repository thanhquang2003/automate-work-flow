# DevFlow — Ghi chú bàn giao (cập nhật 2026-11-07, sau Task 8)

## 1. Trạng thái hiện tại
- Nhánh làm việc: `feat/v3-multiuser` (chưa push; chủ dự án tự push). Task 8 làm trên `feat/FEAT-008`, merge fast-forward vào `feat/v3-multiuser`. `main` vẫn là **v2** (tag `v2`, commit `56a0931`).
- **Code v3 đã xong toàn bộ (Task 1-8)**: mô hình dữ liệu, quyền hạn và Google SSO, dự án/thành viên/worktree, dfctl + SeatRunner + đăng nhập seat, engine (seat, duyệt theo vai, đổi người chạy, task song song), web, khu vực giám sát, và E2E `tests/e2e/v3-multiuser.test.ts` + tài liệu triển khai.
- **Chưa làm được ở máy phát triển (chỉ VPS)**: mọi thứ cần root hoặc Claude thật. Danh sách kiểm tra đầy đủ: `docs/deploy-vps.md` mục 9. Phải chạy `sudo scripts/spike-claude-login.sh --cleanup` và bước 8, 9 của spike (`--seat <id> --worktree <đường dẫn>`) trước khi bật seat cho người dùng thật.
- Thiết kế: `docs/superpowers/specs/2026-11-06-v3-multiuser-projects-design.md` (gốc) và `docs/superpowers/specs/2026-11-07-v3-roles-and-lah-delta-design.md` (thắng khi mâu thuẫn). Kế hoạch: `docs/superpowers/plans/2026-11-07-v3-implementation.md`.
- Hợp nhất lên `main` và gắn tag v3 chỉ làm sau khi kiểm tra VPS đạt.

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

## 5. Cách tiếp tục
1. Đọc `docs/deploy-vps.md` (triển khai, rủi ro còn lại, danh sách kiểm tra VPS) và `docs/v3-release-notes.md`.
2. Trên VPS: `scripts/install-server.sh` rồi spike (mục 9 của deploy-vps.md). Nếu spike hỏng thì dùng phương án dự phòng trong spec 6b.3 (admin chạy `dfctl claude-auth <id> login` qua SSH).
3. Sửa những điều spike phát hiện (mẫu nhận diện lỗi seat, dạng `forceLoginOrgUUID`, quyền file trong `.git`), thêm test hồi quy cho mỗi lỗi.
4. Khi VPS đạt: push nhánh, merge `feat/v3-multiuser` vào `main`, gắn tag.
5. Quy trình đã dùng cho v1/v2/v3: mỗi task một subagent cài đặt (TDD) → reviewer độc lập → sửa → review tổng thể → merge fast-forward.

## 6. Lưu ý vận hành
- Không chạy `npm audit fix --force` (hạ phiên bản exceljs/archiver, làm hỏng build). Lỗ hổng đã xử lý bằng `overrides` trong `package.json`.
- `git push` từ Claude bị chặn tự động — chủ dự án tự push: `git push origin <nhánh>` và `git push origin --tags`.
- Có một `git stash` cũ ("npm audit fix --force …") — có thể xóa bằng `git stash drop`.
- Thư mục gốc `D:\source\automationWorkFlow` chứa bộ khung `/lah` cá nhân của chủ dự án — không liên quan DevFlow, không sửa.
- Mẫu tài liệu công ty gốc: `D:\source\automationWorkFlow\templates\` (bản copy trong `devflow/templates/default/`).

## 7. Tiến độ v3 và ánh xạ hàng đợi lah
Hàng đợi `lah` (state/feature_list.json): Task N của kế hoạch = `FEAT-00N`.

| Task | Mục | Nội dung | Commit chính |
|---|---|---|---|
| 1 | FEAT-001 | Mô hình dữ liệu v3 | d7252ec, 0da8080 |
| 2 | FEAT-002 | Quyền hạn và Google SSO | 79a82c3, 6aba3ed |
| 3 | FEAT-003 | Dự án, thành viên, workspace theo thư mục | 5cd4e67 |
| 4 | FEAT-004 | dfctl, SeatRunner, đăng nhập seat | ad52b31..ae3b62b |
| 5 | FEAT-005 | Engine: seat, duyệt theo vai, worktree song song | 27994b2..6d98b8b |
| 6 | FEAT-006 | Web: dự án, hộp việc, phân công, seat, quản trị | cf31ea5..4e49bb4 |
| 7 | FEAT-007 | Khu vực giám sát | b074be5..d65926e |
| 8 | FEAT-008 | E2E, tài liệu triển khai, release | xem `git log feat/FEAT-008` |

Báo cáo từng task (kèm rủi ro còn lại): `.superpowers/sdd/2026-11-07-v3-implementation/task-N-report.md`. Không push/PR từ Claude; chủ dự án tự push.

Lỗi tích hợp tìm thấy nhờ E2E (Task 8): một job "dispatcher" của DEVELOP còn tồn trong hàng đợi chạy sau khi yêu cầu đã sang bước khác và kéo yêu cầu quay lại cổng DEVELOP. Đã sửa (bỏ job cũ) kèm test hồi quy trong `tests/engine/v3-parallel.test.ts`.
- FEAT-008 (Task 8: E2E, tài liệu triển khai, ghi chú phát hành) xong — commits 97dc11e..2723cbb. Cả 8 task v3 đã xong; còn review toàn nhánh và kiểm chứng trên VPS (xem docs/deploy-vps.md §9).
