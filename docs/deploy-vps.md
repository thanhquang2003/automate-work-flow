# Triển khai DevFlow v3 lên VPS dùng chung

Tài liệu này dành cho người chủ triển khai (có quyền root trên VPS). Phần mềm và các script đã được kiểm thử trên máy phát triển, nhưng **mọi thứ cần root hoặc cần Claude thật chưa từng chạy ở đó**. Vì vậy phải làm hết mục 9 (danh sách kiểm tra thủ công) trước khi cho người dùng thật vào.

## 1. Mô hình chạy trong một đoạn

DevFlow (user hệ thống `devflow`) là một dịch vụ web. Mỗi người dùng Google của công ty có một tài khoản Linux riêng `dfu-<id>` (không có shell đăng nhập, home `/var/lib/devflow/users/<id>`), và mỗi lần chạy Claude cho họ, DevFlow gọi `sudo -n dfctl run-claude ...` để chạy **binary `claude` nguyên bản** dưới tài khoản đó, bằng seat Claude Team của chính người đó. DevFlow không đọc, không lưu, không ghi log thông tin đăng nhập Claude. Mỗi dự án là một thư mục (một repo git) nằm dưới `PROJECT_ROOTS`, có group `dfp-<id>`; mỗi yêu cầu và mỗi task chạy trong một git worktree riêng ở `<dự án>/.devflow/worktrees/`.

## 2. Yêu cầu của VPS

- Ubuntu (đã tính cho 22.04/24.04), systemd, `util-linux` (cần `setpriv`, `script`, `setsid`, `flock`), `sudo`/`visudo`, `git` từ 2.43 trở lên, Node 24.
- Binary `claude` cài **toàn hệ thống, thuộc root**, ví dụ `/usr/local/bin/claude` (cài bằng `npm i -g` với root). Bản cài theo từng user (`~/.local/bin`) bị script từ chối. File không được ghi được bởi group/others.
- `cron` và `at` phải cấm cho các tài khoản `dfu-*` (dfctl tự thêm vào `/etc/cron.deny` và `/etc/at.deny` khi tạo tài khoản; nếu máy có `/etc/cron.allow` hoặc `/etc/at.allow` thì phải bỏ chúng đi hoặc chắc chắn không liệt kê `dfu-*`, vì khi có file allow thì file deny bị bỏ qua và script cài đặt sẽ báo lỗi).
- Kernel: `fs.protected_hardlinks=1` và `fs.protected_symlinks=1`. Kiểm tra bằng `sysctl fs.protected_hardlinks fs.protected_symlinks`; Ubuntu mặc định là 1. dfctl từ chối chạy (mã thoát 86) nếu một trong hai bằng 0. Nếu cần đặt: tạo `/etc/sysctl.d/99-devflow.conf` với hai dòng trên rồi `sudo sysctl --system`.
- Không đặt `ALLOW_NO_SYSTEMD_SCOPE=1` trong `/etc/devflow/dfctl.conf` trên VPS: tùy chọn đó chỉ dành cho máy không có systemd và làm mất đảm bảo "dọn hết tiến trình của seat sau mỗi lần chạy".
- Một VPS riêng cho DevFlow (không dùng chung với máy chủ GitLab).

## 3. Cài đặt bằng `scripts/install-server.sh`

```bash
sudo CLAUDE_TEAM_ORG_UUID=<uuid-org> PROJECT_ROOTS=/srv/projects scripts/install-server.sh
```

Biến cho script: `CLAUDE_TEAM_ORG_UUID` (bắt buộc, xem mục 5), `PROJECT_ROOTS` (bắt buộc, đường dẫn tuyệt đối thường, cách nhau dấu phẩy, giống giá trị trong file env của DevFlow), và tùy chọn `CLAUDE_BIN`, `DEVFLOW_DIR`, `NODE_BIN`, `ENV_FILE` (mặc định `/etc/devflow/devflow.env`). Script chạy lại được, không xóa gì và không đụng vào nội dung dự án. Nó tạo: user `devflow`, `/var/lib/devflow/{users,data}`, `dfctl` ở `/usr/local/lib/devflow/dfctl` (root, 0755, chạy self-test), `/etc/devflow/dfctl.conf`, một luật sudoers chỉ cho đúng dfctl (kiểm bằng `visudo`, tắt ghi I/O để mã đăng nhập người dùng gõ không bị ghi lại), managed settings của Claude Code (file cũ được sao lưu), và unit systemd `devflow` (enable, chưa start; `ExecStopPost` gọi `dfctl reap`).

