#!/usr/bin/env bash
# Remove stale worktrees whose remote branch no longer exists.
# Runs at SessionStart — safe because no active worktree has been created yet.
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0

git fetch origin --quiet 2>/dev/null || true

# Parse worktree list: extract path + branch pairs
git worktree list --porcelain 2>/dev/null \
  | awk '/^worktree /{wt=$2} /^branch /{print wt " " $2}' \
  | while IFS=' ' read -r wt_path branch_ref; do
      # Only touch worktrees managed under .claude/worktrees/
      case "$wt_path" in
        *"/.claude/worktrees/"*) ;;
        *) continue ;;
      esac
      branch="${branch_ref#refs/heads/}"
      # If branch still exists on remote, leave the worktree alone
      if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
        continue
      fi
      echo "[prune-worktrees] removing stale worktree: $wt_path (branch '$branch' gone from origin)"
      git worktree remove --force "$wt_path" 2>/dev/null || true
  done
