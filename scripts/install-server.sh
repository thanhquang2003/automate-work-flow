#!/usr/bin/env bash
# install-server.sh — one-time (re-runnable) root setup of a DevFlow v3 server (spec v3 §6b.1-2).
#
#   sudo CLAUDE_TEAM_ORG_UUID=<uuid> PROJECT_ROOTS=/srv/projects scripts/install-server.sh
#
# Env:
#   CLAUDE_TEAM_ORG_UUID  (required) company Claude Team organisation UUID -> managed settings
#   PROJECT_ROOTS         (required) comma-separated absolute folders that may hold projects
#                         (same value as PROJECT_ROOTS in the DevFlow env file)
#   CLAUDE_BIN            path of the original `claude` binary (default: `command -v claude`); must be
#                         root-owned and not writable by others
#   DEVFLOW_DIR           checkout of DevFlow (default: the repo this script lives in); built with `npm run build`
#   NODE_BIN              node 24 binary (default: `command -v node`)
#   ENV_FILE              DevFlow env file for systemd (default /etc/devflow/devflow.env; created 0600 from
#                         .env.example if missing, never overwritten)
#
# What it does: service user `devflow`; /var/lib/devflow (root) with users/ (seat homes, root) and data/
# (devflow); dfctl -> /usr/local/lib/devflow/dfctl (root:root 0755); /etc/devflow/dfctl.conf (root 0644);
# sudoers rule for exactly dfctl (validated with visudo, sudo I/O logging off for it so login codes typed by
# users are never recorded); /etc/claude-code/managed-settings.json (forceLoginMethod claudeai +
# forceLoginOrgUUID, previous file backed up); systemd unit `devflow` (enabled, not started).
# It never deletes anything and never touches project contents.
set -euo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