Sau script: sửa file env, build bằng user `devflow` (`npm ci && npm run build`), chạy bước kiểm tra ở mục 9, rồi `systemctl start devflow`. Đặt Caddy phía trước theo `Caddyfile.example` (`TRUST_PROXY=1`, `HOST=127.0.0.1`).

## 4. Google OAuth client

1. Trong Google Cloud Console tạo OAuth client loại "Web application".
2. Authorized redirect URI: `${PUBLIC_BASE_URL}/auth/google/callback`, ví dụ `https://devflow.example.com/auth/google/callback`. Phải khớp từng ký tự với `PUBLIC_BASE_URL` trong file env (DevFlow dùng chính giá trị này để kiểm tra lúc đổi code).
3. Điền `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Đăng nhập chỉ nhận email đã xác minh có tên miền trong `ALLOWED_EMAIL_DOMAINS`.

## 5. Claude Team: org UUID và managed settings

Lấy UUID của tổ chức Claude Team trong trang quản trị của Anthropic và truyền vào `CLAUDE_TEAM_ORG_UUID`. Script ghi `/etc/claude-code/managed-settings.json` với `forceLoginMethod: "claudeai"` và `forceLoginOrgUUID`, để mọi seat trên máy chỉ đăng nhập được vào tổ chức của công ty.

**Chưa kiểm chứng:** script ghi `forceLoginOrgUUID` là một chuỗi; có tài liệu/phiên bản của Claude Code dùng mảng (`["<uuid>"]`). Cách kiểm tra: sau khi cài, chạy bước spike (mục 9) và xem `claude auth status` của một tài khoản thử có chấp nhận tổ chức công ty và từ chối tài khoản ngoài tổ chức không; nếu setting bị bỏ qua hoặc báo lỗi cú pháp, đổi giá trị trong file đó sang dạng mảng (hoặc ngược lại), kiểm tra lại, rồi cập nhật script cho khớp. Đối chiếu với tài liệu của đúng phiên bản `claude` đã cài (`claude --version`).

## 6. Biến môi trường (file env, quyền 600)

| Biến | Ý nghĩa |
|---|---|
| `DEVFLOW_MODE=server`, `SECRET_KEY`, `PUBLIC_BASE_URL`, `DATA_DIR`, `TRUST_PROXY`, `HOST`, `PORT` | Như v2; `SECRET_KEY` và `PUBLIC_BASE_URL` bắt buộc ở server mode. `DATA_DIR=/var/lib/devflow/data`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Bắt buộc ở server mode. |
| `ALLOWED_EMAIL_DOMAINS` | Tên miền email được đăng nhập, cách nhau dấu phẩy. **Phải khác rỗng**: để trống thì mọi lần đăng nhập đều bị từ chối. |
| `ADMIN_EMAILS`, `CTO_EMAILS` | Danh sách email, gán vai trò ngay lần đăng nhập Google đầu tiên. |
| `HEAD_EMAILS`, `DEPUTY_EMAILS` | Trưởng/phó phòng theo phòng, dạng `DEV:a@x,b@x;SGLOBAL:c@x`. |
| `GITLAB_URL` | Địa chỉ GitLab, ví dụ `https://gitlab.example.com`. Có thể nhập trong trang Cài đặt (giá trị ở đó ghi đè biến môi trường). |
| `GITLAB_TOKEN` | Personal Access Token dùng chung của DevFlow, quyền **`api` và `write_repository`**. Nhập qua biến môi trường hoặc trang Cài đặt; token nhập ở trang Cài đặt được lưu mã hóa bằng `SECRET_KEY`. Mỗi người còn có thể đặt token riêng ở trang **Tài khoản** (`/me`, lưu mã hóa); yêu cầu dùng token của người tạo yêu cầu khi có, nếu không thì dùng token chung. |
| `GITLAB_DEFAULT_GROUP` | Group mặc định khi tạo project GitLab mới (chế độ dự án "mới" có đẩy lên GitLab). |
| `PROJECT_ROOTS` | Thư mục gốc chứa các dự án (phải trùng với `PROJECT_ROOTS` của install-server.sh). |
| `SEAT_CONCURRENCY` | Số lần chạy Claude đồng thời trên mỗi seat (mặc định 1). |
| `MAX_CONCURRENT_JOBS` | Tổng số job đồng thời (mặc định 4 ở server mode). |
| `DFCTL_PATH` | Mặc định `/usr/local/lib/devflow/dfctl`. Server mode không khởi động nếu dfctl thiếu, không thuộc root hoặc ghi được bởi người khác. |
| `BREAKGLASS_ADMIN` | Tên một tài khoản admin cục bộ dùng mật khẩu khi Google hỏng (để trống = tắt). Đặt mật khẩu bằng `BREAKGLASS_PASSWORD=<mật khẩu ≥ 12 ký tự> npm run admin:set-password -- <tên>` (nếu bỏ biến này, script hỏi và hiện chữ gõ; không truyền mật khẩu qua tham số dòng lệnh). Script chỉ nhận đúng tên trong `BREAKGLASS_ADMIN`. |

