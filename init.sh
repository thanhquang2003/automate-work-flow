#!/usr/bin/env bash
# init.sh — Project gate check.
# Usage: bash init.sh           (full mode — sync + install + verify)
#        bash init.sh --verify  (verify-only — skips sync, runs checks)
#        bash init.sh --install (install-only — runs dependency install, no sync/verify)
#
# Add your project-specific checks below in the check_project() function.

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; FAILED=1; }
info() { echo -e "${CYAN}→ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }

VERIFY_ONLY=0
INSTALL_ONLY=0
FAILED=0

[[ "${1:-}" == "--verify"  ]] && VERIFY_ONLY=1
[[ "${1:-}" == "--install" ]] && INSTALL_ONLY=1

# ---------------------------------------------------------------------------
# Sync (skipped in --verify and --install modes)
# ---------------------------------------------------------------------------
do_sync() {
  info "Syncing git..."
  info "DevFlow: no remote sync (project owner pushes); skipping fetch/rebase"

  # Fast-forward the main worktree when running inside a git worktree
  _MAIN_WT=$(git worktree list --porcelain 2>/dev/null \
    | awk '/^worktree / { wt=substr($0,10) } /^branch refs\/heads\/main$/ { print wt; exit }')
  _CUR_WT=$(git rev-parse --show-toplevel 2>/dev/null)
  if [[ -n "$_MAIN_WT" ]] && [[ "$_MAIN_WT" != "$_CUR_WT" ]]; then
    git -C "$_MAIN_WT" pull --ff-only --quiet 2>/dev/null \
      && ok "Main worktree fast-forwarded" \
      || info "Main worktree fast-forward skipped (diverged or not needed)"
  fi
}

# Check whether the main worktree is behind origin/main (advisory — never fails the gate)
check_parent_sync() {
  _MAIN_WT=$(git worktree list --porcelain 2>/dev/null \
    | awk '/^worktree / { wt=substr($0,10) } /^branch refs\/heads\/main$/ { print wt; exit }')
  [[ -z "$_MAIN_WT" ]] && return
  _BEHIND=$(git -C "$_MAIN_WT" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  if [[ "${_BEHIND:-0}" -gt 0 ]]; then
    warn "Main worktree is ${_BEHIND} commit(s) behind origin/main."
    echo    "  Fix: git -C \"$_MAIN_WT\" pull --ff-only"
  fi
}

# ---------------------------------------------------------------------------
# Dependency install — put your install commands here
# Called by both --install mode and full check_project
# ---------------------------------------------------------------------------
install_deps() {
  # ── Node / npm ────────────────────────────────────────────────────────────
  # info "Installing dependencies..."
  # if (cd <your-package-dir> && npm ci --silent); then ok "Dependencies installed"
  # else fail "npm ci failed"; fi

  # ── Python / pip ─────────────────────────────────────────────────────────
  # info "Installing dependencies..."
  # if pip install -r requirements.txt -q; then ok "Dependencies installed"
  # else fail "pip install failed"; fi

  # ── Go ────────────────────────────────────────────────────────────────────
  # info "Fetching modules..."
  # if go mod download; then ok "Modules fetched"
  # else fail "go mod download failed"; fi

  # ── Default ───────────────────────────────────────────────────────────────
  export PATH="$HOME/.nvm/versions/node/v24.22.0/bin:$PATH"
  if [ -d node_modules ] || npm ci --silent; then ok "Dependencies installed"; else fail "npm ci failed"; fi
}

# ---------------------------------------------------------------------------
# Project-specific checks — add your build/test commands here
# ---------------------------------------------------------------------------
check_project() {
  install_deps

  # ── Node / npm ────────────────────────────────────────────────────────────
  # info "Building..."
  # if (cd <your-package-dir> && npm run build --silent); then ok "Build passed"
  # else fail "Build failed"; fi
  #
  # info "Running tests..."
  # if (cd <your-package-dir> && npm test); then ok "Tests passed"
  # else fail "Tests failed"; fi

  # ── Python / pytest ───────────────────────────────────────────────────────
  # info "Running tests..."
  # if pytest; then ok "Tests passed"
  # else fail "Tests failed"; fi

  # ── Go ────────────────────────────────────────────────────────────────────
  # info "Building..."
  # if go build ./...; then ok "Build passed"
  # else fail "go build failed"; fi
  #
  # info "Running tests..."
  # if go test ./...; then ok "Tests passed"
  # else fail "go test failed"; fi

  # ── Default ───────────────────────────────────────────────────────────────
  info "Type check..."
  if npx tsc --noEmit; then ok "tsc passed"; else fail "tsc failed"; fi
  info "Build..."
  if npm run build --silent; then ok "Build passed"; else fail "Build failed"; fi
  info "Running tests..."
  if npx vitest run --maxWorkers=2 --testTimeout=120000; then ok "Tests passed"; else fail "Tests failed"; fi
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "============================================"
echo "  Gate Check — $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

if [[ "$INSTALL_ONLY" -eq 1 ]]; then
  install_deps
elif [[ "$VERIFY_ONLY" -eq 1 ]]; then
  check_parent_sync
  check_project
else
  do_sync
  check_parent_sync
  check_project
fi

echo ""
if [[ "$FAILED" -eq 0 ]]; then
  echo -e "${GREEN}ALL CHECKS PASSED${NC}"
  exit 0
else
  echo -e "${RED}CHECKS FAILED — see errors above${NC}"
  exit 1
fi
