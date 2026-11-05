# AGENTS.md — Agent Operating Manual

## What This Project Is

<!-- TODO: Describe your project here -->
DevFlow is a web application that automates the company's software-development process with headless Claude Code (intake → analysis → clarification → design → breakdown → tasks → develop → test → review). Node 24 + TypeScript, Fastify/Eta/htmx, `node:sqlite`, vitest. Source of truth for v3 work: `docs/superpowers/specs/2026-11-07-v3-roles-and-lah-delta-design.md` and `docs/superpowers/plans/2026-11-07-v3-implementation.md`.

## Project overrides (DevFlow) — these win over the generic rules below

- **Node 24 required:** `export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH` before any npm/npx/node command.
- **Base branch is `feat/v3-multiuser`, not `main`.** Branch each work item as `feat/FEAT-XXX` / `fix/BUG-XXX` / `task/TASK-XXX` off `feat/v3-multiuser`; after the gate passes merge with `git merge --ff-only` into `feat/v3-multiuser`. Ignore rules 12-16 where they mention PRs, `origin/main`, `gh`, or pushing: **never `git push`, never open PRs** — the project owner pushes. Local commits are the deliverable.
- **Gate:** `bash init.sh --verify` (tsc + build + vitest). Tests can time out under load; before calling a failure real, re-run that file alone with `npx vitest run <file> --maxWorkers=1 --testTimeout=60000`.
- Execute work items with `superpowers:subagent-driven-development` following the plan; the plan's Global Constraints bind every item.


## Quick Start — Read These First

| Priority | File | Why |
|----------|------|-----|
| 1 | `state/feature_list.json` | What to work on, what's done |
| 2 | `state/defect_list.json` | Open bugs and defects — check before starting new features |
| 3 | `state/task_list.json` | Engineering tasks — refactors, upgrades, chores, tech-debt |
| 4 | `state/progress.md` | Last session state — pick up here |
| 5 | `state/progress.md` (last `### Handoff` block) | Last session handoff — exact restart point |

## How Tasks Are Executed

This project uses a **Role Orchestration Chain** with **complexity-based routing**.

The role chain used for each work item is determined by its `complexity` field (optional). If absent, the type default applies:

| Complexity | Role Chain | Default for |
|-----------|------------|-------------|
| `trivial` | Developer | — |
| `small` | Developer → Cleaner → Reviewer | Defects, Tasks |
| `medium` | Planner → Developer → Cleaner → Reviewer → Tester | — |
| `large` | Architect → Planner → Developer → Cleaner → Reviewer → Tester | Features |
| `epic` | PM → Architect → Planner → Developer → Cleaner → Reviewer → Tester | — |

Each role has a prompt in `docs/prompts/`. Each role validates the previous output.
**Never skip a role in the selected chain.** Each one acts as a quality gate.

## Autonomous Work Trigger

After the gate check passes, **do not stop**. Proceed immediately.

1. Read `state/defect_list.json` — pick the highest-severity `open` or `in-progress` defect
2. If no qualifying defects: read `state/task_list.json` — pick the highest-priority `open` or `in-progress` task
3. If no qualifying tasks: read `state/feature_list.json` — pick the next `planned` feature
4. Execute the work following the role chain
5. Update state files and commit before stopping

## Working Rules

### State Management

1. **Pull before touching any worktree** — before making any edits, commits, or `lah add` calls, run `git pull` first. This is especially critical before adding work items: `nextId()` reads the local state file and will produce a duplicate ID if the file is behind `origin/main`.
2. **Read `state/progress.md` first** — it tells you what happened last session and what's next.
3. **Queue priority — defects before tasks before features** — check open/in-progress defects first (highest-severity first), then tasks (highest-priority first), then features (in list order). Resolve critical/high defects before starting new features or tasks.
4. **Log defects immediately** — add to `state/defect_list.json` before continuing.
5. **Log tasks immediately** — add to `state/task_list.json` **before writing any code**.
6. **Mark items in-progress before starting work** — for any defect or task, set `status` to `in-progress`, fill `assigned_session` and `started` before writing any code or making any changes.
7. **Update state when completing work** — when resolving a defect: set `status` to `resolved`, fill `resolved_session`, `fix_commit`, `evidence`. When completing a task: set `status` to `done`, fill `completed_session`, `fix_commit`, `evidence`.
8. **Always use `lah add` to add work items — never edit state JSON directly** — `lah add feature|defect|task` atomically computes the next ID. Direct edits bypass this and will produce duplicate IDs when two sessions run concurrently.
9. **State files are the single source of truth** — never infer queue state from git history, PRs, or conversation context. Always read `state/*.json` directly.
10. **State-file-only commits push directly to `main` — no PR required** — commits that touch only `state/task_list.json`, `state/defect_list.json`, and/or `state/feature_list.json` (and nothing else) are exempt from Rule 12. Push them directly to `main` with `git push origin main`. Rationale: state files are queue bookkeeping, not code; requiring a PR review loop for every status update imposes friction with no safety benefit. Any commit that touches a source file must still go through a PR. When in doubt, use a PR.
11. **Archive `state/progress.md` when History exceeds 25 entries** — when the `## History` section grows beyond 25 lines, move all but the most recent 20 entries into `state/progress-archive.md`: (1) prepend a header line `## Archive — entries before <ISO-date>` to the archive file; (2) append the old entries; (3) trim `## History` in `progress.md` to the 20 most recent lines; (4) add a one-line note at the bottom of `## History`: `_(older entries archived to state/progress-archive.md)_`. The archive file is append-only — never delete or overwrite it.