**GitLab** là tùy chọn nhưng quyết định luồng nhánh/MR: khi dự án gắn với một GitLab project (`gitlab_project` lúc tạo dự án) và có URL cùng token, mỗi task mở một MR vào `devflow/<mã>` và DevFlow tự merge MR task đó (lần lượt, có khóa theo yêu cầu); đến DONE DevFlow chỉ **mở** MR cuối `devflow/<mã>` vào nhánh mặc định và **không bao giờ merge** MR này (người có thẩm quyền review và merge trên GitLab); bug do Tester tìm thấy được log thành issue. Khi không có GitLab (hoặc không truy cập được), DevFlow chạy ở chế độ cục bộ: merge task vào `devflow/<mã>` bằng git, không có MR/issue, nhánh mặc định không bị đụng tới. Token GitLab chỉ dùng cho lệnh mạng của git/GitLab, không bao giờ đưa vào môi trường của seat.

Đăng nhập bằng mật khẩu đã bị bỏ, ngoại trừ break-glass. Trang `/setup` bị khóa khi bật Google.

## 7. Ngày đầu: tạo tài khoản và phòng ban

Có hai phòng ban cố định: **DEV** và **SGLOBAL**.

1. Điền `ADMIN_EMAILS`, `CTO_EMAILS`, `HEAD_EMAILS`/`DEPUTY_EMAILS` (theo phòng) rồi start dịch vụ. Những người này nhận quyền khi đăng nhập Google lần đầu; mọi người khác vào thành `member` chưa có phòng.
2. Từng người đăng nhập một lần (tài khoản Linux của họ được tạo lúc này). Người đăng nhập sau khi danh sách seed đã có vẫn nhận đúng vai trò; người đã tồn tại không bị đổi quyền theo env.
3. Trưởng/phó phòng vào "PM của phòng" (`/dept/pm`): đưa thành viên chưa có phòng vào phòng mình, và bật cờ "được làm PM" (`can_be_pm`) cho những người sẽ tạo dự án. Chỉ admin đổi được vai trò hệ thống; trưởng/phó không tự cấp cờ cho chính mình hay cho người có vai trò đặc quyền.
4. PM tạo dự án (thư mục dưới `PROJECT_ROOTS`; chế độ "có sẵn", "clone" hoặc "mới"), thêm thành viên cùng phòng và gán vai trò dự án (PM, BA, SE, DEV, REVIEWER, TESTER), rồi tạo yêu cầu với mã tự nhập.
5. Mỗi thành viên vào trang "Claude của tôi" và kết nối seat của mình (mở link, dán mã vào ô ẩn).

