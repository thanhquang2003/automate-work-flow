# /lah:save

Capture the current session state to `session-autosave.md` — in-progress items, partial checkpoints, git log, and resume instructions.

## When to use

Run before ending a session or when interrupted mid-task. The `Stop` hook in `.claude/settings.json` calls this automatically if you used `lah init`.

## Usage

```
lah save
```

No flags. Writes `session-autosave.md` in the project root.

## What gets saved

- **Active Work Items** — all defects/tasks/features with `status: in-progress`
- **Checkpoints** — `.done` and `.partial` files from `.claude/checkpoints/`
- **Git State** — last 3 commits + `git status --short`
- **Resume Instructions** — step-by-step guide to pick up where you left off

## When nothing is saved

If there are no in-progress items, no partial checkpoints, and a clean git tree, `lah save` prints "Nothing to save" and exits 0 without writing the file.

## See also

- `lah resume` — read the autosave and full session context back at session start