### Git Workflow

12. **All code changes go through a PR** — never push code directly to `main`.
13. **Always push after committing** — after every `git commit`, immediately run `git push`. Do not wait to be asked.
14. **Sync main worktree after pushing** — after pushing from a worktree branch, run `git pull` on the main worktree so it stays in sync with the remote.
15. **Merge PRs autonomously after creating them** — after `gh pr create`, poll CI with `gh run list --branch <branch> --limit 3` and wait for `completed  success`, then merge via the REST API. If CI fails, fix the root cause, push a new commit, and re-confirm CI before retrying. Never merge with failing or pending CI checks. Do not leave PRs open waiting for human action unless a reviewer is explicitly required.
16. **Use rebase (not merge) to sync with main** — when syncing a worktree branch with `main`, always use `git rebase origin/main` (with `--autostash` if needed). Never use `git merge origin/main` or `git merge main`. Merge commits in feature branches obscure history and complicate bisect.
17. **Name worktree branches after the work item** — branches must follow the pattern `feat/FEAT-XXX`, `fix/BUG-XXX`, or `task/TASK-XXX`. Never use auto-generated names (e.g. `worktree-1`) or informal names (e.g. `my-fix`). If a worktree was created with a wrong name, rename the branch (`git branch -m <new-name>`) before making any commits — changing a branch name after pushing requires a force-push and breaks open PRs.
18. **Keep worktree branches short-lived** — merge to `main` via PR after every completed work item. Never let a worktree branch accumulate multiple unmerged work items.
19. **Two consecutive gate failures → stop and escalate** — if the gate check fails twice in a row, do not attempt a third iteration. Write the blocker to `state/progress.md` and exit. Repeated retries on a broken build waste compute and can corrupt state.

### Autonomous Loop

20. **One work item at a time (sequential) or --parallel N (concurrent)** — by default execute items sequentially: complete one fully (code → PR → merge → state update) before starting the next. When `lah run --parallel N` is used, up to N items are pre-selected and spawned simultaneously; each Claude session works only on its pre-assigned item (passed via `--item <ID>` in the prompt). Per-item logs land in `.claude/session-<ID>.log`. Never mix parallel and sequential mid-loop — the mode is fixed at startup. **Recommended starting value: `--parallel 2`.** Increase to 3–4 only when work items touch entirely different parts of the codebase; beyond 4, merge conflicts and API rate limits typically cancel the throughput gain. `N` must be a positive integer (invalid values are rejected at startup); values above 4 warn but proceed; the batch auto-clamps when fewer independent items are available than requested workers. **`--parallel` is CLI-only** — it requires N separate Claude processes, which only the `lah run` terminal command can spawn. An inline run inside a single Claude conversation is always sequential regardless of any parallel flag.
21. **The autonomous loop has no check-in points** — once the loop is active, execute each work item end-to-end then immediately loop to the next. Never pause between items, between phases of the same item, or after completing a preparatory step (cleanup PR merged, tasks added to queue, worktree created, CI passed). Stop only when: (a) all three queues are truly empty, or (b) a genuine human-action blocker exists — a specific action only a human can take (auth, access grant, a decision with no reasonable default). A phase transition, a CI result, a queue that just grew, or a new worktree to enter is never a stopping point.
22. **Do not report `result:` until the entire session goal is complete** — completing a sub-step is not done. Only write `result:` when all queued work, all commits, all pushes, PR created, and PR merged are finished.
23. **Session-start verification is preamble, not deliverable** — running status checks, health checks, or any other startup verification step only confirms the tool is healthy. After any such check, if the queue shows open work, proceed immediately to the first item. Never treat verification as the session goal unless the user's request is explicitly about tool health with no work item context.
24. **Meta-work is not a stopping point — re-open means re-fix** — updating state files, correcting DoDs, re-opening a defect, or writing a new AGENTS.md rule are bookkeeping steps, not deliverables. After any such meta-work, immediately continue.

