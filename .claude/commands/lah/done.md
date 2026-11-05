---
name: done
description: Mark a Lean AI Harness work item as done/resolved. Usage: /lah:done <id> --evidence <url> [--commit <hash>]
---

Mark the given item as done with required evidence:

```bash
lah done $ARGUMENTS
```

If `lah` is not installed globally, fall back to:

```bash
node packages/cli/dist/index.js done $ARGUMENTS
```