Quy tắc mã yêu cầu: `^[A-Za-z0-9._-]{1,40}$`, duy nhất trong dự án, không trùng nhánh `devflow/<mã>`. Lưu ý xung đột tên nhánh git: `devflow/<mã>` là một nhánh nên không thể có thêm nhánh `devflow/<mã>/x` (thư mục và file trùng tên trong `refs/heads`), và ngược lại; đừng tạo nhánh tay có dạng đó trong repo dự án. Quy tắc tiền tố nghiêm hơn: không cho `ERP` và `ERP-1` cùng tồn tại trong một dự án (nhánh/worktree task `<mã>-<TASK>` sẽ đụng nhau).

## 8. Vận hành

**Sao lưu.** (a) Cơ sở dữ liệu SQLite trong `DATA_DIR` (`/var/lib/devflow/data`): dùng `sqlite3 <file> ".backup <đích>"` hoặc dừng dịch vụ rồi chép, kèm `secret.key`/`SECRET_KEY` (mất khóa thì token GitLab đã lưu không giải mã được). (b) `/var/lib/dfctl` (đăng ký dự án, dấu `sweep-failed`, gói tin cậy). (c) Các thư mục dự án dưới `PROJECT_ROOTS` (mã nguồn và tài liệu nằm trong repo; đẩy lên GitLab cũng là một bản sao). Home seat `/var/lib/devflow/users` chứa thông tin đăng nhập Claude: không sao lưu ra nơi ít bảo vệ hơn; mất thì mỗi người đăng nhập lại.

**Xử lý "sweep failed".** Khi dfctl phát hiện thư mục git của dự án bị seat làm bẩn (symlink, hard link lạ, pack bị thay), nó trả mã 86 và ghi dấu `/var/lib/dfctl/sweep-failed/<id dự án>`; dự án bị dừng (yêu cầu thành "cần người xử lý") cho tới khi bạn xử lý. Quy trình: xem nội dung file dấu (lý do), kiểm tra thư mục dự án (`.git` có symlink/hard link lạ không, ai sở hữu), xử lý nguyên nhân, rồi mới `sudo rm /var/lib/dfctl/sweep-failed/<id>` và chạy lại yêu cầu. Không xóa dấu trước khi kiểm tra. Cờ chặn trong bộ nhớ DevFlow tự mất khi khởi động lại dịch vụ, còn dấu của dfctl thì vẫn giữ.

**Scope mồ côi.** Khi `devflow.service` chết đột ngột, tiến trình seat có thể còn nằm trong scope systemd `dfctl-*.scope`. `ExecStopPost` đã gọi `reap`; nếu nghi còn sót, chạy tay `sudo /usr/local/lib/devflow/dfctl reap` (dọn scope không còn dfctl sở hữu), kiểm tra bằng `systemctl list-units 'dfctl-*.scope'`. Mỗi scope cũng có giới hạn thời gian tự kết thúc.

**Giám sát.** Admin, CTO và trưởng/phó phòng (phòng mình) có khu "Giám sát" chỉ đọc: tiến độ, điểm nghẽn, công việc theo người, nội dung dự án và log.

## 9. Danh sách kiểm tra thủ công trên VPS (bắt buộc làm trước khi dùng thật)

Chưa có mục nào dưới đây được chạy ở nơi phát triển (không có root, không có VPS, không có Claude thật).

