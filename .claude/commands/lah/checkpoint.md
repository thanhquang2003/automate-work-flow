# /lah:checkpoint

Write a checkpoint file marking a step within a work item as done or partially complete. Use to record progress within a single task so a future session can resume without replaying already-finished steps.

## When to use

After each meaningful sub-step inside a task — e.g. after writing a file, after a successful build, after a test run. Call with no `--partial` to mark complete; call with `--partial <note>` to record where you stopped.

## Usage

```
lah checkpoint <id> <step>
lah checkpoint <id> <step> --partial "<note>"
```

| Argument / Flag | Description |
|-----------------|-------------|
| `<id>` | Work item ID — e.g. `TASK-001`, `BUG-003` |
| `<step>` | Short kebab-case step name — e.g. `write-tests`, `fix-reader` |
| `--partial <note>` | Mark as partial; note describes what remains |

## Examples

```bash
# Step completed
lah checkpoint TASK-022 write-test-files

# Step partially done — interrupted
lah checkpoint TASK-022 write-test-files --partial "add.test.ts done, resume-save.test.ts remaining"

# Completing a previously partial step automatically removes the .partial file
lah checkpoint TASK-022 write-test-files
```

## File locations

Checkpoint files live in `.claude/checkpoints/`:
- `<id>-<step>.done` — step complete
- `<id>-<step>.partial` — step in progress, file content is the note

## Listing checkpoints

```bash
lah checkpoints
```

## See also

- `lah resume` — shows all checkpoints in the session brief
- `lah save` — includes partial checkpoints in the autosave