### Quality & Safety

25. **Verify before declaring done** — run the gate check and ensure all checks pass before declaring any work done.
26. **Self-verify before marking any work item done** — before setting `status: done/resolved`, verify five dimensions: (1) **Completeness** — does the change address every requirement in the task/defect description? (2) **Correctness** — does the code compile and all tests pass? (3) **Test coverage** — are edge cases and negative scenarios covered by tests? (4) **Security** — are secrets, injection points, or over-exposure introduced? (5) **Adjacent impact** — have all files referencing changed concepts (types, config keys, conventions) been searched with grep and updated? Only after all five pass should the status be changed to done.
27. **Write E2E tests for every new user-facing command** — any new CLI command must have at least one integration test that exercises the golden path.
28. **Hooks enforce; AGENTS.md guides — never add a rule for something a hook already enforces** — if a behavior can be enforced at the tool level (blocked by a pre-gate hook, auto-approved by `permissions.allow`, auto-triggered by a hook event), put it in the hook, not here. AGENTS.md rules are for context-dependent judgment that hooks cannot express. Before adding a new rule, ask: can a hook enforce this? If yes, update the hook instead.
29. **Change impact analysis — grep before completing any rename/replace/deprecate** — before completing a change that renames, replaces, or deprecates a concept (type name, config key, env variable, file path, convention), perform a project-wide search: (1) identify the concept(s) being changed; (2) run a search across the entire project root for the old name and any known aliases; (3) for every file found — update it, mark deprecated with a pointer, or document why no change is needed; (4) re-run the search to confirm no active references remain. Never present the change as done while stale references exist in source files.
30. **Error and ambiguity handling — respond predictably to blockers** — when encountering a blocker mid-task, respond according to its type: (1) **Ambiguous requirement** — ask ONE clarifying question; propose the most likely interpretation and proceed with it if no reply is expected; (2) **Missing context** — state exactly what is missing and where to find it; do not guess; (3) **Conflicting rules** — flag the conflict explicitly (cite both rules by number) and halt; do not silently pick one; (4) **Task too large** — decompose into sub-tasks, add them to the queue, and implement one at a time; never half-complete a large task; (5) **Security concern** — stop immediately, flag the concern, explain the risk, suggest a remediation. Never guess when security, data loss, or production stability is at stake.
31. **Write checkpoint files at every major step boundary** — before each major step (plan written, code committed, PR created, PR merged), write a checkpoint: `lah checkpoint <ITEM-ID> <stepname>` (or `echo done > .claude/checkpoints/<ITEM-ID>-<stepname>.done`). On session resume, read `.done` files to skip completed steps and `.partial` files to resume interrupted ones. Delete all checkpoint files for the item once the PR is merged.
32. **Use fresh subagents for bounded subtasks — never `subagent_type: fork`** — code review, research spikes, and analysis work must be delegated to a fresh subagent (no `subagent_type` or an explicit type like `Explore`). Forks inherit the full conversation context and may continue the entire workflow rather than returning just their findings. A fresh agent knows only what is in its prompt. Rule of thumb: if the subagent must NOT take any action beyond returning its findings, it must be a fresh agent.
33. **Self-correct without being asked** — after completing the Session Exit Checklist, perform a self-review: (a) check for behavioral anti-patterns and encode as new AGENTS.md rules; (b) check that every file touched by the implementation has its corresponding docs/skills/README updated — if not, fix immediately.

### Agent Governance

34. **Never ask for confirmation on obvious next steps** — if the next action is clearly implied by the current context, do it without asking. Only ask when a genuine decision requires human judgement.
35. **Never ask rhetorical questions before acting** — "should we add a rule?" when a rule is clearly needed, "should we create a PR?" when work needs merging — the answer is always yes. Identify the action, do it, record it. Questions are for genuine ambiguity only.
36. **All agent learnings go into AGENTS.md, never into personal Claude memory** — when a behavioral anti-pattern, new rule, or process improvement is identified during a session, encode it directly in AGENTS.md and commit it to the project. Project rules belong in the project; personal memory is for cross-project facts only.

