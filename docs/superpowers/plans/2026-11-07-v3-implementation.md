# DevFlow v3 Implementation Plan (revised)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shared-VPS DevFlow for two departments (DEV, SGLOBAL): Google SSO with company email, system roles (admin, cto, head, deputy, member + `can_be_pm`), projects as folders, project roles (PM/BA/SE/DEV/REVIEWER/TESTER, many people per role), every Claude run on the responsible person's own Claude seat, parallel requests and tasks on separate git worktrees, read-only oversight for CTO/head/deputy.

**Architecture:** Keep the v2 engine and the `Repo`/`WebRepo` split already on this branch. Add a user/department/permission layer, a project layer, a `SeatRunner` abstraction (local = v2 behaviour; sudo = `dfctl`), stage→role→seat resolution with `awaiting_seat`, a `Workspace` rooted in the project folder with worktrees per request and task, and a read-only oversight area.

**Tech Stack:** existing (Node 24, TypeScript, Fastify, Eta, htmx, `node:sqlite`, zod, vitest) + `openid-client`. No native modules. **Run everything with Node 24:** `export PATH=$HOME/.nvm/versions/node/v24.22.0/bin:$PATH`.

**Specs:** `docs/superpowers/specs/2026-11-06-v3-multiuser-projects-design.md` (base) and `docs/superpowers/specs/2026-11-07-v3-roles-and-lah-delta-design.md` (delta; wins on any conflict). Earlier plan `docs/superpowers/plans/2026-11-06-v3-multiuser.md` holds detailed Produces text for dfctl/SeatRunner/engine; tasks below say where to reuse it.

## Global Constraints

