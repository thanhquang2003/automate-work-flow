---
name: start
description: Mark a Lean AI Harness work item as in-progress. Usage: /lah:start <id> e.g. /lah:start TASK-001
---

Mark the given item as in-progress:

```bash
lah start $ARGUMENTS
```

If `lah` is not installed globally, fall back to:

```bash
node packages/cli/dist/index.js start $ARGUMENTS
```