## Definition of Done — Feature

- [ ] Code compiles and all tests pass
- [ ] All Acceptance Criteria covered by tests
- [ ] PR created; CI passes (`gh run list --branch <branch> --limit 3` shows `completed  success`); PR merged to `main`
- [ ] `state/feature_list.json` marked as `done` with evidence link (PR URL)
- [ ] `state/progress.md` updated with session summary and `### Handoff` block
- [ ] All commits pushed to remote
- [ ] Queues re-checked — continue to next item if any remain

## Definition of Done — Defect

- [ ] Fix implemented and committed
- [ ] All commits pushed to remote
- [ ] PR created; CI passes (`gh run list --branch <branch> --limit 3` shows `completed  success`); PR merged to `main`
- [ ] `state/defect_list.json` updated: `status: resolved`, evidence filled
- [ ] `state/progress.md` updated with session summary
- [ ] Queues re-checked — continue to next item if any remain

## Definition of Done — Task

- [ ] Change implemented and committed
- [ ] All commits pushed to remote
- [ ] PR created; CI passes (`gh run list --branch <branch> --limit 3` shows `completed  success`); PR merged to `main`
- [ ] `state/task_list.json` updated: `status: done`, evidence filled
- [ ] `state/progress.md` updated with session summary
- [ ] Queues re-checked — continue to next item if any remain

## Session Exit Checklist

Before declaring any session complete, run through this checklist explicitly. Do not skip steps. Do not write `result:` until every box is checked.

- [ ] Work item marked `done`/`resolved` in its JSON state file with `evidence` filled
- [ ] All changes committed (`git status` is clean)
- [ ] All commits pushed (`git push` — no unpushed commits)
- [ ] PR created targeting `main` (`gh pr create`) — record the PR URL
- [ ] CI green — run `gh run list --branch <branch> --limit 3` and confirm `completed  success`; **never merge with failing or pending CI**
- [ ] PR merged via GitHub API (`gh api repos/<owner>/<repo>/pulls/$PR_NUMBER/merge --method PUT --field merge_method=squash`) — do not use `gh pr merge` (see Rule 15)
- [ ] Worktree removed via `ExitWorktree(action: "remove")` — not raw `git worktree remove`
- [ ] `state/progress.md` `## Latest Session` updated with PR URL in the `### Handoff` block
- [ ] Main worktree pulled (`git -C <main-worktree-path> pull`)
- [ ] All three queues re-checked — if any item remains, continue; only stop when all are empty
- [ ] Self-review — did any behavioral anti-pattern occur this session? If yes, encode it as a new AGENTS.md rule immediately (commit + push + PR + merge) without waiting to be asked

**Enforcement:** If any step is missing, do it immediately before continuing. Never ask the user to confirm these steps — they are unconditional.

## state/progress.md Format

`state/progress.md` has exactly two sections. **Always overwrite `## Latest Session`; never append to it.** Only `## History` grows over time.

```markdown
# Progress

## Latest Session

**Date:** <ISO timestamp>
**Verify:** PASS | FAIL | SKIPPED | STOPPED
**Detail:** <one line — what the harness recorded>

### Handoff

<Exact restart point written by the agent — what was done, what's next, any blockers.>

---

## History

- <ISO date> — <PASS|FAIL|SKIPPED> — <one-line summary>
```

Rules:
- **`## Latest Session`** — replaced each session. Preserve the `### Handoff` block across harness-only writes (gate results); only the agent overwrites the full block when completing a work item.
- **`### Handoff`** — the agent writes this at the end of every completed work item. It must be self-contained: a new agent reading only this block should know exactly where to pick up.
- **`## History`** — one line prepended per session (archived from the previous `## Latest Session`). Never edited; append-only. When it exceeds 25 entries, archive the oldest entries to `state/progress-archive.md` per Rule 11.

## Environment Requirements

| Variable | Purpose |
|----------|---------|
| `GH_TOKEN` | GitHub PAT — required for autonomous `gh pr create/merge`. |

## Key Paths

| Path | Purpose |
|------|---------|
| `state/feature_list.json` | Feature registry |
| `state/defect_list.json` | Defect registry |
| `state/task_list.json` | Task registry |
| `state/progress.md` | Session-by-session log |
| `docs/prompts/` | Role prompt templates |
| `docs/specs/` | Feature specs |
