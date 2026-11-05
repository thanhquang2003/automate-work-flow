# /lah:resume

Print a structured session resume brief: queue status with emoji icons, checkpoint state, last handoff from `state/progress.md`, autosave content, and a next-action box.

## When to use

Run at the start of every session to orient yourself before touching any code.

## Usage

```
lah resume
```

No flags. Reads from `state/*.json`, `.claude/checkpoints/`, `state/progress.md`, and `session-autosave.md`.

## Output sections

| Section | Source |
|---------|--------|
| **Queue Status** | `state/defect_list.json`, `task_list.json`, `feature_list.json` — open/in-progress items with `✅⏳⬜🚫` icons |
| **Checkpoints** | `.claude/checkpoints/*.done` and `*.partial` files |
| **Last Handoff** | `### Handoff` block from `state/progress.md` |
| **Autosave** | `session-autosave.md` (if present) |
| **Next action** | Box showing highest-priority open item |

## Example

```
════════════════════════════════════════
  Session Resume Brief
════════════════════════════════════════

## Queue Status
  ⬜ [HIGH] TASK-022: Write integration tests

## Checkpoints
  No checkpoints.

## Last Handoff
  BUG-001 resolved (PR #8). Next: TASK-022.

┌─────────────────────────────────────────────┐
│  Next: work on TASK-022 — Write integration…│
└─────────────────────────────────────────────┘
```

## See also

- `lah save` — write current session state to `session-autosave.md`
- `lah status` — shorter queue-only view