- Project roles exactly: `PM`, `BA`, `SE`, `DEV`, `REVIEWER`, `TESTER` (code `SE`, never `SA`). System roles: `admin`, `cto`, `head`, `deputy`, `member`; independent flag `can_be_pm`. Departments: `DEV` and `SGLOBAL` only (table `departments`).
- Stage → seat role → approver: CODEBASE_SCAN SE/SE; ANALYSIS BA/BA; CLARIFY –/BA; BREAKDOWN BA/BA; DESIGN SE/SE; **PLANNING DEV(tasks)+TESTER(test cases) run, approver PM only**; DEVELOP task assignee (fallback first DEV), review seat REVIEWER, approver REVIEWER; TEST TESTER/–; BUGFIX assignee of failing feature's task (fallback first DEV), review seat REVIEWER; CHANGE BA/PM decides; DONE –/PM. PM may approve any gate. With several people in a role: one approval from any of them suffices, one rejection from any returns the step; the first by `position` is the runner.
- Changing the runner mid-run stops the current attempt (not counted as failure or retry) and re-runs the same stage from its last checkpoint with the new person's seat. Removing a member from a project does the same for their jobs there.
- `admin` has no project rights unless a member, but has oversight read access (below). `head`/`deputy` belong to exactly one department; `cto` and `admin` to none and see both departments. A project belongs to exactly one department (its creator PM's); members come only from that department. `head`/`deputy` set/clear `can_be_pm` only for users of their own department and cannot change `sys_role` (only `admin` can). Users without a department cannot be added to projects.
- Oversight (read-only) for `cto`, `head`/`deputy` (own department), `admin`: users (never credentials), projects, progress, blockers, per-person work status, and project content (docs, source, logs). No write endpoint reachable. Content viewing: server-side reads under the project folder only (realpath, no `..`/symlink escape); contents of `.env*`, `*.pem`, `*.key`, `.claude/`, `.git/config` not shown; every content view writes `audit_log(user, project, path)`.
- Blockers = `awaiting_seat`, rejected-awaiting-fix, awaiting customer answers, CR awaiting PM, failed, bug at fix cap. No overdue concept.
- Config: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL` (callback `/auth/google/callback`), `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`, `CTO_EMAILS`, `HEAD_EMAILS`, `DEPUTY_EMAILS` (the last two as `DEV:a@x,b@x;SGLOBAL:c@x`), `PROJECT_ROOTS`, `SEAT_CONCURRENCY` (default 1), `MAX_CONCURRENT_JOBS` (default 4 in server mode), `DFCTL_PATH`, `BREAKGLASS_ADMIN`. Seeded accounts get their role/department at first Google login. Others become `member` without department.
- VPS has no v2 data: no `migrate:v3`; the v3 schema is the starting schema (keep `db.ts` idempotent for dev databases).
- Request code: PM-entered, unique per project, `^[A-Za-z0-9._-]{1,40}$`, not colliding with an existing branch `devflow/<code>`; suggestion `<KEY>-NNN`.
- Project layout: `.devflow/` in `.git/info/exclude`; request workspace `.devflow/requests/<code>/{inputs,artifacts,evidence,logs}`; request worktree `.devflow/worktrees/<code>` on `devflow/<code>`; task worktree `.devflow/worktrees/<code>-<TASK>` on `devflow/<code>-<TASK>`; markdown docs under `docs/devflow/<code>/`; DONE copies Office deliverables and evidence to `docs/devflow/<code>/deliverables/`. DevFlow never deletes project folders, never changes the default branch.
- Server mode is Linux only and refuses to start without dfctl. DevFlow never reads, stores or logs Claude credentials. Local mode keeps v2 behaviour (single implicit user with all rights).
- All permission checks server-side; every write recorded in `audit_log`. UI text Vietnamese.
- Gate for every task: `npx tsc --noEmit`, the task's tests, and before the final commit `npx vitest run --maxWorkers=2 --testTimeout=60000` must show no new failures (baseline timeouts under load are known; re-run a failing file alone with `--maxWorkers=1` before calling it a regression).
- Git: work on a branch `task/TASK-NNN` off `feat/v3-multiuser`; commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; **no push, no PR** (pushes are blocked by the project owner's setup); merge into `feat/v3-multiuser` with `git merge --ff-only` after the gate passes.

## Review Focus

1. `head` of DEV reads or edits a SGLOBAL user/project, or `cto`/oversight role performs any write (Task 7 and Task 2 tests `cross-department denied`, `oversight routes are GET only`).
2. Secret files and path escape through the content viewer (Task 7 tests `secret files hidden`, `symlink and .. rejected`).
3. Runner swapped while a stage runs → rerun with new seat, no failure counted (Task 5 test `runner change restarts stage on new seat`).
4. Member removed from a project while their job runs → cancelled/reassigned, group removed after (Task 5).
5. Seat login expired mid-stage → `awaiting_seat`, resumes after reconnect (Task 5).
6. Two requests or two Devs' tasks write the same file → separate worktrees, merges serialized (Task 5).
7. Non-member/wrong-role/other-department POST to approve, assign, create project → 403 and no state change (Task 6 table test).

---

### Task 1: Data model v3

**Files:** Modify `src/db/db.ts`, `src/db/repo.ts`, `src/db/web-repo.ts`, `src/domain/types.ts`, `src/config.ts`, `.env.example`; Test `tests/db/v3-model.test.ts`, `tests/config.test.ts`.

**Produces:** types `SysRole = 'admin'|'cto'|'head'|'deputy'|'member'`, `ProjectRole = 'PM'|'BA'|'SE'|'DEV'|'REVIEWER'|'TESTER'`, `DepartmentCode = 'DEV'|'SGLOBAL'`; `UserRow` gains `email, googleSub, displayName, sysRole, departmentId|null, canBePm, osUser|null, disabled` (replace `role`/password use except for break-glass). Tables: `departments(id,code unique,name)` seeded DEV, SGLOBAL; `projects(id,key unique,name,path unique,department_id,gitlab_project,default_branch,created_by,created_at,archived)`; `project_members(project_id,user_id,roles JSON,added_by,added_at, pk(project_id,user_id))`; `requests` += `project_id, code` unique (project_id,code); `request_assignees(request_id,role,user_id,position, pk(request_id,role,user_id))`; `tasks.assignee_id`; `approvals(request_id,stage,part,user_id,decision,at)`; `audit_log(id,project_id|null,request_id|null,user_id,action,detail,at)`; seat columns on `jobs` (`seat_user_id`) and request status `awaiting_seat`. Repo/WebRepo methods for each (exact names chosen by implementer, listed in the task report). Config parses the env vars in Global Constraints; `parseDeptEmails('DEV:a@x,b@x;SGLOBAL:c@x') → Record<DepartmentCode,string[]>` (unknown department code throws). Server mode config requires Google settings.
- [ ] Tests: `schema is idempotent on an existing dev db`, `departments seeded`, `request code unique per project`, `suggestRequestCode ERP-001 then ERP-002`, `request_assignees allows several users per role ordered by position`, `parseDeptEmails valid and unknown department`, `config parses all new env vars`, `server mode requires google settings`.
- [ ] RED → implement → GREEN (`npx vitest run tests/db tests/config.test.ts`, `npx tsc --noEmit`) → commit.

### Task 2: Permissions module and Google SSO

**Files:** Create `src/security/permissions.ts`, `src/web/oidc.ts`, `scripts/admin-set-password.ts`; Modify `src/web/auth.ts`, `src/web/routes/*` login route, `views/login.eta`, `package.json` (`openid-client`, script `admin:set-password`); Test `tests/security/permissions.test.ts`, `tests/web/sso.test.ts`.

**Produces:** `can(actor: Actor, action: Action, ctx: Ctx): boolean` pure function, `Actor = {userId, sysRole, departmentId|null, canBePm, projectRoles: ProjectRole[] (for ctx.project)}`; actions include `project.create`, `project.members.edit`, `request.create`, `gate.approve(stage[,part])`, `task.assign`, `cr.decide`, `user.setCanBePm`, `user.setSysRole`, `user.setDepartment`, `oversight.view`, `oversight.content`, `admin.settings`. Rules exactly as Global Constraints. Routes: `GET /auth/google` (PKCE+state+nonce in short-lived signed cookie), `GET /auth/google/callback` (validate with `openid-client`, injectable issuer for tests; require `email_verified` and domain in `ALLOWED_EMAIL_DOMAINS`; upsert user; apply seeding from `ADMIN_EMAILS/CTO_EMAILS/HEAD_EMAILS/DEPUTY_EMAILS` on first login; call injected `systemOps.provisionUser(userId)` — no-op in tests; set v1-format session cookie). `/login/local` only when `BREAKGLASS_ADMIN` set. Local mode unchanged.
- [ ] Tests: `rejects other domain`, `rejects unverified email`, `seeds admin cto head deputy with department at first login`, `unknown email becomes member without department`, `state mismatch rejected`, `breakglass hidden unless configured`; permissions table: `head cannot act on other department`, `head cannot set sysRole`, `cto read-only`, `admin has no project rights without membership`, `PLANNING approvable by PM only`, `REVIEWER approves DEVELOP`, `DEV cannot approve DESIGN`, `any assignee of a role may approve its gate`, `user without department cannot be added to a project`.
- [ ] RED → implement → GREEN → commit.

### Task 3: Projects, members, project-rooted workspaces

**Files:** Create `src/projects/service.ts`, `src/projects/paths.ts`; Modify `src/engine/workspace.ts`, `src/engine/stages/intake.ts`, `src/engine/stages/common.ts`, `src/gitlab/git.ts` (`worktreeAdd/worktreeRemove/worktreeList`, `excludeLocal`); Test `tests/projects/service.test.ts`, `tests/engine/workspace-v3.test.ts`.

**Produces:** `resolveProjectPath(input, roots): string`; `createProject({mode:'existing'|'clone'|'new', key, name, path, gitlabProject?, createdBy})` — department = creator's, creator becomes PM, `.devflow/` added to exclude, calls injected `systemOps.ensureProjectGroup`; `setMembers(projectId, members: {userId, roles: ProjectRole[]}[], by)` (PM must remain; every user must be in the project's department else `PermissionError`; calls `systemOps.setMembers`); `setAssignees(requestId, role, userIds[] ordered)`; request creation rule from Global Constraints (every role used by the pipeline has at least one member). Reuse the detailed layout and intake behaviour from the earlier plan's Task 3.
- [ ] Tests: `project path must resolve under roots` (symlink and `..`), `existing non-git non-empty folder rejected`, `create new project inits repo and exclude`, `member from another department rejected`, `PM cannot be removed as last PM`, `two requests get separate worktrees and branches`, `intake creates worktree from default branch`, `docs path per request code`, `request blocked when a needed role has no member`.
- [ ] RED → implement → GREEN → commit.

### Task 4: dfctl, SystemOps, SeatRunner, seat login (spike first)

**Files, Produces, Tests:** exactly the earlier plan's Task 4 (`docs/superpowers/plans/2026-11-06-v3-multiuser.md`, section "Task 4") — read it and implement it unchanged, except: the first step is `scripts/spike-claude-login.sh` (manual VPS check; cannot be run in this environment and is flagged to the owner), and `SeatRunner.run` must support being aborted by an `AbortSignal` (needed by Task 5 for runner change/member removal).
- [ ] Follow the earlier Task 4 steps; add test `run aborts when signal fires and reports aborted, not failed`.
- [ ] RED → implement → GREEN → commit.

### Task 5: Engine — seats, approvals, worktrees, parallel tasks

**Files, Produces, Tests:** the earlier plan's Task 5 with these changes: PLANNING has **PM-only approval** (still two Claude runs: DEV tasks, TESTER test cases; reject with part reruns that part); gates accept an approval from **any** assignee of the role (`approvals` table, rejection by any returns the step); `pipeline.setRunner(requestId, role, userId)` reorders `position` and, if a job of that role is running, aborts it via `AbortSignal` and re-enqueues the same stage attempt on the new seat without counting a retry; `removeMember` does the same for that user's jobs in that project. Read the earlier Task 5 for seat resolution, `awaiting_seat`, per-seat concurrency/rate limit, parallel task worktrees, serialized merges, deliverables at DONE, commit author.
- [ ] Tests: all earlier Task 5 tests except the two-part PLANNING approval ones, plus `planning approved by PM only`, `any dev assignee approves develop gate and one reject returns the step`, `runner change restarts stage on new seat without retry count`, `removing member reassigns their running jobs`, `v2 suite green in local mode`.
- [ ] RED → implement → GREEN → commit.

### Task 6: Web — projects, inbox, assignments, seat page, admin

**Files, Produces, Tests:** the earlier plan's Task 6, adjusted: system-role and department management lives on the admin users page (`admin` edits everything; `head`/`deputy` get a "PM của phòng" page listing own-department users with a `can_be_pm` toggle and a button to assign unassigned users to their department); project member editor allows several people per role and shows only same-department users; request page "Phụ trách" lists many people per role with drag/arrow ordering by `position`; approve/reject buttons shown only when `can(...)`; PLANNING shows PM approval only. Every write route goes through `can(...)` and writes `audit_log`.
- [ ] Tests: earlier Task 6 tests plus `role enforcement on every write route` (table: route × actor kinds incl. head of other department, cto, admin non-member, wrong project role), `head toggles can_be_pm only in own department`, `head cannot change sysRole`, `unassigned user shown to head and assigned to head's department`, `project member picker only offers same department`.
- [ ] RED → implement → GREEN → commit.

### Task 7: Oversight area (CTO, head, deputy, admin)

**Files:** Create `src/web/routes/oversight.ts`, `src/oversight/{summary,content}.ts`, `views/oversight-{users,projects,project,content}.eta`; Modify `views/layout.eta` (menu entry for allowed roles); Test `tests/web/oversight.test.ts`, `tests/oversight/content.test.ts`.

**Interfaces:** Consumes `can(...)` from Task 2, projects/requests/tasks/jobs tables from Task 1.
**Produces:** GET-only routes under `/oversight`: users list (email, sysRole, department, `can_be_pm`, seat connected yes/no; never credentials), projects list (name, department, PM, members by role), project progress (requests with current stage/status, task done ratio), blockers list (definition in Global Constraints), per-person work status (tasks assigned, running/waiting approval), and content: `GET /oversight/projects/:id/files?ref=<branch>&path=` (tree and file content of default branch or `devflow/<REQ>` read through git, no checkout needed), `/docs` (request markdown and exported Office files), `/logs` (job and request logs). `listForActor(actor)` scopes to both departments for `cto`/`admin`, own department for `head`/`deputy`. `readProjectFile(project, ref, path)`: realpath/inside-project check, refuses the secret patterns in Global Constraints, size cap 1 MB, binary files not rendered; logs `audit_log` on every content call.
- [ ] Tests: `head sees only own department projects and users`, `cto sees both departments`, `cross-department project url returns 404 for head`, `oversight routes are GET only (POST/PUT/DELETE → 405 or 404)`, `member and non-oversight roles get 403`, `secret files hidden (.env, *.pem, *.key, .claude/, .git/config)`, `symlink and .. rejected`, `content view writes audit_log`, `blockers list contains awaiting_seat, failed, CR awaiting PM and bug at cap`, `seat status shown without credentials`.
- [ ] RED → implement → GREEN → commit.

### Task 8: E2E, deployment docs, release

**Files:** Create `tests/e2e/v3-multiuser.test.ts`, `docs/deploy-vps.md`; Modify `README.md`, `.env.example`, `docs/HANDOFF.md`, `tests/fixtures/*` (fake SeatRunner per user).

E2E (server mode, fake OIDC, NoopSystemOps, fake SeatRunner recording which user ran each Claude call, fake GitLab, bare remote): seeded head of DEV marks a user `can_be_pm` → that PM creates a project and members (BA, SE, two DEV, REVIEWER, TESTER, with two BAs) → two requests in parallel with custom codes → approvals per Global Constraints (PLANNING by PM) → assert each Claude call ran under the right user, two Devs' tasks ran in parallel worktrees, runner changed mid-run continues on new seat, wrong-role and other-department approve → 403, expired seat → `awaiting_seat` → reconnect → done, CTO oversight shows progress and file content, deliverables committed under `docs/devflow/<code>/deliverables/`. Docs (Vietnamese): VPS prerequisites, `install-server.sh`, Google OAuth client, Claude Team org UUID and managed settings, seeding accounts on day one, spike check, backups, confirm terms with Anthropic; README v3 section; update HANDOFF.
- [ ] Write → run → fix integration issues (regression test each) → full suite, `npx tsc --noEmit`, `npm run build` → commit.