1. **Spike đăng nhập seat** — `sudo scripts/spike-claude-login.sh --cleanup`. Kiểm: user không có shell chạy được `claude auth login` trong pty với stdin/stdout là pipe; trang đăng nhập nằm trong tổ chức công ty (xem mục 5); `auth status` rồi `logout` đúng; `claude -p` ngắn chạy được. Mã đăng nhập chỉ gõ ở ô ẩn, đừng dán đầu ra bước 3 ở đâu cả. Nếu thất bại, phương án dự phòng: admin chạy `sudo dfctl claude-auth <id> login --run-id <id>` qua SSH cùng người dùng.
2. **Spike bước 8** (sau khi chạy install-server.sh và `dfctl provision-user <id>`) — `sudo scripts/spike-claude-login.sh --seat <id> [--worktree <đường dẫn worktree>]`: bắt đầu một lần đăng nhập/chạy có theo dõi, gọi `stop-claude`, và thất bại nếu còn **bất kỳ** tiến trình nào của `dfu-<id>`. Với `--worktree` nó còn chạy probe Claude tạo tiến trình con tách rời, và kiểm tra `claude` vẫn sống lúc `stop-claude`. Xác nhận: `systemd-run --scope` nhận `RuntimeMaxSec`, `systemctl kill` tới được tiến trình con `setsid/nohup`, `ExecStopPost=+… reap` chạy sau stop/restart/crash, định dạng `/proc/<pid>/cgroup` khớp `dfctl-<uid>-<runid>.scope`.
3. **Spike bước 9** — cùng lệnh với `--worktree`: git của seat trong worktree vẫn chạy được (status, ghi index, object, ref) trong khi `.git/config`, `.git/hooks`, `.git/info` **không** ghi được bởi seat; `git submodule update` của seat thất bại gọn vì `modules/` chỉ chủ sở hữu ghi; sau một lần chạy, DevFlow commit/merge vẫn làm được; seat thêm pack (ví dụ `git fetch`) vẫn được và pack được dfctl nhận lại ở lần sweep sau. Đo thời gian sweep trên repo lớn (sweep chạy trước và sau mỗi lần chạy seat).
4. `sudo -n /usr/local/lib/devflow/dfctl --self-test` dưới luật sudoers thật (và `bash ops/dfctl --self-test` nếu muốn); kiểm tra `visudo -c`, và khớp phiên bản sudo với luật được sinh.
5. Hành vi dfctl thật: `useradd/groupadd/gpasswd`, `runuser/setpriv --init-groups`, `env -C` (coreutils ≥ 8.28), `stop-claude` với tiến trình root/khác user, quyền sở hữu/chmod do HARDEN lên file thật của seat (từ chối do sai chủ, xóa symlink), `flock`/`chown -h`, từ chối khi không có systemd, cron/at deny với bản cron đã cài.
6. Văn bản lỗi thật của Claude: các mẫu nhận diện "hết hạn/chưa đăng nhập" (`login expired`, `Invalid API key · Please run /login`, `not logged in`, ...) là suy đoán; chủ động làm hết hạn/đăng xuất một seat rồi xem yêu cầu có chuyển `awaiting_seat` và hiện nút kết nối không. Định dạng `claude auth status` thật (parser xử lý JSON `loggedIn` và văn bản).
7. Đường dẫn Claude thật cho thành viên: một dự án thử với đủ 6 vai trò chạy trọn một yêu cầu nhỏ; xác nhận mỗi lần gọi chạy đúng `dfu-<id>` của người phụ trách (`ps -o user`), trong `<dự án>/.devflow/worktrees/…`.
8. GitLab thật (E2E chỉ dùng GitLab giả): với PAT quyền `api` + `write_repository`, chạy một yêu cầu có hai Dev song song và xác nhận: MR của từng task được tạo và merge lần lượt vào `devflow/<mã>` (không có xung đột index/lock ở worktree yêu cầu), MR cuối ở DONE được mở và **không** bị merge, issue bug được tạo/đóng, nhánh mặc định không đổi; thử token thiếu quyền để thấy thông báo lỗi rõ ràng. Gỡ thành viên khi job đang chạy: thời gian thật của "dừng + sweep" trước khi group thay đổi. Đổi người chạy giữa chừng. 
9. Trình duyệt: hiển thị các trang Eta mới (hộp việc, dự án, phân công, "Claude của tôi", quản trị, giám sát), SSE trang seat, luồng đăng nhập Google thật (`googleOidcClient` chưa được chạy với Google thật) — redirect URI phải khớp.
10. Giám sát: với repo lớn thật, thời gian đọc (mỗi lần xem file chạy vài tiến trình git, chưa có cache); thử thấy `.env`/`*.pem` bị ẩn.
11. Managed settings: file `/etc/claude-code/managed-settings.json` có tác dụng thật (mục 5).
12. **Dừng dịch vụ khi nhiều scope mồ côi:** chạy vài yêu cầu song song (≥ 3 seat đang chạy Claude), rồi `sudo systemctl kill -s KILL devflow` (giả lập sập) hoặc `systemctl stop devflow`, đo `journalctl -u devflow` từ lúc dừng tới khi `ExecStopPost … reap` báo xong, và kiểm `systemctl list-units 'dfctl-*.scope'` rỗng. `reap` dừng từng scope một, mỗi scope tối đa ~10 giây (TERM rồi KILL, mỗi bước chờ 5 giây); `TimeoutStopSec` của unit phủ cả `ExecStopPost`. install-server.sh đặt `TimeoutStopSec=120` (đủ cho khoảng 11 scope cứng đầu); nếu `MAX_CONCURRENT_JOBS` lớn hơn hoặc đo thấy reap bị systemd cắt ngang (`Stopping timed out`), tăng giá trị này rồi `systemctl daemon-reload`. Sau khi khởi động lại, log phải có dòng `Startup sweep: … dự án OK` trước khi job đầu tiên chạy.
13. Tạo dự án từ repo "có sẵn": nếu repo có file hard-link trong `.git` (thường do `git clone` từ thư mục cục bộ), server mode từ chối — chạy `git repack -a -d`, xóa `.git/objects/info/alternates` (nếu có) hoặc clone lại với `--no-hardlinks`.

