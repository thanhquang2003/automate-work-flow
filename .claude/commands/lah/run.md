---
name: run
description: Start the Lean AI Harness autonomous outer loop — one Claude session per work item, runs until all queues are empty or max iterations reached.
---

Start the autonomous lah loop:

```bash
lah run $ARGUMENTS
```

If `lah` is not installed globally, fall back to:

```bash
node packages/cli/dist/index.js run $ARGUMENTS
```