die() { printf 'install-server: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$(uname -s)" = Linux ] || die "Linux only"
for t in useradd groupadd gpasswd setpriv script setsid timeout flock systemd-run visudo install realpath systemctl; do
  command -v "$t" >/dev/null || die "missing tool: $t"
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVFLOW_DIR="${DEVFLOW_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${ENV_FILE:-/etc/devflow/devflow.env}"
SERVICE_USER=devflow
DFCTL_DST=/usr/local/lib/devflow/dfctl

ORG="${CLAUDE_TEAM_ORG_UUID:-}"
[[ "$ORG" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || die "CLAUDE_TEAM_ORG_UUID must be a UUID"

ROOTS_RAW="${PROJECT_ROOTS:-}"
[ -n "$ROOTS_RAW" ] || die "PROJECT_ROOTS is required"
ROOTS=()
IFS=, read -r -a parts <<< "$ROOTS_RAW"
for r in "${parts[@]}"; do
  r="${r#"${r%%[![:space:]]*}"}"; r="${r%"${r##*[![:space:]]}"}"
  [ -n "$r" ] || continue
  [[ "$r" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "PROJECT_ROOTS entry must be a plain absolute path: $r"
  [[ "$r" != */ && "$r" != *//* && "$r" != */./* && "$r" != */../* && "$r" != */. && "$r" != */.. ]] || die "PROJECT_ROOTS entry not canonical: $r"
  case "$r" in /|/etc|/etc/*|/usr|/usr/*|/bin|/sbin|/lib|/lib/*|/boot|/boot/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/root|/root/*|/var/lib/devflow|/var/lib/devflow/*)
    die "refusing system folder as project root: $r" ;;
  esac
  ROOTS+=("$r")
done
[ ${#ROOTS[@]} -gt 0 ] || die "PROJECT_ROOTS has no usable entry"

CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
[ -n "$CLAUDE_BIN" ] || die "claude not found; install Claude Code system-wide or set CLAUDE_BIN"
CLAUDE_REAL="$(realpath -e -- "$CLAUDE_BIN")" || die "CLAUDE_BIN does not exist"
[[ "$CLAUDE_BIN" =~ ^/[A-Za-z0-9._/+-]+$ ]] || die "CLAUDE_BIN must be a plain absolute path"
[ -x "$CLAUDE_REAL" ] || die "CLAUDE_BIN not executable"
[ "$(stat -c %u -- "$CLAUDE_REAL")" = 0 ] || die "claude binary $CLAUDE_REAL must be owned by root (install it as root, not per user)"
(( (8#$(stat -c %a -- "$CLAUDE_REAL") & 8#022) == 0 )) || die "claude binary $CLAUDE_REAL is writable by group/others"

GIT_VER="$(git --version 2>/dev/null | sed -n 's/^git version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
[ -n "$GIT_VER" ] || die "git not found or version not readable"
GIT_MAJOR="${GIT_VER%%.*}"; GIT_MINOR="${GIT_VER#*.}"
{ [ "$GIT_MAJOR" -gt 2 ] || { [ "$GIT_MAJOR" -eq 2 ] && [ "$GIT_MINOR" -ge 43 ]; }; } || die "git 2.43 or newer required (found $GIT_VER)"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die "node not found; set NODE_BIN to a node 24 binary"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || die "node 24+ required (found $NODE_MAJOR)"
[ -f "$DEVFLOW_DIR/ops/dfctl" ] || die "ops/dfctl not found under $DEVFLOW_DIR"

step "service user $SERVICE_USER and folders"
install -d -m 0755 -o root -g root /var/lib/devflow /var/lib/devflow/users
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/devflow/data --no-create-home --shell /usr/sbin/nologin \
    --comment "DevFlow service" "$SERVICE_USER"
fi
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" /var/lib/devflow/data
for r in "${ROOTS[@]}"; do
  if [ -e "$r" ]; then
    [ -d "$r" ] && [ ! -L "$r" ] || die "project root $r exists but is not a plain directory"
    echo "project root $r exists (owner $(stat -c %U -- "$r")); seat users need execute permission on it"
  else
    # devflow creates project folders here; seat users only traverse (x) to reach their projects.
    install -d -m 0711 -o "$SERVICE_USER" -g "$SERVICE_USER" "$r"
  fi
done

step "kernel protections and cron/at"
[ "$(cat /proc/sys/fs/protected_hardlinks)" = 1 ] && [ "$(cat /proc/sys/fs/protected_symlinks)" = 1 ] \
  || die "fs.protected_hardlinks and fs.protected_symlinks must be 1 (dfctl refuses seat runs otherwise)"
# dfctl provision-user adds every dfu-* account to /etc/cron.deny and /etc/at.deny. Those files are ignored
# when /etc/cron.allow or /etc/at.allow exists; then the allow file must not list any dfu-* account.
for f in /etc/cron.allow /etc/at.allow; do
  if [ -e "$f" ] && grep -q '^dfu-' "$f"; then die "$f lists dfu-* accounts; remove them"; fi
done

step "dfctl"
install -d -m 0755 -o root -g root /usr/local/lib/devflow /etc/devflow
install -m 0755 -o root -g root "$DEVFLOW_DIR/ops/dfctl" "$DFCTL_DST"
bash "$DFCTL_DST" --self-test >/dev/null || die "dfctl --self-test failed"
CONF_TMP="$(mktemp /etc/devflow/.dfctl.conf.XXXXXX)"
{
  echo "# Written by install-server.sh. Read only by dfctl (root)."
  echo "PROJECT_ROOTS=$(IFS=,; echo "${ROOTS[*]}")"
  echo "CLAUDE_BIN=$CLAUDE_BIN"
} > "$CONF_TMP"
chmod 0644 "$CONF_TMP"
mv -f -- "$CONF_TMP" /etc/devflow/dfctl.conf
install -d -m 0700 -o root -g root /var/lib/dfctl /var/lib/dfctl/projects

step "sudoers"
SUDO_TMP="$(mktemp)"
cat > "$SUDO_TMP" <<EOF
# DevFlow: the service user may run exactly the dfctl wrapper as root, without a password.
# I/O logging is off for it so login codes typed by users are never recorded.
Defaults!$DFCTL_DST !log_input, !log_output, !requiretty
$SERVICE_USER ALL=(root) NOPASSWD: $DFCTL_DST
EOF
visudo -cf "$SUDO_TMP" >/dev/null || die "generated sudoers rule failed visudo"
install -m 0440 -o root -g root "$SUDO_TMP" /etc/sudoers.d/devflow
rm -f -- "$SUDO_TMP"
visudo -c >/dev/null || die "sudoers no longer valid after adding /etc/sudoers.d/devflow"

step "Claude Code managed settings"
install -d -m 0755 -o root -g root /etc/claude-code
MS=/etc/claude-code/managed-settings.json
if [ -f "$MS" ]; then
  cp -p -- "$MS" "$MS.bak.$(date +%Y%m%d%H%M%S)"
  echo "backed up existing $MS"
fi
MS_TMP="$(mktemp /etc/claude-code/.managed-settings.XXXXXX)"
printf '{\n  "forceLoginMethod": "claudeai",\n  "forceLoginOrgUUID": "%s"\n}\n' "$ORG" > "$MS_TMP"
chmod 0644 "$MS_TMP"
mv -f -- "$MS_TMP" "$MS"

step "systemd unit"
install -d -m 0755 -o root -g root "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  install -m 0600 -o root -g root "$DEVFLOW_DIR/.env.example" "$ENV_FILE"   # systemd reads it as root
  echo "created $ENV_FILE from .env.example: fill in DEVFLOW_MODE=server, SECRET_KEY, Google settings, PROJECT_ROOTS, DATA_DIR=/var/lib/devflow/data"
fi
cat > /etc/systemd/system/devflow.service <<EOF
[Unit]
Description=DevFlow v3 (server mode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DEVFLOW_DIR
EnvironmentFile=$ENV_FILE
Environment=DEVFLOW_MODE=server
ExecStart=$NODE_BIN dist/index.js
# If DevFlow stops or crashes, dfctl processes in this cgroup die with it; stop the seat scopes they left.
ExecStopPost=+$DFCTL_DST reap
# Group-writable files so seat users (members of dfp-<project>) can work in shared project folders.
UMask=0002
Restart=on-failure
RestartSec=5
# Covers ExecStopPost too: reap stops orphaned seat scopes one by one, up to ~10 s each (TERM then KILL, 5 s
# grace each). 120 s covers about 11 stubborn scopes; raise it if MAX_CONCURRENT_JOBS is higher (deploy-vps §9).
TimeoutStopSec=120
# NoNewPrivileges must stay off: DevFlow reaches dfctl through sudo.
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable devflow >/dev/null

cat <<EOF

Done. Next steps:
  1. Edit $ENV_FILE (DEVFLOW_MODE=server, SECRET_KEY, PUBLIC_BASE_URL, GOOGLE_*, ALLOWED_EMAIL_DOMAINS,
     ADMIN_EMAILS, PROJECT_ROOTS=$(IFS=,; echo "${ROOTS[*]}"), DATA_DIR=/var/lib/devflow/data).
  2. Build as the service user: cd $DEVFLOW_DIR && npm ci && npm run build (owner must be able to read it).
  3. Run the seat login spike once: sudo scripts/spike-claude-login.sh --cleanup
  4. systemctl start devflow && journalctl -u devflow -f
EOF
