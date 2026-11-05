# /lah:init

Scaffold a new project with lean-ai-harness: state files, AGENTS.md, init.sh, role prompt templates, hooks, and `.claude/settings.json`.

## When to use

Once, at the start of a new project. Safe to re-run — existing files are skipped unless `--force` is passed.

## Usage

```
lah init
lah init --force
```

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing files |

## What gets created

| Path | Description |
|------|-------------|
| `state/feature_list.json` | Feature registry (empty) |
| `state/defect_list.json` | Defect registry (empty) |
| `state/task_list.json` | Task registry (empty) |
| `state/progress.md` | Session log — overwrite-latest format |
| `AGENTS.md` | Agent operating manual with 28 working rules |
| `init.sh` | Gate check script (customize for your stack) |
| `docs/prompts/` | 7 role prompt templates |
| `.claude/checkpoints/` | Checkpoint directory |
| `.claude/hooks/pre-gate.sh` | Safety gate — blocks destructive ops |
| `.claude/hooks/sync-main.sh` | Auto-syncs main worktree after push/merge |
| `.claude/settings.json` | 5 hooks wired: PreToolUse gate, SessionStart resume+fetch, Stop save, PostToolUse sync |
| `.claude/skills/lah/` | 9 slash-command skill docs |

## After init

```bash
# 1. Customize AGENTS.md with your project name and context
# 2. Update init.sh for your build/test stack
# 3. Add your first work item
lah add task --title "..." --description "..." --type chore --priority high

# 4. Start the autonomous loop
lah run
```

## See also

- `lah add` — add features, defects, tasks
- `lah run` — start the autonomous work loop
- `lah status` — view queue at any time
- `lah upgrade` — update template files when the harness releases a new version
