---
name: add
description: Add a new work item (feature, defect, or task) to the Lean AI Harness queue. Supports interactive mode (no flags) and non-interactive mode (--title/--name + --description required). Usage: /lah:add <type> [flags]
---

Run the lah add command for the given type:

```bash
lah add $ARGUMENTS
```

If `lah` is not installed globally, fall back to:

```bash
node packages/cli/dist/index.js add $ARGUMENTS
```

## Non-interactive mode (preferred for agents)

```bash
# Defect
lah add defect --title "Title" --description "Description" --severity high --layer Backend

# Task
lah add task --title "Title" --description "Description" --type chore --priority medium --deps "TASK-001,BUG-001"

# Feature
lah add feature --name "Name" --description "Description" --layer Full-stack --dependencies "FEAT-001"
```

If `--title`/`--name` and `--description` are both provided, readline prompts are skipped entirely.
Missing optional flags use defaults (severity: high, priority: medium, type: chore, layer: Backend/Full-stack).

After adding, confirm the new item ID and title to the user.
