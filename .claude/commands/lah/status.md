---
name: status
description: Show the Lean AI Harness work queue (defects -> tasks -> features). Pass --all to include done/resolved items.
---

Run the lah status command:

```bash
lah status $ARGUMENTS
```

If `lah` is not installed globally, fall back to:

```bash
node packages/cli/dist/index.js status $ARGUMENTS
```
