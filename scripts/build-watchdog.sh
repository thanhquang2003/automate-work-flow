#!/usr/bin/env bash
# build-watchdog.sh — keeps the autonomous build (Claude Code + lah queue) going across
# Claude usage-limit stops. Runs `claude -p <resume prompt>` in a loop; when the run ends
# because of a usage/rate limit it sleeps until the reset time (+ margin) and starts again;
# it stops when the lah queue has no pending work, after repeated non-limit failures, or
# after MAX_RESTARTS.
#
# Usage:   scripts/build-watchdog.sh            (foreground; use tmux/nohup/systemd to detach)
#          WATCHDOG_DRY_RUN=1 scripts/build-watchdog.sh   (print what would run, no sleeping)
# Env:     WORKDIR (default: repo root)          CLAUDE_BIN (default: claude)
#          CLAUDE_ARGS  extra args, e.g. "--permission-mode acceptEdits"
#          RESUME_PROMPT                         MARGIN_SEC (default 120)
#          DEFAULT_PAUSE_MIN (no reset time found, default 30)   MAX_RESTARTS (default 50)
#          MAX_FAILURES consecutive non-limit failures (default 3)
#          LOG_DIR (default: $WORKDIR/.superpowers/watchdog)
#          LAH_BIN (default: lah)  QUEUE_CMD override (prints "pending" or "empty")
set -uo pipefail

WORKDIR="${WORKDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_ARGS="${CLAUDE_ARGS:-}"
LAH_BIN="${LAH_BIN:-lah}"
MARGIN_SEC="${MARGIN_SEC:-120}"
DEFAULT_PAUSE_MIN="${DEFAULT_PAUSE_MIN:-30}"
MAX_RESTARTS="${MAX_RESTARTS:-50}"
MAX_FAILURES="${MAX_FAILURES:-3}"
LOG_DIR="${LOG_DIR:-$WORKDIR/.superpowers/watchdog}"
RESUME_PROMPT="${RESUME_PROMPT:-Continue the DevFlow v3 build. Read AGENTS.md, run 'lah status', read the SDD ledger under .superpowers/sdd/*/progress.md and 'git log', then resume from the first unfinished task with superpowers:subagent-driven-development. Do not redo tasks the ledger marks complete.}"

mkdir -p "$LOG_DIR"
exec 9>"$LOG_DIR/lock"
flock -n 9 || { echo "watchdog already running (lock $LOG_DIR/lock)"; exit 1; }

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_DIR/watchdog.log"; }

# Prints the epoch second when the limit resets, or nothing if the text has no limit message.
# Understands "usage limit reached|<epoch>" and "resets 3pm" / "resets at 3:30 pm" (local time).
limit_reset_epoch() {
  python3 - "$1" "$DEFAULT_PAUSE_MIN" <<'PY'
import re, sys, time, datetime
text = open(sys.argv[1], errors='replace').read()[-20000:]
default_min = int(sys.argv[2])
if not re.search(r'(usage limit|rate limit|limit reached|5-hour limit|weekly limit|hit your limit)', text, re.I):
    sys.exit(0)
now = time.time()
m = re.search(r'limit reached\|(\d{10})', text, re.I)
if m:
    print(max(int(m.group(1)), int(now))); sys.exit(0)
m = None
for m in re.finditer(r'resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?', text, re.I):
    pass
if m:
    h, mi, ap = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or '').lower()
    if ap == 'pm' and h < 12: h += 12
    if ap == 'am' and h == 12: h = 0
    if h <= 23 and mi <= 59:
        d = datetime.datetime.fromtimestamp(now).replace(hour=h, minute=mi, second=0, microsecond=0)
        if d.timestamp() <= now: d += datetime.timedelta(days=1)
        print(int(d.timestamp())); sys.exit(0)
print(int(now + default_min * 60))
PY
}

queue_state() {
  if [ -n "${QUEUE_CMD:-}" ]; then bash -c "$QUEUE_CMD"; return; fi
  (cd "$WORKDIR" && "$LAH_BIN" status --json 2>/dev/null) | python3 -c '
import json, sys
try: q = json.load(sys.stdin)["queue"]
except Exception: print("unknown"); sys.exit()
open_ = {"defects": ("open", "in-progress"), "tasks": ("open", "in-progress"), "features": ("planned", "in-progress")}
print("pending" if any(i.get("status") in open_[k] for k in open_ for i in q.get(k, [])) else "empty")'
}

restarts=0; failures=0
while :; do
  state=$(queue_state)
  if [ "$state" = "empty" ]; then log "queue empty — done"; exit 0; fi
  if [ "$restarts" -ge "$MAX_RESTARTS" ]; then log "MAX_RESTARTS ($MAX_RESTARTS) reached — stopping"; exit 2; fi
  restarts=$((restarts + 1))
  out="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S)-$restarts.log"
  log "run #$restarts (queue: $state) → $out"
  if [ -n "${WATCHDOG_DRY_RUN:-}" ]; then log "dry run: would run: $CLAUDE_BIN -p <prompt> $CLAUDE_ARGS"; exit 0; fi
  # shellcheck disable=SC2086
  (cd "$WORKDIR" && "$CLAUDE_BIN" -p "$RESUME_PROMPT" $CLAUDE_ARGS) >"$out" 2>&1
  code=$?
  reset=$(limit_reset_epoch "$out")
  if [ -n "$reset" ]; then
    failures=0
    wait=$(( reset + MARGIN_SEC - $(date +%s) )); [ "$wait" -lt 60 ] && wait=60
    log "usage limit hit (exit $code); resuming in ${wait}s at $(date -d "@$((reset + MARGIN_SEC))" '+%F %T')"
    sleep "$wait"
    continue
  fi
  if [ "$code" -ne 0 ]; then
    failures=$((failures + 1))
    log "claude exited $code without a limit message ($failures/$MAX_FAILURES)"
    [ "$failures" -ge "$MAX_FAILURES" ] && { log "too many consecutive failures — stopping"; exit 3; }
    sleep $(( 60 * failures )); continue
  fi
  failures=0
  log "run finished cleanly; re-checking queue"
done
