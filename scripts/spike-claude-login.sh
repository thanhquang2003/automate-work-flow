#!/usr/bin/env bash
# spike-claude-login.sh — MANUAL check, run once by the owner on the Linux VPS (as root) before v3 seats go live.
#
# Question it answers (spec v3 §6b.3): does the original `claude` binary let a user WITHOUT a login shell
# connect a Claude Team seat through `claude auth login` running inside a pseudo-terminal (util-linux
# `script`), with stdin/stdout being plain pipes the way DevFlow drives it? And do `claude auth status` /
# `claude auth logout` work for that user with a private CLAUDE_CONFIG_DIR?
#
# What it does (each step prints PASS/FAIL):
#   1. creates a throw-away OS user (default `dfspike`, shell /usr/sbin/nologin, private home)
#   2. `claude --version` and `claude auth status` as that user
#   3. `claude auth login` inside `script` with stdin from a FIFO and stdout to a private file (DevFlow's
#      way). It prints the login URL it found; you open it in YOUR browser, and if the page shows a code
#      you paste it at the hidden prompt. The code is written to the FIFO only: never echoed, logged or saved.
#   4. `claude auth status` again (expect logged in; check the organisation is the company Team org)
#   5. optional short `claude -p` run (skip with --skip-run)
#   6. `claude auth logout` and a final `claude auth status` (expect logged out)
#   7. with --cleanup: deletes the throw-away user and its home
#   8. with --seat <userId> (after install-server.sh and `dfctl provision-user <userId>`): starts a tracked
#      `dfctl claude-auth <id> login`, runs `dfctl stop-claude`, and FAILS if ANY process of dfu-<id>
#      survives (ps -o pid,pgid,sid,cmd is printed before and after). With --worktree <path> (a worktree of
#      a registered project the seat is a member of) it repeats the check for `dfctl run-claude`, plus a probe
#      where claude runs its Bash tool and leaves detached `sleep` children before the stop,
#      and checks, as the seat with dfctl's environment, that git status / object+ref writes work in the
#      worktree while the project's .git/config, .git/hooks and .git/info are NOT writable by the seat.
#
# Usage:  sudo scripts/spike-claude-login.sh [--user NAME] [--claude /abs/path/to/claude] [--skip-run] [--cleanup]
#                                            [--seat <userId> [--worktree /abs/worktree/path]]
#
# This script was written on a development machine without root and has NOT been run there.
# Never paste the output of step 3 anywhere public: it contains the one-time login URL.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

SPIKE_USER=dfspike
CLAUDE_BIN=""
SKIP_RUN=0
CLEANUP=0
LOGIN_TIMEOUT=600
SEAT=""
WORKTREE=""
DFCTL=/usr/local/lib/devflow/dfctl

