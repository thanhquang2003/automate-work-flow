#!/usr/bin/env bash
# Self-test for build-watchdog.sh using a fake `claude` and a fake queue.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

# fake claude: 1st call prints a limit message with an epoch ~2s ahead, 2nd call succeeds and empties the queue
cat >"$T/claude" <<FAKE
#!/usr/bin/env bash
n=\$(cat "$T/n" 2>/dev/null || echo 0); n=\$((n+1)); echo \$n >"$T/n"
if [ "\$n" = 1 ]; then echo "Claude AI usage limit reached|\$(( \$(date +%s) + 2 ))"; exit 1; fi
echo ok; : >"$T/empty"; exit 0
FAKE
chmod +x "$T/claude"
export CLAUDE_BIN="$T/claude" WORKDIR="$T" LOG_DIR="$T/log" MARGIN_SEC=0
export QUEUE_CMD="[ -f $T/empty ] && echo empty || echo pending"

# 1. limit → sleeps → restarts → queue empty → exit 0
bash "$HERE/build-watchdog.sh" >"$T/out1" 2>&1 || fail "case 1 exit code"; grep -q "usage limit hit" "$T/out1" || fail "case 1 no limit log"
[ "$(cat "$T/n")" = 2 ] || fail "case 1 expected 2 claude runs, got $(cat "$T/n")"
grep -q "queue empty" "$T/out1" || fail "case 1 no done log"

# 2. non-limit failures stop after MAX_FAILURES
rm -f "$T/n" "$T/empty"; printf '#!/usr/bin/env bash\necho boom; exit 1\n' >"$T/claude"
sleep() { :; }; export -f sleep 2>/dev/null || true
MAX_FAILURES=2 PATH="$T/fakebin:$PATH" bash -c "sleep(){ :; }; export -f sleep; source /dev/null; exec bash '$HERE/build-watchdog.sh'" >"$T/out2" 2>&1 && fail "case 2 should exit non-zero"
grep -q "too many consecutive failures" "$T/out2" || fail "case 2 no stop log"

# 3. reset-time parsing: 'resets 3pm' gives a future epoch
printf '5-hour limit reached ∙ resets 3pm\n' >"$T/msg"
e=$(DEFAULT_PAUSE_MIN=30 bash -c "source <(sed -n '/^limit_reset_epoch()/,/^}/p' '$HERE/build-watchdog.sh'); limit_reset_epoch '$T/msg'")
[ -n "$e" ] && [ "$e" -gt "$(date +%s)" ] || fail "case 3 epoch not in the future: '$e'"
printf 'all good\n' >"$T/msg2"
[ -z "$(DEFAULT_PAUSE_MIN=30 bash -c "source <(sed -n '/^limit_reset_epoch()/,/^}/p' '$HERE/build-watchdog.sh'); limit_reset_epoch '$T/msg2'")" ] || fail "case 3b false positive"
echo "build-watchdog self-test: PASS"