## 10. Rủi ro còn lại (nói thẳng)

- **Dịch vụ `devflow` bị chiếm quyền thì chạm được mọi seat.** Nó chạy được `sudo dfctl` nên có thể chạy Claude dưới bất kỳ `dfu-*` nào và đọc dữ liệu trong các dự án. Hãy coi máy này như một hệ thống nhạy cảm: giữ gói cập nhật, giới hạn SSH, không cài thêm dịch vụ khác.
- **Seat khác đang chạy trong cùng dự án** vẫn có thể ghi vào thư mục dùng chung (`objects/xx`, `refs`, `logs`, worktree của chính nó) trong lúc DevFlow chạy git ở worktree khác hoặc đang sweep; sweep chỉ bảo đảm seat vừa chạy xong đã chết. Cách giảm: thành viên cùng dự án là người được tin cậy ở mức đồng nghiệp.
- **Che giấu bí mật trong log chỉ là lớp phòng thủ bổ sung** (best-effort). Nó che các dạng phổ biến (header, `KEY=value`, URL có mật khẩu, tiền tố token quen thuộc, cờ `--password`...) nhưng không đảm bảo mọi hình dạng. Cờ `-p <từ>` bị che quá tay (ví dụ `mkdir -p dir`). Nội dung mã nguồn không được quét bí mật, chỉ lọc theo tên đường dẫn (`.env*`, `*.pem`, `*.key`, `.claude/`, `.git/`...). Vì vậy **CTO, trưởng/phó phòng (phòng mình) và admin đọc được mã nguồn và log của dự án**; mọi lần xem file/log đều ghi vào `audit_log`.
- **Một seat độc hại** có thể thoát khỏi process group của lần chạy, nhưng không thoát khỏi scope systemd; dfctl diệt cả scope rồi mới sweep. Merge qua merge-ort có thể mở repo lồng do seat điều khiển; các cờ tắt đệ quy submodule và loại trừ gitlink chỉ bao phủ status/diff/add/stash.
- **Scope mồ côi** có thể sống tới giới hạn thời gian của lần chạy nếu `ExecStopPost` không kịp chạy (ví dụ máy sập); khi khởi động lại máy thì mọi scope đều mất.
- **Yêu cầu cũ/không thuộc dự án (legacy)** không được hỗ trợ ở server mode: chúng không có seat và sẽ nằm mãi ở `awaiting_seat`. Không có dữ liệu v2 để chuyển (VPS mới, không có `migrate`).
- **Clone thất bại** có thể để lại thư mục không rỗng; DevFlow không bao giờ xóa thư mục dự án, nên phải dọn tay rồi tạo lại dự án.
- **Lưu trữ dự án** không gỡ thành viên khỏi group hệ điều hành.
- **`.devflow/requests` không có sticky bit** (khác `.devflow/worktrees` 3770): seat của bất kỳ thành viên nào trong dự án có thể đổi tên/xóa thư mục của yêu cầu khác cùng dự án (inputs, artifacts, evidence, logs). DevFlow đọc/ghi ở đó đều qua safe-fs nên điều này không leo thang ra ngoài dự án hay vào tệp của dịch vụ; rủi ro còn lại là phá dữ liệu lẫn nhau giữa các thành viên cùng dự án, cùng mức tin cậy "đồng nghiệp" như mục seat cùng dự án ở trên. Muốn chặn hẳn thì cần thêm sticky bit cho `.devflow/requests` trong dfctl (chưa làm vì cần thử trên VPS thật: chính DevFlow tạo các thư mục con này nên vẫn xóa/đổi được).
- Khóa/cờ chặn dự án sau "sweep failed" và khóa merge nằm trong bộ nhớ một tiến trình DevFlow duy nhất (đúng với một VPS, một dịch vụ). Sau khi khởi động lại, DevFlow **chặn từng dự án chưa lưu trữ cho tới khi dự án đó được sweep xong** (job của dự án chỉ chạy sau sweep của chính nó; dự án khác không phải chờ, tối đa 3 dự án sweep cùng lúc). Danh sách worktree cần sweep lấy **từ cơ sở dữ liệu** (mã yêu cầu và mã task), không bao giờ từ việc liệt kê `.devflow/worktrees` (thư mục này seat ghi được, nên seat không thể tự thêm việc sweep); dự án chưa có worktree nào được sweep một lần ở mức dự án (`dfctl sweep-project <id>`), nhờ đó dấu `/var/lib/dfctl/sweep-failed/<id>` còn từ trước được áp lại ngay. Dự án sweep thất bại bị chặn (yêu cầu chuyển `needs_human`). Trong lúc sweep, giao diện web đã mở và việc của các dự án đã sweep xong chạy bình thường. Dừng dịch vụ (SIGTERM) trong lúc sweep vẫn tắt êm.
- **Trang yêu cầu trên web đọc tệp qua safe-fs.** Mọi lần đọc/liệt kê/nén/ghi trong thư mục seat ghi được (`artifacts/`, `evidence/`, `inputs/`, tài liệu `docs/devflow/<mã>/` trong worktree, `impact.md`) đều kiểm từng thành phần đường dẫn bằng `lstat` (không symlink), mở với `O_NOFOLLOW|O_NONBLOCK`, chỉ nhận tệp thường; symlink hoặc FIFO do seat cài vào bị bỏ qua (403/404), không bao giờ trả nội dung đích. Rủi ro còn lại: giữa lúc liệt kê và lúc mở, tên tệp trong một thư mục bị thay bằng symlink thư mục chỉ làm lộ **tên** tệp (nội dung vẫn đọc qua safe-fs, có kiểm `/proc/self/fd`).
- **Khóa tài khoản** (trang quản trị) dừng các job đang chạy trên seat đó, chuyển sang người kế tiếp của vai trò, rồi mới gỡ người đó khỏi group Linux của các dự án; mở khóa thì thêm lại.
- Job đang chờ seat được kiểm tra lại mỗi 10 phút; người dùng kết nối lại ở trang "Claude của tôi" thì job chạy tiếp ngay.

## 11. Điều khoản Anthropic

Mô hình "mỗi người đăng nhập seat riêng của mình vào binary Claude Code nguyên bản trên máy chủ dùng chung" phù hợp với những gì ta đọc được ở điều khoản hiện hành, nhưng **hãy xác nhận bằng văn bản với Anthropic (sales/hỗ trợ doanh nghiệp) trước khi dùng thật**: máy chủ dùng chung, nhiều seat trên một máy, một ứng dụng điều phối nằm giữa. Ứng dụng không được thu thập hoặc lưu token của người dùng, và không dùng chung một seat cho nhiều người. Chi tiết tư vấn và nguồn: `docs/HANDOFF.md` mục 4.
