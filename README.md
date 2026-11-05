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

Mở trình duyệt tại **http://127.0.0.1:3700**. Chế độ local chỉ lắng nghe `127.0.0.1` và không yêu cầu đăng nhập.

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
   ```

   - `SECRET_KEY` **bắt buộc** ở server mode; mất hoặc đổi khóa thì các token GitLab đã lưu không giải mã được.
   - `PUBLIC_BASE_URL` là URL HTTPS công khai: dùng để tạo link khảo sát và kiểm tra nguồn gốc (Origin) của các yêu cầu POST.
   - `TRUST_PROXY=1` khi đứng sau một reverse proxy (Caddy) để rate limit lấy đúng IP khách; `HOST=127.0.0.1` để chỉ Caddy truy cập được cổng 3700.

4. Reverse proxy HTTPS bằng **Caddy**: dùng [`Caddyfile.example`](Caddyfile.example) (đổi tên miền), đặt vào `/etc/caddy/Caddyfile` rồi `sudo systemctl reload caddy`. Caddy tự cấp và gia hạn chứng chỉ Let's Encrypt.

5. Chạy như service **systemd**: dùng [`scripts/devflow.service`](scripts/devflow.service):

   ```bash
   sudo cp scripts/devflow.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now devflow
   journalctl -u devflow -f
   ```

6. Mở `https://devflow.example.com`. Lần đầu chưa có tài khoản, DevFlow chuyển tới trang `/setup` để tạo **quản trị viên** đầu tiên; sau đó quản trị viên tạo thêm người dùng ở trang **Người dùng** (vai trò `admin`/`member`).

Ở server mode mọi trang đều cần đăng nhập, **trừ** `/s/*` (khảo sát khách hàng) và `/static/*`.

## Cấu hình

Cấu hình qua biến môi trường (hoặc file `.env`); xem [`.env.example`](.env.example). GitLab URL/token, `CLAUDE_BIN` và số job song song còn có thể đặt trong trang **Cài đặt** (giá trị trong trang Cài đặt ghi đè biến môi trường).

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `DEVFLOW_MODE` | `local` | `local` (máy cá nhân, không đăng nhập, bind `127.0.0.1`) hoặc `server` (có đăng nhập, bind `0.0.0.0`) |
| `HOST` | `127.0.0.1` (local) / `0.0.0.0` (server) | Địa chỉ lắng nghe |
| `PORT` | `3700` | Cổng web |
| `DATA_DIR` | `./data` | Thư mục dữ liệu: SQLite, workspace từng yêu cầu, template tải lên, cache |
| `SECRET_KEY` | (trống) | Khóa mã hóa token GitLab AES-256-GCM. Bắt buộc ở server mode. Local để trống thì tự tạo `DATA_DIR/secret.key` |
| `CLAUDE_BIN` | `claude` | Lệnh Claude Code |
| `CLAUDE_BIN_ARGS` | (trống) | Tham số đặt trước tham số của claude (JSON mảng hoặc cách nhau bằng dấu cách); chủ yếu cho kiểm thử |
| `CLAUDE_MOCK` | `0` | `1` = dùng Claude giả lập (chỉ cho kiểm thử, không dùng khi chạy thật) |
| `MAX_CONCURRENT_JOBS` | `1` (local) / `2` (server) | Số job Claude chạy đồng thời |
| `SURVEY_TTL_DAYS` | `14` | Số ngày link khảo sát còn hiệu lực |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | URL công khai, dùng cho link khảo sát và kiểm tra Origin (server mode) |
| `GITLAB_URL` | (trống) | Địa chỉ GitLab, ví dụ `https://gitlab.example.com` |
| `GITLAB_TOKEN` | (trống) | Personal Access Token chung (quyền `api`, `write_repository`) |
| `GITLAB_DEFAULT_GROUP` | (trống) | Group mặc định khi tạo project GitLab mới |
| `RATE_LIMIT_PAUSE_MIN` | `30` | Số phút tạm dừng khi chạm giới hạn subscription nếu Claude không báo thời điểm reset |
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

Ở cả hai chế độ có thể **Tạm dừng / Tiếp tục / Hủy** và **Chạy lại giai đoạn** trên trang chi tiết; log Claude hiển thị realtime.

