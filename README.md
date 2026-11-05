# DevFlow

Ứng dụng web tự động hóa quy trình phát triển phần mềm của công ty bằng **Claude Code headless** (gói subscription, có plugin superpowers): từ nhận yêu cầu, làm rõ với khách hàng, thiết kế, code, review, kiểm thử cho tới log bug lên GitLab.

Ưu tiên số 1 của DevFlow: **lộ ra các chỗ hổng của yêu cầu trước khi viết code**.

## Mục lục

1. [Giới thiệu và quy trình](#giới-thiệu-và-quy-trình)
2. [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
3. [Cài đặt chạy local](#cài-đặt-chạy-local)
4. [Cài đặt trên VPS (server mode)](#cài-đặt-trên-vps-server-mode)
5. [Cấu hình](#cấu-hình)
6. [Sử dụng](#sử-dụng)
7. [Mẫu tài liệu](#mẫu-tài-liệu)
8. [Lưu ý bảo mật](#lưu-ý-bảo-mật)
9. [Giới hạn subscription](#giới-hạn-subscription)
10. [Phát triển](#phát-triển)

## Giới thiệu và quy trình

DevFlow áp dụng cho cả **dự án mới** lẫn **thêm/sửa chức năng trên dự án có sẵn** (repo GitLab), mọi loại phần mềm (web, mobile, API, tiến trình ngầm) và nhiều ngôn ngữ (Java, Python, NodeJS...). Tài liệu xuất ra đúng mẫu công ty: TKCT, TKDB (.docx), Test case, ULNL (.xlsx).

Hai chế độ triển khai chung một mã nguồn:

- **local**: chạy trên máy cá nhân, dùng Claude của chính bạn, khảo sát khách hàng bằng file Excel, không cần đăng nhập.
- **server**: chạy trên một VPS riêng, nhiều người dùng, có thêm trang khảo sát công khai cho khách hàng.

Mỗi yêu cầu (`REQ-001`, `REQ-002`...) đi qua các giai đoạn:

| # | Giai đoạn | Tên tiếng Việt | Vai trò | Kết quả |
|---|-----------|----------------|---------|---------|
| 1 | `INTAKE` | Tiếp nhận | — | Lưu yêu cầu, file đính kèm; clone repo (dự án có sẵn) và tạo nhánh `devflow/<REQ>` |
| 2 | `CODEBASE_SCAN` | Khảo sát mã nguồn (chỉ dự án có sẵn) | Explorer | `codebase-map.md`: module, entry point, convention, lệnh build/test |
| 3 | `ANALYSIS` | Phân tích yêu cầu | Analyst | `analysis.md` (chức năng, phi chức năng, hiệu năng, chỗ hổng) và danh sách câu hỏi |
| 4 | `CLARIFY` | Làm rõ với khách hàng | — | File Excel câu hỏi (+ link khảo sát ở server mode); chờ trả lời; tối đa 5 vòng |
| 5 | `BREAKDOWN` | Bóc tách chức năng | Analyst | Danh sách chức năng và file ULNL (ước lượng nỗ lực) |
| 6 | `DESIGN` | Thiết kế | Architect | Lựa chọn công nghệ, TKCT, TKDB, sơ đồ mermaid |
| 7 | `PLANNING` | Lập kế hoạch và test case | Planner | Danh sách task có phụ thuộc, file Test case |
| 8 | `DEVELOP` | Phát triển (lặp theo task) | Developer, Reviewer | Mỗi task một nhánh và một MR vào `devflow/<REQ>`; review tối đa 3 vòng/task rồi merge |
| 9 | `TEST` | Kiểm thử | Tester | Chạy test, lưu evidence, điền file Test case; F thì tạo bug |
| 10 | `BUGFIX` | Sửa lỗi (lặp) | Developer, Reviewer | Sửa theo từng bug, merge, quay lại `TEST`; tối đa 3 lần sửa mỗi bug |
| 11 | `DONE` | Hoàn tất | — | Mở MR cuối `devflow/<REQ>` → nhánh mặc định (**không merge**), `report.md` |
| — | `CHANGE` | Thay đổi (chen ngang ở mọi bước) | Change Analyst | `changes/CR-NN/impact.md` + `impact.json`: phân tích tác động; chấp nhận thì quay lại bước sớm nhất cần làm lại (xem [Điều chỉnh yêu cầu](#điều-chỉnh-yêu-cầu-agile)) |

Mỗi giai đoạn có **checkpoint**: nếu server khởi động lại hoặc chạm giới hạn subscription, DevFlow chạy tiếp từ giai đoạn dở dang, không làm lại phần đã xong.

## Yêu cầu hệ thống

- **Node.js 24** trở lên (DevFlow dùng `node:sqlite` có sẵn, không cần module native).
- **git** có trong `PATH`.
- **Claude Code** đã cài và đăng nhập bằng gói subscription: chạy `claude login` (với đúng user sẽ chạy DevFlow).
- **Plugin superpowers** (các role Developer/Tester dùng kỹ năng TDD và systematic-debugging):

  ```bash
  claude plugin install superpowers@claude-plugins-official
  ```

  Hoặc trong Claude Code tương tác: `/plugin install superpowers@claude-plugins-official`. Nếu báo chưa có marketplace, thêm trước bằng `/plugin marketplace add anthropics/claude-plugins-official`.
- (Tùy chọn) Tài khoản GitLab và Personal Access Token quyền `api`, `write_repository` để làm việc với repo và log bug.
- (Tùy chọn, kiểm thử mobile) Android SDK với biến `ANDROID_HOME`. Nếu không có, phần giao diện mobile được đánh dấu **PE** với lý do "thiếu môi trường mobile".

## Cài đặt chạy local

```bash
git clone <địa-chỉ-repo-devflow> devflow
cd devflow
npm ci
npm run build
cp .env.example .env      # chỉnh nếu cần; mặc định chạy được ngay
npm start
```

Mở trình duyệt tại **http://127.0.0.1:3700** (hoặc `http://localhost:3700`). Chế độ local chỉ lắng nghe `127.0.0.1`, không yêu cầu đăng nhập, và từ chối truy cập qua tên miền khác (chống DNS rebinding).

`npm start` tự đọc file `.env` ở thư mục hiện tại (biến đã có trong môi trường được ưu tiên hơn `.env`). Dữ liệu nằm trong `DATA_DIR` (mặc định `./data`). Vào trang **Cài đặt** để nhập GitLab URL và token nếu làm việc với GitLab.

## Cài đặt trên VPS (server mode)

Dùng một VPS **riêng cho DevFlow** (không phải máy chủ GitLab, xem [Lưu ý bảo mật](#lưu-ý-bảo-mật)).

1. Tạo user riêng, cài Node 24, git, Claude Code; đăng nhập Claude bằng chính user đó và cài plugin superpowers:

   ```bash
   sudo useradd --system --create-home --home-dir /opt/devflow --shell /usr/sbin/nologin devflow
   sudo -u devflow -H claude login
   sudo -u devflow -H claude plugin install superpowers@claude-plugins-official
   ```

2. Lấy mã nguồn và build:

   ```bash
   sudo -u devflow git clone <địa-chỉ-repo-devflow> /opt/devflow/app
   cd /opt/devflow/app && sudo -u devflow npm ci && sudo -u devflow npm run build
   ```

3. Tạo file cấu hình `/etc/devflow.env` (quyền `600`), tối thiểu:

   ```ini
   DEVFLOW_MODE=server
   SECRET_KEY=<chuỗi ngẫu nhiên dài, ví dụ: openssl rand -hex 32>
   PUBLIC_BASE_URL=https://devflow.example.com
   TRUST_PROXY=1
   HOST=127.0.0.1
   DATA_DIR=/opt/devflow/data
   CLAUDE_BIN=/opt/devflow/.local/bin/claude
   ```

   - `SECRET_KEY` **bắt buộc** ở server mode; mất hoặc đổi khóa thì các token GitLab đã lưu không giải mã được.
   - `PUBLIC_BASE_URL` **bắt buộc** ở server mode (DevFlow không khởi động nếu thiếu): URL HTTPS công khai, dùng để tạo link khảo sát và kiểm tra nguồn gốc (Origin) của các yêu cầu POST.
   - `TRUST_PROXY=1` khi đứng sau một reverse proxy (Caddy) để rate limit lấy đúng IP khách; `HOST=127.0.0.1` để chỉ Caddy truy cập được cổng 3700.
   - `CLAUDE_BIN` nên là **đường dẫn đầy đủ**: PATH của systemd không có `~/.local/bin`, nên lệnh `claude` trần sẽ không tìm thấy. Xem đường dẫn bằng `sudo -u devflow -H bash -lc 'command -v claude'` (với user ở trên thường là `/opt/devflow/.local/bin/claude`; nếu home là `/home/devflow` thì là `/home/devflow/.local/bin/claude`).

4. Chạy như service **systemd**: dùng [`scripts/devflow.service`](scripts/devflow.service):

   ```bash
   sudo cp scripts/devflow.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now devflow
   journalctl -u devflow -f
   ```

5. **Tạo quản trị viên trước khi mở DevFlow ra Internet.** Khi chưa có tài khoản nào, trang `/setup` cho **bất kỳ ai truy cập đầu tiên** tạo quản trị viên. Vì vậy hãy tạo admin qua SSH tunnel khi DevFlow mới chỉ nghe ở `127.0.0.1`:

   ```bash
   ssh -L 3700:127.0.0.1:3700 <user>@<vps>
   # rồi mở http://localhost:3700/setup trên máy của bạn và tạo tài khoản admin
   ```

6. Reverse proxy HTTPS bằng **Caddy**: dùng [`Caddyfile.example`](Caddyfile.example) (đổi tên miền), đặt vào `/etc/caddy/Caddyfile` rồi `sudo systemctl reload caddy`. Caddy tự cấp và gia hạn chứng chỉ Let's Encrypt.

7. Mở `https://devflow.example.com`, đăng nhập bằng tài khoản admin vừa tạo; quản trị viên tạo thêm người dùng ở trang **Người dùng** (vai trò `admin`/`member`).

Ở server mode mọi trang đều cần đăng nhập, **trừ** `/s/*` (khảo sát khách hàng) và `/static/*`.

## Cấu hình

Cấu hình qua biến môi trường (hoặc file `.env`); xem [`.env.example`](.env.example). GitLab URL/token, group mặc định và số job song song còn có thể đặt trong trang **Cài đặt** (giá trị trong trang Cài đặt ghi đè biến môi trường). `CLAUDE_BIN` **chỉ** đặt qua biến môi trường (lệnh này được thực thi trên máy chủ nên không cho sửa từ giao diện web).

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `DEVFLOW_MODE` | `local` | `local` (máy cá nhân, không đăng nhập, bind `127.0.0.1`) hoặc `server` (có đăng nhập, bind `0.0.0.0`) |
| `HOST` | `127.0.0.1` (local) / `0.0.0.0` (server) | Địa chỉ lắng nghe |
| `PORT` | `3700` | Cổng web |
| `DATA_DIR` | `./data` | Thư mục dữ liệu: SQLite, workspace từng yêu cầu, template tải lên, cache |
| `SECRET_KEY` | (trống) | Khóa mã hóa token GitLab AES-256-GCM. Bắt buộc ở server mode. Local để trống thì tự tạo `DATA_DIR/secret.key` |
| `CLAUDE_BIN` | `claude` | Lệnh Claude Code; chỉ đặt qua biến môi trường. Trên VPS (systemd) dùng đường dẫn đầy đủ, ví dụ `/opt/devflow/.local/bin/claude`. Trên Windows có thể trỏ thẳng tới file `.cmd` |
| `CLAUDE_BIN_ARGS` | (trống) | Tham số đặt trước tham số của claude (JSON mảng hoặc cách nhau bằng dấu cách); chủ yếu cho kiểm thử |
| `CLAUDE_MOCK` | `0` | `1` = dùng Claude giả lập (chỉ cho kiểm thử, không dùng khi chạy thật) |
| `MAX_CONCURRENT_JOBS` | `1` (local) / `2` (server) | Số job Claude chạy đồng thời |
| `SURVEY_TTL_DAYS` | `14` | Số ngày link khảo sát còn hiệu lực |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` (local) | URL công khai, dùng cho link khảo sát và kiểm tra Origin. **Bắt buộc** ở server mode |
| `GITLAB_URL` | (trống) | Địa chỉ GitLab, ví dụ `https://gitlab.example.com` |
| `GITLAB_TOKEN` | (trống) | Personal Access Token chung (quyền `api`, `write_repository`) |
| `GITLAB_DEFAULT_GROUP` | (trống) | Group mặc định khi tạo project GitLab mới |
| `RATE_LIMIT_PAUSE_MIN` | `30` | Số phút tạm dừng khi chạm giới hạn subscription nếu Claude không báo thời điểm reset |
| `STAGE_TIMEOUT_MIN` | `120` | Thời gian tối đa (phút) cho một lần chạy Claude; quá hạn thì DevFlow dừng tiến trình Claude và coi lần chạy đó là lỗi (bước bị lỗi thì bấm **Chạy lại bước**). `0` = không giới hạn |
| `CR_AUTO_ACCEPT_MAX_MH` | `40` | Ngưỡng nỗ lực (man-hour) để tự chấp nhận yêu cầu thay đổi ở chế độ auto; CR bỏ phạm vi hoặc vượt ngưỡng luôn chờ người quyết định |
| `TRUST_PROXY` | `false` | `true` hoặc số tầng proxy khi đứng sau reverse proxy |
| `ANDROID_HOME` | (trống) | (Tùy chọn) Android SDK cho kiểm thử mobile; DevFlow chỉ đọc để báo cho Tester |

## Sử dụng

### Tạo yêu cầu

Chọn **Yêu cầu → Tạo yêu cầu mới** và điền: tiêu đề, mô tả, yêu cầu hiệu năng, yêu cầu phi chức năng, file đính kèm (tối đa 50MB/file), loại phần mềm (web/mobile/api/background), loại dự án và chế độ chạy.

- **Dự án có sẵn**: nhập GitLab project (`nhom/ten-du-an` hoặc id). DevFlow clone repo và khảo sát mã nguồn trước khi phân tích.
- **Dự án mới**: nhập tên project GitLab mới (tạo trong `GITLAB_DEFAULT_GROUP`) hoặc dùng project trống; để trống nếu chưa dùng GitLab, DevFlow tạo repo git cục bộ trong workspace (code chỉ nằm trên máy này).

### Chế độ tự động và duyệt từng bước

- **Tự động**: chạy toàn trình, không dừng giữa các giai đoạn. Chỉ dừng khi cần khách hàng trả lời câu hỏi hoặc cần can thiệp thủ công.
- **Duyệt từng bước**: sau các giai đoạn khảo sát mã nguồn, phân tích, bóc tách, thiết kế, lập kế hoạch và phát triển (sau khi xong tất cả task), yêu cầu dừng ở "Chờ duyệt". Bấm **Approve** để đi tiếp, hoặc **Reject** kèm nhận xét để chạy lại giai đoạn đó với nhận xét làm đầu vào.

Ở cả hai chế độ có thể **Tạm dừng / Tiếp tục / Hủy** trên trang chi tiết, và **Chạy lại bước** khi bước bị lỗi hoặc cần người xử lý; log Claude hiển thị realtime.

### Khảo sát khách hàng (Excel hoặc web)

Khi phân tích còn điểm chưa rõ, yêu cầu chuyển sang "Chờ khách hàng" ở giai đoạn `CLARIFY`:

1. **Excel** (cả local và server): tab **Câu hỏi** → tải `Questions_<REQ>_round<N>.xlsx`, gửi khách hàng. Khách điền cột **Trả lời của khách hàng** (cột có danh sách chọn khi câu hỏi có phương án), gửi lại; nhân viên **nhập file** ở cùng tab, DevFlow đọc theo cột ID.
2. **Web** (chỉ server mode): tab **Câu hỏi** → **Tạo link khảo sát**, gửi link `https://<host>/s/<token>` cho khách. Link không cần đăng nhập, hết hạn sau `SURVEY_TTL_DAYS` ngày, khách lưu nháp rồi bấm "Gửi".

Nhân viên cũng có thể nhập hoặc sửa câu trả lời thay khách (ghi rõ nguồn). Khi đã đủ câu **bắt buộc (must)** thì bấm **Tiếp tục**; câu "nên hỏi (should)" chưa trả lời được ghi thành **giả định**. Nếu Analyst còn câu hỏi mới, sẽ có vòng tiếp theo (tối đa 5 vòng; hết 5 vòng, điểm còn lại buộc chuyển thành giả định). Giả định luôn nằm ở mục "Câu hỏi mở và giả định" của tài liệu để khách xác nhận sau.

### Điều chỉnh yêu cầu (Agile)

Yêu cầu của khách hàng thường đổi giữa chừng. DevFlow cho phép gửi **yêu cầu thay đổi (CR)** ở mọi bước, không phải làm lại từ đầu. Chi tiết thiết kế: [`docs/superpowers/specs/2026-11-05-agile-change-requests-design.md`](docs/superpowers/specs/2026-11-05-agile-change-requests-design.md).

- **Gửi CR ở mọi bước**: tab **Thay đổi** của trang chi tiết yêu cầu (tiêu đề, mô tả, loại `add` / `modify` / `remove` / `nfr` / `other`, file đính kèm). Mã CR theo từng yêu cầu: `CR-01`, `CR-02`... Không gửi được CR khi yêu cầu đã bị hủy. Bước đang chạy bị ngắt và chuyển sang bước `CHANGE`.
- **Đề xuất của khách hàng**: khách có thể gửi đề xuất thay đổi ngay trên trang khảo sát. Đề xuất ở trạng thái `proposed` và **không ảnh hưởng tới luồng** cho đến khi nhân viên bấm **Nhận đề xuất** (thành CR `pending`) hoặc **Từ chối** (kèm lý do).
- **Bước `CHANGE` — phân tích tác động**: vai trò Change Analyst đọc tài liệu, mã nguồn và tiến độ hiện tại rồi ghi `docs/devflow/changes/CR-NN/impact.md` + `impact.json` (chức năng, task, test case bị ảnh hưởng; nỗ lực tăng/giảm theo man-hour; rủi ro; câu hỏi cho khách hàng; bước cần quay lại). Xem ở màn hình **Tác động** của CR.
- **Khi nào phải duyệt**: chế độ `review` luôn chờ người duyệt. Chế độ `auto` tự chấp nhận, **trừ** khi CR có phần **bỏ phạm vi** (`remove`) hoặc nỗ lực tăng thêm lớn hơn `CR_AUTO_ACCEPT_MAX_MH` (mặc định 40 MH) — các CR này dừng ở bước `CHANGE` chờ nhân viên quyết định.
- **Chấp nhận / từ chối**: chấp nhận thì phạm vi được cập nhật, phiên bản yêu cầu tăng lên (`v1` → `v2`...) và yêu cầu **quay lại bước sớm nhất mà thay đổi cần** (không sớm hơn `ANALYSIS`, không muộn hơn bước yêu cầu đang ở; nếu đã `DONE` thì không muộn hơn `TEST`). Câu hỏi bắt buộc mới cho khách làm yêu cầu quay lại `ANALYSIS`/`CLARIFY`. Từ chối (bắt buộc ghi lý do) thì yêu cầu trở về đúng bước và trạng thái trước khi có CR, không chạy thêm gì.
- **Chỉ làm phần thay đổi**: các bước sau chạy theo kiểu cập nhật — giữ ID cũ, task đã xong và kết quả kiểm thử không bị ảnh hưởng thì không làm lại; chỉ task/test case bị tác động quay về `todo`/chạy lại. Mọi merge mới vào `devflow/<REQ>` sau lần Pass của một test case đều kích hoạt kiểm thử hồi quy.
- **Phiên bản tài liệu `_vN`**: `TKCT_<REQ>_v<N>.docx`, `TKDB_<REQ>_v<N>.docx`, `ULNL_<REQ>_v<N>.xlsx`, `TestCase_<REQ>_v<N>.xlsx`; bản cũ luôn được giữ. TKCT có mục PHỤ LỤC › **Lịch sử thay đổi** liệt kê các CR đã chấp nhận.
- **Hủy theo CR-NN**: phần bị bỏ không bao giờ bị xóa, chỉ đánh dấu `cancelled` (kèm CR gây ra). Trong ULNL và Test case vẫn hiện dòng ghi "Hủy theo CR-NN", không tính nỗ lực và không tính vào P/F/PE; task bị hủy không được phát triển, bug của test case bị hủy được đóng.
- **Vòng lặp (iteration)**: CR được chấp nhận khi yêu cầu đã `DONE` mở **vòng lặp mới** (iteration + 1) trên cùng nhánh `devflow/<REQ>` và cùng MR cuối: không tạo MR thứ hai, chỉ thêm ghi chú cho vòng mới vào MR cuối đang mở và `report.md` có mục "Các thay đổi trong vòng này". Số vòng làm rõ (tối đa 5) được tính lại theo từng phiên bản.
- **Khi CR cắt ngang lúc đang code**: nếu cây làm việc còn thay đổi dở dang, DevFlow cất vào `git stash` (kèm ghi chú) trước khi phân tích; stash **không tự động pop** vì CR có thể làm đổi hướng phần việc đó — lấy lại bằng `git stash list` / `git stash pop` trong workspace khi cần.

### Tài liệu đầu ra

Tab **Tài liệu** liệt kê và cho tải từng file, hoặc **Tải gói kết quả (.zip)** gồm cả evidence:

- `TKCT_<REQ>_v<N>.docx`, `TKDB_<REQ>_v<N>.docx`: thiết kế chi tiết và thiết kế cơ sở dữ liệu (TKCT có PHỤ LỤC › "Lịch sử thay đổi" khi đã có yêu cầu thay đổi được chấp nhận).
- `ULNL_<REQ>_v<N>.xlsx`: ước lượng nỗ lực theo chức năng và hạng mục phi chức năng; chức năng bị hủy vẫn hiện, ghi "Hủy theo CR-NN" và không tính nỗ lực.
- `TestCase_<REQ>_v<N>.xlsx`: test case, kết quả lần 1 và lần 2, đường dẫn evidence, comment; test case bị hủy ghi "Hủy theo CR-NN" và không tính vào P/F/PE.
- `<N>` là phiên bản yêu cầu (tăng mỗi khi chấp nhận một yêu cầu thay đổi); các phiên bản cũ được giữ lại. File không có hậu tố `_v<N>` (tạo trước khi có phiên bản) được coi là v1.
- `evidence/<TC-ID>/`: ảnh chụp, request/response, log chứng minh test case Pass.
- `report.md`: báo cáo tổng kết (số P/F/PE, bug, MR cuối, giả định còn mở; mục "Các thay đổi trong vòng này" khi vòng lặp có yêu cầu thay đổi).
- Tài liệu markdown, JSON, sơ đồ `.mmd` cũng được commit lên nhánh `devflow/<REQ>` trong thư mục `docs/devflow/`.

### Bug trên GitLab

Khi Tester đánh dấu test case **F**, DevFlow tạo issue `[<REQ>][<TC-ID>] <mục đích>` (label `bug`, `devflow`, `<REQ>`) kèm bước tái hiện, kết quả mong đợi/thực tế, evidence và link MR; link issue được ghi vào cột Comment của test case. Sau mỗi lần sửa và test lại, DevFlow thêm comment; test case **P** thì issue được đóng. Không có GitLab thì bug chỉ ghi nhận trong DevFlow (tab **Bug**).

Nhánh sửa lỗi là `devflow/<REQ>-fix-<TC-ID>`, MR vào `devflow/<REQ>`; nhánh task là `devflow/<REQ>-<TASK>`.

### Điều kiện hoàn thành

Một yêu cầu chỉ `DONE` khi **mọi test case** là:

- **P** (Pass) kèm **ít nhất một file evidence** trong `evidence/<TC-ID>/`; DevFlow tự hạ P thiếu evidence thành F với comment "thiếu evidence", hoặc
- **PE** (Pending) khi không thể kiểm thử vì thiếu môi trường/điều kiện bắt buộc, có ghi lý do ở cột Comment.

Khi hoàn tất, DevFlow đẩy `devflow/<REQ>` và **mở MR vào nhánh mặc định nhưng không merge** — người duyệt tự merge. DevFlow không bao giờ push hay merge thẳng vào nhánh mặc định của repo.

### NEEDS_HUMAN

Yêu cầu chuyển sang `NEEDS_HUMAN` ("Cần can thiệp thủ công") khi:

- một task bị Reviewer từ chối 3 vòng liên tiếp;
- một bug sửa quá 3 lần vẫn chưa qua (issue được gắn label `needs-human`);
- stage báo cần người xử lý.

Xem log trên trang chi tiết để biết lý do, xử lý (sửa tay trên nhánh `devflow/<REQ>`, bổ sung thông tin...) rồi bấm **Chạy lại bước**.

**Bug sửa quá 3 lần (dừng ở giai đoạn `BUGFIX`)** — cách xử lý:

1. Lấy nhánh `devflow/<REQ>` về máy (`git fetch && git checkout devflow/<REQ>`), tự sửa lỗi và commit.
2. `git push` nhánh `devflow/<REQ>` (không push vào nhánh mặc định). Không có GitLab thì sửa trực tiếp trong repo của workspace `DATA_DIR/workspaces/<REQ>/repo` trên nhánh đó.
3. Bấm **Chạy lại bước** trên trang chi tiết. Bước `BUGFIX` bỏ qua các bug đã chuyển sang người xử lý (không sửa thêm lần nào) nên chuyển ngay sang `TEST`; `TEST` kéo nhánh về (bao gồm bản sửa tay của bạn) rồi **kiểm thử lại** các test case đó. Pass thì issue được đóng và yêu cầu đi tiếp; vẫn Fail thì issue nhận comment kết quả mới và yêu cầu lại dừng ở `NEEDS_HUMAN` (DevFlow không tự sửa thêm bug đã quá 3 lần).

## Mẫu tài liệu

DevFlow đi kèm 4 mẫu mặc định trong `templates/default/`: `tkct.docx`, `tkdb.docx`, `testcase.xlsx`, `ulnl.xlsx`, cùng `mapping.json` (ánh xạ sheet/dòng/cột cho 2 file Excel).

- Vào trang **Mẫu tài liệu** để tải mẫu hiện dùng, **tải lên** mẫu công ty thay thế từng loại (đúng định dạng `.docx`/`.xlsx`) hoặc **đặt lại** về mẫu mặc định. Mẫu tải lên lưu ở `DATA_DIR/templates/` và được ưu tiên hơn mẫu mặc định.
- Word (TKCT, TKDB): DevFlow giữ phần đầu của mẫu (trang ký, mục lục, styles, header/footer) và thay phần thân từ Heading 1 đầu tiên bằng nội dung do Claude sinh ra, đúng dàn ý của mẫu.
- Excel: Test case ghi từ dòng 12 của sheet `2. FUNCTIONAL TESTCASE`; ULNL ghi vào sheet `EFFORT_FUNCTION` và `EFFORT NON-FUNCTION`. Nếu mẫu công ty đổi bố cục (sheet, dòng đầu, cột), chỉnh `templates/default/mapping.json` cho khớp.

## Lưu ý bảo mật

- **Claude Code chạy với `bypassPermissions`** trong workspace của yêu cầu: có thể đọc/ghi file, chạy lệnh, cài gói mà không hỏi. Chỉ chạy DevFlow trên **máy hoặc VPS dành riêng**, không chứa dữ liệu hay khóa khác; dùng user hệ điều hành riêng, không phải root. Không đặt DevFlow chung máy chủ GitLab.
- Tiến trình Claude **không** nhận các biến môi trường bí mật của DevFlow (`SECRET_KEY`, `GITLAB_*`, `GIT_CONFIG_*`, `CLAUDE_MOCK`, `CLAUDE_BIN_ARGS`). Tuy vậy Claude vẫn làm việc trong repo đã clone và có thể chạy `git push`; DevFlow chỉ push nhánh `devflow/*`, nhưng hãy **bật Protected branches trên GitLab cho nhánh mặc định** (chỉ Maintainer được merge, không ai được push) làm lớp bảo vệ cuối, và dùng token có quyền tối thiểu (Developer).
- Chế độ local không có đăng nhập nên chỉ chấp nhận yêu cầu có header `Host` là `localhost`, `127.0.0.1` hoặc `[::1]` (hoặc đúng địa chỉ đặt trong `HOST`); tên miền khác bị từ chối 403 (chống DNS rebinding).
- Token GitLab lưu trong DB được **mã hóa AES-256-GCM** bằng `SECRET_KEY`; hãy sao lưu và bảo vệ khóa (file `.env`/`/etc/devflow.env` quyền `600`).
- Mật khẩu người dùng băm bằng scrypt; session cookie httpOnly; các yêu cầu POST được kiểm tra nguồn gốc (Origin).
- **Trang khảo sát `/s/<token>` là công khai**: ai có link đều trả lời được. Token ngẫu nhiên 32 byte, hết hạn sau `SURVEY_TTL_DAYS` ngày, có rate limit theo IP; chỉ gửi link cho đúng khách hàng và không đưa thông tin nhạy cảm vào nội dung câu hỏi.
- Server mode phải đặt sau HTTPS (Caddy). Đừng mở cổng 3700 trực tiếp ra Internet; đặt `HOST=127.0.0.1`.
- Mã nguồn của khách và tài liệu được lưu trong `DATA_DIR/workspaces/<REQ>/`; kiểm soát quyền truy cập và sao lưu thư mục này.

## Giới hạn subscription

DevFlow dùng gói subscription của Claude Code nên bị giới hạn theo khung thời gian (ví dụ 5 giờ):

- Mọi việc gọi Claude đi qua **hàng đợi**; số job đồng thời tối đa là `MAX_CONCURRENT_JOBS` (mặc định 1 ở local, 2 ở server). Tăng số này làm chạm giới hạn nhanh hơn.
- Khi Claude báo chạm giới hạn, DevFlow **tự tạm dừng** yêu cầu đó (trạng thái "Tạm dừng") đến thời điểm reset Claude báo, hoặc sau `RATE_LIMIT_PAUSE_MIN` phút nếu không có thông tin, rồi **tự chạy lại** đúng giai đoạn dở dang — không mất kết quả đã có.
- Nếu tắt/khởi động lại DevFlow, các job đang chạy được khôi phục và chạy lại từ checkpoint.

## Phát triển

```bash
npm ci
npm test                 # vitest: toàn bộ test, gồm E2E trong tests/e2e
npx tsc --noEmit         # kiểm tra kiểu
npm run dev              # chạy với tsx watch
npm run build            # biên dịch ra dist/
```

- Test **không bao giờ gọi Claude thật hay GitLab thật**. `CLAUDE_MOCK=1` làm runner dùng `src/claude/mock.ts`; test đăng ký handler bằng `setMockHandler` (xem `tests/fixtures/mock-claude.ts`, mỗi prompt bắt đầu bằng dòng `ROLE: <role>` để nhận biết vai trò).
- `tests/e2e/full-pipeline.test.ts` chạy cả ứng dụng (server + Pipeline + Worker) qua HTTP với Claude giả lập, GitLab giả (`tests/fixtures/fake-gitlab.ts`) và một bare git remote cục bộ: tạo yêu cầu, trả lời câu hỏi bằng Excel, phát triển, test F rồi P, tạo và đóng bug, MR cuối mở không merge.
- Prompt của từng vai trò nằm trong `prompts/*.md`; thiết kế chi tiết trong `docs/superpowers/specs/2026-11-04-devflow-design.md`.