die() { printf 'spike: %s\n' "$*" >&2; exit 2; }
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; FAILED=1; }
FAILED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user) [ $# -ge 2 ] || die "--user needs a value"; SPIKE_USER="$2"; shift 2 ;;
    --claude) [ $# -ge 2 ] || die "--claude needs a value"; CLAUDE_BIN="$2"; shift 2 ;;
    --skip-run) SKIP_RUN=1; shift ;;
    --cleanup) CLEANUP=1; shift ;;
    --seat) [ $# -ge 2 ] || die "--seat needs a value"; SEAT="$2"; shift 2 ;;
    --worktree) [ $# -ge 2 ] || die "--worktree needs a value"; WORKTREE="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ "$(uname -s)" = Linux ] || die "Linux only"
[[ "$SPIKE_USER" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bad user name: $SPIKE_USER"
[ -z "$SEAT" ] || [[ "$SEAT" =~ ^[1-9][0-9]{0,8}$ ]] || die "bad --seat user id"
[ -z "$WORKTREE" ] || [ -n "$SEAT" ] || die "--worktree needs --seat"
for t in script setpriv useradd mkfifo timeout; do command -v "$t" >/dev/null || die "missing tool: $t"; done

if [ -z "$CLAUDE_BIN" ]; then CLAUDE_BIN="$(command -v claude || true)"; fi
[ -n "$CLAUDE_BIN" ] || die "claude not found; pass --claude /abs/path"
CLAUDE_BIN="$(readlink -f -- "$CLAUDE_BIN")"
[ -x "$CLAUDE_BIN" ] || die "not executable: $CLAUDE_BIN"
# The path goes into `script -c "<cmd>"`, which a shell parses: allow only plain path characters.
[[ "$CLAUDE_BIN" =~ ^/[A-Za-z0-9._/+-]+$ ]] || die "claude path has unusual characters: $CLAUDE_BIN"
echo "claude binary: $CLAUDE_BIN"
if [ -f /etc/claude-code/managed-settings.json ]; then
  echo "managed settings present: /etc/claude-code/managed-settings.json (forceLoginMethod / forceLoginOrgUUID)"
else
  echo "NOTE: /etc/claude-code/managed-settings.json not found; login will not be restricted to the company org"
fi

HOME_DIR="/var/lib/devflow-spike/$SPIKE_USER"
if id -u "$SPIKE_USER" >/dev/null 2>&1; then
  echo "user $SPIKE_USER already exists, reusing"
  HOME_DIR="$(getent passwd "$SPIKE_USER" | cut -d: -f6)"
else
  install -d -m 0755 -o root -g root /var/lib/devflow-spike
  useradd --system --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin --user-group "$SPIKE_USER"
  chmod 0700 "$HOME_DIR"
  pass "created user $SPIKE_USER (no login shell, home $HOME_DIR)"
fi
CFG_DIR="$HOME_DIR/.claude"
setpriv --reuid="$SPIKE_USER" --regid="$SPIKE_USER" --init-groups -- mkdir -p -m 0700 "$CFG_DIR"

# Same way and clean environment dfctl uses (setpriv execs in place, like dfctl).
as_user() {
  setpriv --reuid="$SPIKE_USER" --regid="$SPIKE_USER" --init-groups --no-new-privs -- env -i HOME="$HOME_DIR" CLAUDE_CONFIG_DIR="$CFG_DIR" \
    PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 SHELL=/bin/sh TERM=dumb DISABLE_AUTOUPDATER=1 "$@"
}

echo; echo "== 2. version and status before login"
if v="$(as_user timeout 60 "$CLAUDE_BIN" --version 2>&1)"; then pass "claude --version: $v"; else fail "claude --version failed: $v"; fi
set +e
st="$(as_user timeout 60 "$CLAUDE_BIN" auth status 2>&1)"; rc=$?
set -e
echo "auth status exit=$rc"; printf '%s\n' "$st" | sed 's/^/  | /'
[ $rc -ne 127 ] && pass "claude auth status runs" || fail "claude auth status not available in this version"

echo; echo "== 3. login inside a pseudo-terminal, pipes on both sides (DevFlow's way)"
WORK="$(mktemp -d)"
chmod 0711 "$WORK"
cleanup_work() { rm -rf -- "$WORK"; }
trap cleanup_work EXIT
mkfifo -m 0600 "$WORK/in"; chown "$SPIKE_USER" "$WORK/in"
OUT="$WORK/out"; : > "$OUT"; chown "$SPIKE_USER" "$OUT"; chmod 0600 "$OUT"
# Keep the FIFO open for writing on fd 9 for the whole login so the child never sees EOF early.
as_user timeout -s KILL "$LOGIN_TIMEOUT" script -qfec "stty cols 500 rows 50 2>/dev/null; exec $CLAUDE_BIN auth login" /dev/null \
  < "$WORK/in" > "$OUT" 2>&1 &
LOGIN_PID=$!
exec 9> "$WORK/in"

url=""
for _ in $(seq 1 120); do
  # Strip ANSI CSI/OSC sequences, then take the first https URL.
  url="$(sed -e 's/\x1b\][^\x07]*\x07//g' -e 's/\x1b\[[0-9;?]*[ -/]*[@-~]//g' "$OUT" | tr -d '\r' | grep -oE 'https://[^[:space:]"'"'"'<>]+' | head -n1 || true)"
  [ -n "$url" ] && break
  kill -0 "$LOGIN_PID" 2>/dev/null || break
  sleep 1
done
if [ -n "$url" ]; then
  pass "login URL printed (open it in your own browser):"
  printf '\n    %s\n\n' "$url"
  case "$url" in
    https://claude.ai/*|https://*.claude.ai/*|https://claude.com/*|https://*.claude.com/*|https://*.anthropic.com/*) pass "URL host is an Anthropic/Claude domain" ;;
    *) fail "URL host is not on the expected allow-list (claude.ai / claude.com / anthropic.com): DevFlow would refuse to show it" ;;
  esac
  echo "If the browser shows a code, paste it below (input hidden). Press Enter on an empty line if the browser said login finished."
  IFS= read -r -s -p "code: " code || code=""
  echo
  if [ -n "$code" ]; then printf '%s\r' "$code" >&9; fi
  unset code
else
  fail "no https URL within 120 s; raw output (code-free, nothing typed yet):"
  sed 's/^/  | /' "$OUT" | head -n 40
fi
exec 9>&-
set +e
wait "$LOGIN_PID"; lrc=$?
set -e
echo "login exit=$lrc"
[ $lrc -eq 0 ] && pass "claude auth login exited 0" || fail "claude auth login exited $lrc (137 = killed by the ${LOGIN_TIMEOUT}s timeout)"
# Never print the output after the code was typed: the pty echoes typed input. Only report keywords.
if sed -e 's/\x1b\][^\x07]*\x07//g' -e 's/\x1b\[[0-9;?]*[ -/]*[@-~]//g' "$OUT" | grep -qiE 'success|logged in'; then
  pass "login output contains a success message"
else
  echo "NOTE: no 'success'/'logged in' text in the login output; rely on step 4"
fi

echo; echo "== 4. status after login"
set +e
st="$(as_user timeout 60 "$CLAUDE_BIN" auth status 2>&1)"; rc=$?
set -e
echo "auth status exit=$rc"; printf '%s\n' "$st" | sed 's/^/  | /'
echo "Check by eye: logged in, organisation = company Team org. Record the exact output format for DevFlow's parser."
if [ -f "$CFG_DIR/.credentials.json" ]; then
  perm="$(stat -c '%a %U' "$CFG_DIR/.credentials.json")"
  pass "credentials written by Claude Code itself ($perm); DevFlow never reads this file"
else
  echo "NOTE: no $CFG_DIR/.credentials.json (this version may store credentials elsewhere)"
fi

if [ $SKIP_RUN -eq 0 ]; then
  echo; echo "== 5. short headless run"
  set +e
  r="$(cd / && printf 'Reply with the single word OK.' | as_user timeout 120 "$CLAUDE_BIN" -p --output-format json 2>&1)"; rc=$?
  set -e
  echo "claude -p exit=$rc"; printf '%s\n' "$r" | cut -c1-300 | sed 's/^/  | /'
  [ $rc -eq 0 ] && pass "headless run works on the seat" || fail "headless run failed"
fi

echo; echo "== 6. logout"
set +e
lo="$(as_user timeout 60 "$CLAUDE_BIN" auth logout 2>&1)"; rc=$?
st="$(as_user timeout 60 "$CLAUDE_BIN" auth status 2>&1)"; src=$?
set -e
echo "auth logout exit=$rc"; printf '%s\n' "$lo" | sed 's/^/  | /'
echo "auth status exit=$src"; printf '%s\n' "$st" | sed 's/^/  | /'
[ $rc -eq 0 ] && pass "claude auth logout exited 0" || fail "claude auth logout exited $rc"

if [ -n "$SEAT" ]; then
  echo; echo "== 8. dfctl stop-claude kills the whole run (seat $SEAT)"
  [ -x "$DFCTL" ] || die "$DFCTL not installed (run install-server.sh first)"
  SU="dfu-$SEAT"
  id -u "$SU" >/dev/null 2>&1 || die "$SU not provisioned (sudo $DFCTL provision-user $SEAT)"
  # ANY process left under the seat account after a stop is a failure (not only claude/script).
  survivors() { ps -o pid=,cmd= -u "$SU" 2>/dev/null || true; }
  [ -z "$(survivors)" ] || die "$SU already has processes; stop them first: $(survivors | tr '\n' ';')"
  # check_stop <label> <runId> <prompt or ""> <command...>
  # Without a prompt stdin stays open (claude waits). With a prompt it is sent and stdin closed, and the run is
  # stopped only once the Bash-tool children the prompt asks for are visible.
  check_stop() {
    local label=$1 rid=$2 prompt=$3; shift 3
    local fifo; fifo="$(mktemp -u)"; mkfifo -m 0600 "$fifo"
    "$@" < "$fifo" > /dev/null 2>&1 &
    local bgp=$!
    exec 7> "$fifo"
    if [ -n "$prompt" ]; then
      printf '%s\n' "$prompt" >&7
      exec 7>&-
      local seen=0 i
      for i in $(seq 1 180); do
        if pgrep -u "$SU" -f 'sleep 30[01]' >/dev/null; then seen=1; break; fi
        kill -0 "$bgp" 2>/dev/null || break
        sleep 1
      done
      [ $seen -eq 1 ] && pass "$label: claude started detached Bash-tool children" \
        || fail "$label: the probe never started its 'sleep 300/301' children (no Bash tool run?)"
      # The prompt keeps claude busy in a foreground `sleep 110`, so claude itself is alive at the stop and the
      # stop has to take down claude, its tool shell and the detached children together.
      sleep 3
      if pgrep -u "$SU" -f -- "$CLAUDE_BIN" >/dev/null; then pass "$label: claude is still running when stop-claude is sent"
      else fail "$label: claude already exited before the stop (the probe does not exercise the scope kill)"; fi
    else
      sleep 5
    fi
    echo "processes of $SU before stop-claude ($label):"; ps -o pid,pgid,sid,cmd -u "$SU" | sed 's/^/  | /'
    "$DFCTL" stop-claude "$SEAT" "$rid" | sed 's/^/  stop-claude: /'
    sleep 7
    echo "processes of $SU after stop-claude ($label):"; ps -o pid,pgid,sid,cmd -u "$SU" | sed 's/^/  | /'
    if [ -z "$(survivors)" ]; then
      pass "$label: no process of $SU survives stop-claude"
    else
      fail "$label: processes of $SU survived stop-claude (see list above); killing them now"
      pkill -KILL -u "$SU" || true
    fi
    exec 7>&- 2>/dev/null || true
    wait "$bgp" 2>/dev/null || true
    rm -f -- "$fifo"
  }
  rid="spike$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  check_stop "claude-auth login" "$rid" "" "$DFCTL" claude-auth "$SEAT" login --run-id "$rid"

  if [ -n "$WORKTREE" ]; then
    WT="$(realpath -e -- "$WORKTREE")" || die "worktree not found"
    PROJ="${WT%/.devflow/worktrees/*}"
    [ "$PROJ" != "$WT" ] || die "--worktree must be <project>/.devflow/worktrees/<name>"
    rid="spike$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    # `claude -p` waits for the prompt on stdin, which stays open until after the stop.
    check_stop "run-claude" "$rid" "" "$DFCTL" run-claude "$SEAT" "$WT" --run-id "$rid" -- -p --output-format stream-json --verbose
    # Probe: claude really runs its Bash tool and leaves detached children (setsid'd and nohup'd), the
    # case a process-group kill can miss. Same flags DevFlow uses.
    rid="spike$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    check_stop "run-claude with Bash tool children" "$rid" \
      "Use your Bash tool to run exactly this command: (setsid sleep 300 >/dev/null 2>&1 &) ; nohup sleep 301 >/dev/null 2>&1 & -- then, in a second Bash tool call, run exactly: sleep 110 -- and only after that reply DONE." \
      "$DFCTL" run-claude "$SEAT" "$WT" --run-id "$rid" -- -p --output-format stream-json --verbose --permission-mode bypassPermissions

    echo; echo "== 9. seat git inside the worktree, and .git protections"
    SH="$(getent passwd "$SU" | cut -d: -f6)"
    seat_git() {
      setpriv --reuid="$SU" --regid="$SU" --init-groups --no-new-privs -- env -i -C "$WT" HOME="$SH" \
        PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=safe.directory \
        GIT_CONFIG_VALUE_0="$WT" GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1="$PROJ" git "$@"
    }
    seat_test() { setpriv --reuid="$SU" --regid="$SU" --init-groups --no-new-privs -- test "$@"; }
    if seat_git status --short >/dev/null; then pass "seat: git status in the worktree"; else fail "seat: git status in the worktree"; fi
    if seat_git update-index --refresh >/dev/null 2>&1 || [ $? -eq 1 ]; then pass "seat: index of the worktree writable"; else fail "seat: index not writable"; fi
    if obj="$(printf 'devflow spike %s\n' "$rid" | seat_git hash-object -w --stdin)"; then pass "seat: object written"; else fail "seat: cannot write objects"; obj=""; fi
    if [ -n "$obj" ] && seat_git update-ref "refs/devflow-spike/$rid" "$obj" && seat_git update-ref -d "refs/devflow-spike/$rid"; then
      pass "seat: refs writable (create + delete of a scratch ref)"
    else fail "seat: cannot update refs (a seat commit would fail)"; fi
    for p in "$PROJ/.git/config" "$PROJ/.git/hooks" "$PROJ/.git/info" "$PROJ/.git"; do
      if seat_test -w "$p"; then fail "seat can write $p"; else pass "seat cannot write $p"; fi
    done
  fi
fi

if [ $CLEANUP -eq 1 ]; then
  echo; echo "== 7. cleanup"
  userdel -r "$SPIKE_USER" 2>/dev/null && pass "removed user $SPIKE_USER and its home" || fail "could not remove $SPIKE_USER"
fi

echo
if [ $FAILED -eq 0 ]; then
  echo "SPIKE RESULT: PASS. Seat login in a pty works; DevFlow's SudoSeatRunner design stands."
else
  echo "SPIKE RESULT: FAIL. Fallback (spec §6b.3): admin runs 'sudo dfctl claude-auth <id> login' in an SSH session together with the user."
  exit 1
fi