### Khảo sát khách hàng (Excel hoặc web)

Khi phân tích còn điểm chưa rõ, yêu cầu chuyển sang "Chờ khách hàng" ở giai đoạn `CLARIFY`:

1. **Excel** (cả local và server): tab **Câu hỏi** → tải `Questions_<REQ>_round<N>.xlsx`, gửi khách hàng. Khách điền cột **Trả lời của khách hàng** (cột có danh sách chọn khi câu hỏi có phương án), gửi lại; nhân viên **nhập file** ở cùng tab, DevFlow đọc theo cột ID.
2. **Web** (chỉ server mode): tab **Câu hỏi** → **Tạo link khảo sát**, gửi link `https://<host>/s/<token>` cho khách. Link không cần đăng nhập, hết hạn sau `SURVEY_TTL_DAYS` ngày, khách lưu nháp rồi bấm "Gửi".

Nhân viên cũng có thể nhập hoặc sửa câu trả lời thay khách (ghi rõ nguồn). Khi đã đủ câu **bắt buộc (must)** thì bấm **Tiếp tục**; câu "nên hỏi (should)" chưa trả lời được ghi thành **giả định**. Nếu Analyst còn câu hỏi mới, sẽ có vòng tiếp theo (tối đa 5 vòng; hết 5 vòng, điểm còn lại buộc chuyển thành giả định). Giả định luôn nằm ở mục "Câu hỏi mở và giả định" của tài liệu để khách xác nhận sau.

### Tài liệu đầu ra

Tab **Tài liệu** liệt kê và cho tải từng file, hoặc **Tải gói kết quả (.zip)** gồm cả evidence:

- `TKCT_<REQ>.docx`, `TKDB_<REQ>.docx`: thiết kế chi tiết và thiết kế cơ sở dữ liệu.
- `ULNL_<REQ>.xlsx`: ước lượng nỗ lực theo chức năng và hạng mục phi chức năng.
- `TestCase_<REQ>.xlsx`: test case, kết quả lần 1 và lần 2, đường dẫn evidence, comment.
- `evidence/<TC-ID>/`: ảnh chụp, request/response, log chứng minh test case Pass.
- `report.md`: báo cáo tổng kết (số P/F/PE, bug, MR cuối, giả định còn mở).
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

Xem log trên trang chi tiết để biết lý do, xử lý (sửa tay trên nhánh `devflow/<REQ>`, bổ sung thông tin...) rồi bấm **Chạy lại giai đoạn**.

## Mẫu tài liệu

DevFlow đi kèm 4 mẫu mặc định trong `templates/default/`: `tkct.docx`, `tkdb.docx`, `testcase.xlsx`, `ulnl.xlsx`, cùng `mapping.json` (ánh xạ sheet/dòng/cột cho 2 file Excel).

- Vào trang **Mẫu tài liệu** để tải mẫu hiện dùng, **tải lên** mẫu công ty thay thế từng loại (đúng định dạng `.docx`/`.xlsx`) hoặc **đặt lại** về mẫu mặc định. Mẫu tải lên lưu ở `DATA_DIR/templates/` và được ưu tiên hơn mẫu mặc định.
- Word (TKCT, TKDB): DevFlow giữ phần đầu của mẫu (trang ký, mục lục, styles, header/footer) và thay phần thân từ Heading 1 đầu tiên bằng nội dung do Claude sinh ra, đúng dàn ý của mẫu.
- Excel: Test case ghi từ dòng 12 của sheet `2. FUNCTIONAL TESTCASE`; ULNL ghi vào sheet `EFFORT_FUNCTION` và `EFFORT NON-FUNCTION`. Nếu mẫu công ty đổi bố cục (sheet, dòng đầu, cột), chỉnh `templates/default/mapping.json` cho khớp.

## Lưu ý bảo mật

- **Claude Code chạy với `bypassPermissions`** trong workspace của yêu cầu: có thể đọc/ghi file, chạy lệnh, cài gói mà không hỏi. Chỉ chạy DevFlow trên **máy hoặc VPS dành riêng**, không chứa dữ liệu hay khóa khác; dùng user hệ điều hành riêng, không phải root. Không đặt DevFlow chung máy chủ GitLab.
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
