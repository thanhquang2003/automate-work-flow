# DevFlow v3 Multi-user Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shared-VPS DevFlow: Google SSO, projects as folders, per-project roles (PM/BA/SE/DEV/REVIEWER/TESTER) with per-role approvals, each Claude run on the responsible person's own Claude Team seat (isolated Linux account via sudo `dfctl`), parallel requests/tasks on separate git worktrees.

**Architecture:** Keep the v2 engine; add a project/user/permission layer, a `SeatRunner` abstraction (local = v2 behaviour; sudo = `sudo -n /usr/local/lib/devflow/dfctl run-claude …`), stage→role→seat resolution with a new `awaiting_seat` status and per-seat queues, and a `Workspace` rooted in the project folder with git worktrees per request and per task.

**Tech Stack:** existing (Node 24, TS, Fastify/Eta/htmx, node:sqlite, zod, vitest) + `openid-client` (Google OIDC). No native modules (PTY via util-linux `script` inside `dfctl`).

**Spec:** `docs/superpowers/specs/2026-11-06-v3-multiuser-projects-design.md` (v1/v2 specs still apply).

## Global Constraints

- Project roles exactly: `PM`, `BA`, `SE`, `DEV`, `REVIEWER`, `TESTER`. System roles: `admin`, `pm`, `member`.
- Stage → responsible role (seat) → approver (spec §5.4 table): CODEBASE_SCAN SE/SE; ANALYSIS BA/BA; CLARIFY –/BA; BREAKDOWN BA/BA; DESIGN SE/SE; PLANNING DEV(tasks)+TESTER(test cases)/both; DEVELOP task assignee (fallback DEV of request), review seat REVIEWER / approver REVIEWER; TEST TESTER/–; BUGFIX assignee of failing feature's task (fallback DEV)/–, review seat REVIEWER; CHANGE BA/PM decides; DONE –/PM (review mode). PM may approve any gate. Admin has no project rights unless a member.
- Request code entered by PM: unique per project, `^[A-Za-z0-9._-]{1,40}$`, must not collide with an existing git branch `devflow/<code>`; suggestion `<KEY>-NNN`. Internal `requests.id` = `<KEY>.<code>` for new requests; legacy v2 requests keep their id.
- Project folder layout: `.devflow/` added to `.git/info/exclude`; request workspace `.devflow/requests/<code>/{inputs,artifacts,evidence,logs}`; request worktree `.devflow/worktrees/<code>` on `devflow/<code>`; task worktree `.devflow/worktrees/<code>-<TASK>` on `devflow/<code>-<TASK>`; markdown docs committed under `docs/devflow/<code>/`; at DONE final Office deliverables + evidence copied to `docs/devflow/<code>/deliverables/` and committed. DevFlow never deletes project folders; never modifies the default branch.
- Server mode: Linux only; refuses to start without `/usr/local/lib/devflow/dfctl` (path overridable by `DFCTL_PATH` for tests). OS accounts `dfu-<userId>`, groups `dfp-<projectId>`. DevFlow never reads, stores or logs Claude credentials; login code typed by user is passed to the login process stdin and never persisted or logged.
- Seats: `SEAT_CONCURRENCY` default 1; `MAX_CONCURRENT_JOBS` default 4 in server mode; `awaiting_seat` re-check every 10 min and on seat reconnect.
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, callback `${PUBLIC_BASE_URL}/auth/google/callback`, `ALLOWED_EMAIL_DOMAINS` (comma list), `ADMIN_EMAILS`, require `email_verified`. Break-glass: `BREAKGLASS_ADMIN` + `npm run admin:set-password`.
- Other env: `PROJECT_ROOTS` (admin-editable in settings; env is initial value), `CLAUDE_TEAM_ORG_UUID` (install script → managed settings).
- Local mode (`DEVFLOW_MODE=local`) keeps v2 behaviour: implicit single user with all roles in every project, LocalSeatRunner, no OS accounts.
- All permission checks server-side; every write action recorded in `audit_log`.
- Commits end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01BxS8QX2XywncstWNkk5bXQ`.

## Review Focus

1. User removed from a project while their seat runs a job there → job cancelled, group removed after (Task 5 test `removing member cancels their running jobs`).
2. Two requests of one project run concurrently → separate worktrees, no file interference, merges serialized (Task 5 test `parallel requests use separate worktrees`).
3. Seat login expires mid-stage ("Login expired") → stage goes `awaiting_seat`, not failed; resumes after reconnect (Task 5 test `expired seat pauses then resumes`).
4. Non-member or wrong-role user POSTs approve/decide/assign → 403 + no state change (Task 7 test `role enforcement on every write route`).
5. Path given for a new project outside PROJECT_ROOTS or via symlink escape / `..` → rejected (Task 3 test `project path must resolve under roots`).

---

### Task 1: Data model v3 and in-place migration

**Files:** Modify `src/db/db.ts`, `src/db/repo.ts`, `src/domain/types.ts`, `src/config.ts`, `.env.example`; Create `src/db/migrate-v3.ts`, `scripts/migrate-v3.ts` (+ npm script `migrate:v3`); Test `tests/db/v3-model.test.ts`.

**Produces:** tables/columns: `users` += `email unique, google_sub unique, display_name, sys_role ('admin'|'pm'|'member'), os_user, disabled`; `projects(id integer pk, key unique, name, path unique, gitlab_project, default_branch, created_by, created_at, archived)`; `project_members(project_id, user_id, roles JSON, added_by, added_at, pk(project_id,user_id))`; `requests` += `project_id, code, legacy_workspace int default 0` with unique (project_id, code); `request_assignees(request_id, role, user_id, pk(request_id, role))`; `tasks.assignee_id`; `approvals(request_id, stage, part, user_id, decision, note, at)`; `seat_status(user_id pk, status 'connected'|'expired'|'disconnected'|'unknown', detail, checked_at)`; `jobs.seat_user_id`; `audit_log(id, project_id, request_id, user_id, action, detail, at)`. Types: `ProjectRole`, `SysRole`, `ProjectRow`, `MemberRow`, `ApprovalRow`, `SeatStatusRow`; `RequestStatus` += `'awaiting_seat'`. Repo CRUD for all of these incl. `requestIdFor(projectKey, code)`, `suggestRequestCode(projectId)`, `membersWithRole(projectId, role)`, `rolesOf(projectId, userId)`, `assignee(requestId, role)`. Config fields listed in Global Constraints.
`migrateV3({repo, projectKey:'LEGACY', path, adminEmail})`: creates project, admin user as PM + all roles, assigns all existing requests (code = old id, legacy_workspace=1), assignees = that admin.

- [ ] Tests: `migration on a v2 db adds tables/columns idempotently`, `request code unique per project`, `requestIdFor`, `suggestRequestCode ERP-001 then ERP-002`, `migrateV3 assigns legacy requests and assignees`, `config parses ALLOWED_EMAIL_DOMAINS/ADMIN_EMAILS/PROJECT_ROOTS`, `server mode config requires google settings`.
- [ ] RED → implement → GREEN (`npx vitest run`, `npx tsc --noEmit`) → commit.

### Task 2: Google SSO, users, permissions

**Files:** Create `src/web/oidc.ts`, `src/security/permissions.ts`, `scripts/admin-set-password.ts`; Modify `src/web/auth.ts`, `src/web/routes/auth.ts`, `views/login.eta`, `package.json`; Test `tests/web/sso.test.ts`, `tests/security/permissions.test.ts`.

**Produces:** `GET /auth/google` (PKCE + state + nonce in a short-lived signed cookie) → Google; `GET /auth/google/callback` validates via `openid-client` (inject a fake issuer in tests), checks `email_verified` and domain ∈ ALLOWED_EMAIL_DOMAINS (by `hd` claim or email suffix), upserts user (admin if in ADMIN_EMAILS; first login triggers `systemOps.provisionUser` from Task 4 via an injected dependency, no-op in tests), sets session cookie (v1 format). `/login/local` only when BREAKGLASS_ADMIN set. `permissions.ts`: `can(ctx:{user, sysRole, projectRoles:Set<ProjectRole>}, action: Action, extra?)` with actions `project.create`, `project.manageMembers`, `request.create`, `request.assign`, `task.assign`, `change.submit`, `change.decide`, `stage.approve`(stage, part), `answers.edit`, `survey.create`, `admin.*`; table-driven per spec §5.4 and constraints (PM all project actions; BA create/submit change/answers/survey; approver per stage).
- [ ] Tests: `rejects other domain`, `rejects unverified email`, `creates member then admin from ADMIN_EMAILS`, `state mismatch rejected`, `breakglass hidden unless configured`, permissions table tests incl. `REVIEWER approves DEVELOP`, `DEV cannot approve DESIGN`, `PLANNING part approval by DEV/TESTER`, `admin without membership has no project rights`.
- [ ] RED → implement → GREEN → commit.

### Task 3: Projects, members, project-rooted workspaces

**Files:** Create `src/projects/service.ts`, `src/projects/paths.ts`; Modify `src/engine/workspace.ts`, `src/engine/stages/intake.ts`, `src/engine/stages/common.ts` (docs path `docs/devflow/<code>/`), `src/gitlab/git.ts` (`worktreeAdd/worktreeRemove/worktreeList`, `excludeLocal`); Test `tests/projects/service.test.ts`, `tests/engine/workspace-v3.test.ts`.

**Produces:** `resolveProjectPath(input, roots): string` (realpath, must be inside a root, rejects symlink escape/`..`); `createProject({mode:'existing'|'clone'|'new', key, name, path, gitlabProject?, createdBy})` (existing: must be git repo or empty → git init; clone via GitLab token like v2 intake; new: init + optional GitLab project), adds `.devflow/` to `.git/info/exclude`, calls `systemOps.ensureProjectGroup`; `setMembers(projectId, members[], by)` (PM must remain) → `systemOps.setMembers` (Task 4 interface; injected). `Workspace.for(cfg, req)`: legacy → v2 layout; else root `<project>/.devflow/requests/<code>`, `repoDir` = request worktree `.devflow/worktrees/<code>` (created on INTAKE via worktreeAdd from default branch; branch `devflow/<code>`), `devflowDir` = `<repoDir>/docs/devflow/<code>`; `taskWorktree(taskId)` helper. INTAKE for v3 requests no longer clones (project already has the repo) — fetch + worktree add.
- [ ] Tests: `project path must resolve under roots` (incl. symlink and `..`), `existing non-git non-empty folder rejected`, `create new project inits repo and exclude`, `two requests get separate worktrees and branches`, `intake creates worktree from default branch`, `legacy request keeps v2 paths`, `docs path per request code`.
- [ ] RED → implement → GREEN → commit.

### Task 4: dfctl, SystemOps, SeatRunner, seat login

**Files:** Create `ops/dfctl` (bash, root-owned on server), `scripts/install-server.sh`, `scripts/spike-claude-login.sh`, `src/system/ops.ts` (interface + `SudoSystemOps` + `NoopSystemOps`), `src/claude/seat-runner.ts`, `src/claude/seat-login.ts`; Modify `src/claude/runner.ts` (accept a command builder), `src/index.ts`; Test `tests/claude/seat-runner.test.ts`, `tests/claude/seat-login.test.ts`, `tests/system/dfctl.test.ts` (runs `bash ops/dfctl --self-test` argument-validation mode, skipped when bash unavailable).

**Produces:** `dfctl` subcommands (spec §6b.2): `provision-user <id>`, `ensure-project-group <projectId> <path>`, `set-members <projectId> <userIds…>`, `run-claude <userId> <cwd> -- <args…>` (validates cwd under a project dir whose group the user is in; runs `runuser -u dfu-<id> -- env -i HOME=… PATH=… CLAUDE_CONFIG_DIR=… <claude> args` with stdin passthrough), `claude-auth <userId> login|status|logout` (login wraps `script -qfec "<claude> auth login" /dev/null`), `--self-test` (pure validation tests). `install-server.sh`: creates `devflow` user, installs dfctl (root:root 0755), sudoers `devflow ALL=(root) NOPASSWD: /usr/local/lib/devflow/dfctl`, `/etc/claude-code/managed-settings.json` with `forceLoginMethod:"claudeai"`, `forceLoginOrgUUID:[$CLAUDE_TEAM_ORG_UUID]`, systemd unit running as `devflow`. `SeatRunner` interface `{ run(userId|null, opts: RunOpts): Promise<RunResult>; login(userId): LoginSession; status(userId): Promise<SeatStatus>; logout(userId) }`; `LocalSeatRunner` = v2 runClaude; `SudoSeatRunner` builds `sudo -n <dfctl> run-claude <id> <cwd> -- …` (prompt via stdin; env stripping as v2). Detect "Login expired"/"not logged in"/auth errors → `RunResult.seatError = 'expired'|'disconnected'`. `LoginSession` emits `url` (first https URL printed), `done(success)`, accepts `sendCode(code)`; 10-minute timeout; never logs stdin. `spike-claude-login.sh`: manual check script for the VPS (documented in README).
- [ ] Tests (fake dfctl script via `DFCTL_PATH` writing args to a file): `sudo runner builds dfctl command and passes prompt via stdin`, `seat error detection`, `login session extracts url and forwards code without logging`, `login timeout kills process`, `status parses connected/expired`, `server mode refuses to start without dfctl`, dfctl self-test cases (bad user id, cwd outside project, arg injection).
- [ ] RED → implement → GREEN → commit.

### Task 5: Engine — seats, approvals, worktrees, parallel tasks

**Files:** Modify `src/engine/pipeline.ts`, `src/engine/worker.ts`, `src/engine/changes.ts`, `src/engine/stages/{planning,develop,dev-review,test,bugfix,done,change}.ts`, `src/engine/stages/index.ts`; Create `src/engine/seats.ts`; Test `tests/engine/v3-seats.test.ts`, `tests/engine/v3-approvals.test.ts`, `tests/engine/v3-parallel.test.ts`.

**Produces:** `resolveSeat(req, stage, part?, taskId?): userId|null` per Global Constraints (local mode → null). StageContext gains `seatUserId`, `claudeAs(userId, prompt, extra)` (for review/two-part stages), `actor` (identity for commit author: name/email). Worker: per-seat concurrency (`SEAT_CONCURRENCY`), per-seat rate-limit pause (only jobs with that `seat_user_id`), `awaiting_seat` when seat not connected/expired (job parked, re-check every 10 min, `pipeline.seatReconnected(userId)` resumes). Approvals: `pipeline.approve(reqId, userId, part?)` checks `can(...)`; PLANNING requires both parts approved (approvals table); reject with part → rerun only that part (planning stage supports `ctx.part = 'tasks'|'testcases'`); DONE gate for PM in review mode; CHANGE decisions PM only. DEVELOP: tasks with satisfied deps and different assignees run in parallel jobs (one job per task, each in its own task worktree), review by REVIEWER seat, merge into `devflow/<code>` under a per-request lock; BUGFIX seat = assignee of the failing TC's feature task. Commits authored by `actor`. DONE copies deliverables to `docs/devflow/<code>/deliverables/` and commits. `removeMember` → cancel that user's running/queued jobs in that project before group change.
- [ ] Tests: `expired seat pauses then resumes`, `seat rate limit pauses only that seat`, `per-seat concurrency`, `parallel requests use separate worktrees`, `independent tasks of two devs run in parallel; merges serialized`, `review runs with reviewer seat`, `planning needs dev and tester approval; tester reject reruns test cases only`, `non-approver approve throws PermissionError`, `removing member cancels their running jobs`, `deliverables committed at DONE`, `commit author is responsible user`, v2 suite still green in local mode.
- [ ] RED → implement → GREEN → commit.

### Task 6: Web — projects, inbox, assignments, seat page, admin

**Files:** Create `src/web/routes/{projects,inbox,seat,admin-users}.ts`, `views/{projects,project,project-new,inbox,seat,admin-users}.eta`, partials for assignees/tasks assignment; Modify `src/web/routes/{requests,changes,questions,admin}.ts`, `views/{layout,request-detail,request-new,dashboard}.eta`, `views/partials/actions.eta`, `public/app.js`; Test `tests/web/v3-projects.test.ts`, `tests/web/v3-permissions.test.ts`, `tests/web/v3-seat.test.ts`.

**Produces:** Home = "Việc của tôi" (gates waiting for me, tasks assigned to me, CRs awaiting my PM decision, `awaiting_seat` of mine) + my projects. Project pages (create with mode existing/clone/new under PROJECT_ROOTS; members & roles editor for PM; requests list; new request form with PM-entered code + suggestion + assignee per role). Request page: "Phụ trách" block (PM edits), task assignee column (PM/DEV lead edits), approve/reject buttons only when `can`; PLANNING shows two part-approvals. "Claude của tôi": status, Kết nối (start login → show URL link → code input → result via SSE), Kiểm tra, Đăng xuất. Admin: users (sys roles, disable), PROJECT_ROOTS, GitLab, concurrency. All writes: permission check + audit_log.
- [ ] Tests: `role enforcement on every write route` (table of routes × roles), `project create rejects path outside roots`, `request code validation and uniqueness`, `inbox lists my pending gates`, `seat login flow posts code to session and never echoes it`, `admin pages admin-only`, `local mode works without login`.
- [ ] RED → implement → GREEN → commit.

### Task 7: E2E and deployment docs

**Files:** Create `tests/e2e/v3-multiuser.test.ts`, `docs/deploy-vps.md`; Modify `README.md`, `.env.example`, `tests/fixtures/*` (fake SeatRunner per user).

E2E (server mode with fake OIDC, NoopSystemOps, fake SeatRunner recording which user each Claude call ran as, fake GitLab, bare remote): PM creates project + members (BA, SE, 2 DEV, REVIEWER, TESTER) → creates two requests in parallel with custom codes → BA approves ANALYSIS, SE DESIGN, DEV+TESTER PLANNING, REVIEWER DEVELOP; assert each Claude call ran under the right user, tasks of two devs ran in parallel worktrees, wrong-role approve → 403, one seat expired mid-run → awaiting_seat → reconnect → done; deliverables committed under `docs/devflow/<code>/deliverables/`.
Docs: `docs/deploy-vps.md` (Vietnamese): VPS prerequisites, `install-server.sh`, Google OAuth client setup, Claude Team org UUID + managed settings, `spike-claude-login.sh` check, backups, migration from v2 (`npm run migrate:v3`), confirm terms with Anthropic; README section v3.
- [ ] Write → run → fix integration issues (regression test each) → full suite, tsc, build → commit.
