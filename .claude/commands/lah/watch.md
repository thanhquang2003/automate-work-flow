---
name: watch
description: Tail the live session log from a running lah run session. Streams .claude/session.log with ANSI codes stripped for readability.
---

Tail the live session log:

```bash
lah watch $ARGUMENTS
```

If `lah` is not installed globally, fall back to:

```bash
node packages/cli/dist/index.js watch $ARGUMENTS
```

Options:
- `--ansi` — preserve ANSI color codes (stripped by default)
- `--no-follow` — print existing log content and exit without tailing
