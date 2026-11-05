# Agile Change Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff (and customers, as proposals) submit change requests at any stage; analyse impact with Claude; re-enter the earliest affected stage and continue incrementally with versioned baselines and traceable cancelled items.

**Architecture:** New `change_requests` table + scope columns; Pipeline gains `submitChange/decideChange/acceptProposal/rejectProposal` that interrupt via the existing generation/abort mechanism and enqueue a new `CHANGE` stage; stages receive `ctx.changes`/`ctx.baseline` and prompts gain a shared "Thay đổi đã chấp nhận" section; office writers handle cancelled rows and versioned filenames; web adds CR form, Thay đổi/Phạm vi tabs and per-CR decisions.

**Tech Stack:** existing — Node 24, TS, Fastify/Eta/htmx, node:sqlite, zod, exceljs, jszip, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-agile-change-requests-design.md` (v1 spec `2026-11-04-devflow-design.md` still applies).

## Global Constraints

- All UI/prompt/report text Vietnamese. CR ids `CR-01`, `CR-02` … per request.
- CR statuses exactly: `proposed`, `pending`, `analyzing`, `awaiting_decision`, `accepted`, `rejected`, `applied`. Kinds: `add`, `modify`, `remove`, `nfr`, `other`. Source: `staff`, `customer`.
- No CR when request status is `cancelled` (HTTP 409 / UI hidden).
- Re-entry never earlier than `ANALYSIS`; never later than the stage the request was at (or `TEST` if it was `DONE`/done).
- CR with any `remove` or `effort_delta_mh > CR_AUTO_ACCEPT_MAX_MH` (default 40) waits for a human even in auto mode.
- Cancelled items are never deleted: `scope_status='cancelled'`, `changed_by_cr='CR-NN'`; xlsx comment "Hủy theo CR-NN"; excluded from effort sums and P/F/PE counts.
- Versioned artifacts: `TKCT_<REQ>_v<N>.docx`, `TKDB_<REQ>_v<N>.docx`, `ULNL_<REQ>_v<N>.xlsx`, `TestCase_<REQ>_v<N>.xlsx` where N = `baseline_version`; previous versions kept. (v1 names without suffix are treated as v1.)
- Clarify rounds max 5 per baseline (reset when baseline increments). Accepted CR resets `review_rounds` of tasks it sends back to `todo` and `fix_attempts` of bugs on test cases it modifies.
- Any merge into `devflow/<REQ>` (task or fix) after a TC's last P triggers regression.
- Accept/reject DB writes in one transaction. Commit messages end with the two attribution lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01N8xgo4VcKqDzy4eDXiK2WC`.

## Review Focus

1. CR submitted while a stage is mid-run → that run's outcome discarded, CHANGE runs exactly once (Task 2 test `submitChange interrupts running stage`).
2. Two CRs submitted back-to-back (second while CHANGE runs) → both analysed, neither lost (Task 2 test `cr during CHANGE is analysed before gate`).
3. All CRs rejected → request returns to its exact previous status/stage, incl. `awaiting_customer` and `done` (Task 2 test `reject restores previous state`).
4. CR on a `done` request → iteration+1, re-enters, ends DONE again with the same final MR (Task 6 e2e).
5. Customer survey proposal text with HTML/script → stored as text, escaped in UI, no auto-processing (Task 5 test `customer proposal escaped and not auto-run`).

---

### Task 1: Data model, types, repo

**Files:** Modify `src/db/db.ts`, `src/db/repo.ts`, `src/domain/types.ts`, `src/config.ts`, `.env.example`; Test `tests/db/change-requests.test.ts`.

**Interfaces — Produces:**
- `STAGES` gains `'CHANGE'` (insert after `'DONE'`; `nextStage` must never return it — add assertion test in pipeline tests in Task 2).
- `CrKind`, `CrSource`, `CrStatus` types; `ChangeRequestRow {id, requestId, title, description, kind, source, status, createdBy, createdAt, decidedBy, decidedAt, decisionNote, baselineFrom, baselineTo, reenterStage, interruptedStage, interruptedStatus, impactSummary}`.
- `ImpactOut` zod: `{cr_id, summary, scope:{add:[{name,description}], modify:[{feature_id,change}], remove:[string]}, affected:{features:[string],tasks:[string],test_cases:[string]}, questions: Question[] (default []), effort_delta_mh:number, risks:[string] (default []), reenter: enum ANALYSIS|BREAKDOWN|DESIGN|PLANNING|DEVELOP|TEST}`.
- Feature/Task/TestCase zod output schemas gain optional `scope_status: 'active'|'cancelled'` (default 'active'); rows gain `scopeStatus`, `changedByCr`; TestCaseRow gains `baseline: number|null`.
- RequestRow gains `baselineVersion`, `iteration`.
- Repo: `nextCrId(reqId)`, `createChangeRequest(reqId, {title, description, kind, source, createdBy?, status})`, `getChangeRequest(reqId, crId)`, `listChangeRequests(reqId)`, `updateChangeRequest(reqId, crId, patch)`, `addCrAttachment(reqId, crId, filename, path)`, `listCrAttachments(reqId, crId)`, `setScope(kind:'feature'|'task'|'test_case', reqId, id, scopeStatus, crId)`.
- Config `crAutoAcceptMaxMh` from `CR_AUTO_ACCEPT_MAX_MH` default 40.

- [ ] Tests: `nextCrId CR-01 then CR-02 per request`, `migration adds columns to an existing v1 database` (create v1 schema DB file first by running openDb on a DB created with v1 table DDL lacking new columns — copy the DDL subset in the test), `cancelled scope persists with changed_by_cr`, `ImpactOut rejects unknown reenter`, `config default crAutoAcceptMaxMh 40`.
- [ ] FAIL → implement (idempotent `alter table add column` guarded by `pragma table_info`) → PASS (`npx vitest run`, `npx tsc --noEmit`) → commit.

### Task 2: Pipeline change control

**Files:** Modify `src/engine/pipeline.ts`; Create `src/engine/changes.ts`; Test `tests/engine/changes-pipeline.test.ts`.

**Interfaces:**
- `Pipeline.submitChange(reqId, input: {title, description, kind, createdBy?}): ChangeRequestRow` — throws `CrNotAllowedError` when cancelled. Records `interruptedStage/interruptedStatus` (the request's stage+status before CHANGE) on the CR, bumps generation, aborts controller, fails queued/paused jobs, sets stage CHANGE/running, enqueues CHANGE. If stage is already CHANGE (running or awaiting_approval) only stores CR `pending` (and if awaiting_approval: re-enqueue CHANGE so it is analysed before decisions).
- `Pipeline.proposeChange(reqId, input)` → CR `proposed`, no pipeline effect. `acceptProposal(reqId, crId)` → status `pending` then same effect as submitChange. `rejectProposal(reqId, crId, note)`.
- `Pipeline.decideChange(reqId, crId, decision: 'accept'|'reject', note?, decidedBy?)` — only for CRs in `awaiting_decision`; when no CR remains `awaiting_decision` calls `finishChangeDecision`.
- `changes.ts`: `applyAcceptedChange(repo, req, cr, impact): void` (scope updates per spec §4.3 incl. counter resets, bug closing note "Đóng do CR-NN" stored on bug row; GitLab issue closing happens lazily in TEST reconcile) ; `computeReentry(acceptedImpacts, hasNewMust, prevStage): Stage` (spec §4.3 rules); `restorePrevious(...)` for all-rejected.
- CHANGE stage gate: CHANGE handler (Task 3) returns `{kind:'next'}`; pipeline treats CHANGE specially: after it, if any CR requires human (remove or effort > threshold) or run_mode review → status `awaiting_approval` with CRs `awaiting_decision`; else auto-accept all and continue. `approve()`/`reject()` on stage CHANGE throw (UI uses decideChange).
- StageContext gains `changes: {cr: ChangeRequestRow; impact: ImpactOut}[]` (accepted, not applied) and `baseline: number`. Impacts loaded from `docs/devflow/changes/<CR>/impact.json`.
- DONE stage completion: mark accepted CRs `applied` (do it in pipeline when DONE outcome is next — or in done.ts; choose pipeline to keep stages simple).

- [ ] Tests (fake stage handlers incl. fake CHANGE writing impact.json): `submitChange interrupts running stage` (handler awaits signal; outcome discarded; CHANGE runs once), `cr during CHANGE is analysed before gate`, `auto mode small CR auto-accepts and re-enters computed stage`, `remove CR waits for decision even in auto`, `effort above threshold waits`, `reject restores previous state` (cases: running DEVELOP → DEVELOP re-enqueued; awaiting_customer → awaiting_customer; done → done), `accept on done increments iteration and baseline`, `nextStage never returns CHANGE`, `cancelled request rejects submitChange`, `proposal does nothing until accepted`.
- [ ] FAIL → implement → PASS → commit.

### Task 3: CHANGE stage and change-analyst prompt

**Files:** Create `prompts/change-analyst.md`, `src/engine/stages/change.ts`; Modify `src/engine/stages/index.ts`, `src/engine/stages/common.ts` (paths helper `changeDir(ws, crId)`); Test `tests/engine/stage-change.test.ts`.

Behaviour: collect CRs `pending` → set `analyzing`; copy CR attachments to `inputs/changes/<CR>/`; one Claude call (role `change-analyst`) writing per-CR `docs/devflow/changes/<CR>/impact.md` + `impact.json`; validate with `ImpactOut` + referential checks (feature/task/TC ids exist; question ids not colliding with answered ones) via `runClaudeStep` (≤2 retries); store `impact_summary`, `reenter_stage`; upsert new questions into round `clarify_round+1` (mark with CR id in `why` prefix "[CR-NN] "); commit `docs/devflow/changes` via commitPaths; return next. Prompt: Vietnamese; explains current stage & artifacts; rules: never invent customer answers (unknowns → questions), prefer modify over remove+add, list every affected task/TC, estimate effort delta in MH using ULNL type list (inject like BREAKDOWN), pick `reenter` as earliest artifact that must change.

- [ ] Tests: `writes impact files and stores summary`, `invalid feature reference retried then fails`, `new questions upserted with CR prefix`, `attachments copied`, `prompt contains current stage and all pending CRs`.
- [ ] FAIL → implement → PASS → commit.

### Task 4: Incremental stages, versioned artifacts, cancelled rows

**Files:** Modify `prompts/{analyst,analyst-breakdown,architect,planner,developer,tester}.md`, `src/engine/prompt.ts` (shared changes section), `src/engine/stages/{analysis,breakdown,design,planning,develop,test,done}.ts`, `src/engine/stages/common.ts` (versioned name helpers), `src/office/{ulnl-xlsx,testcase-xlsx}.ts`, `src/office/docx.ts` or design.ts (change-history table appended from DB); Test `tests/engine/stages-incremental.test.ts`, extend `tests/office/*`.

Interfaces: `artifactName(kind:'TKCT'|'TKDB'|'ULNL'|'TestCase', reqId, baseline): string` (`<KIND>_<REQ>_v<N>.<ext>`); `latestArtifact(ws, kind, reqId): string|undefined` (handles v1 unsuffixed); `changesSection(ctx): string` appended by buildPrompt when `ctx.changes.length` ("## Thay đổi đã chấp nhận" listing CR id, title, kind, impact summary, scope delta, path to impact.md, and the rules from spec §4.4). `UlnlFeature`/`TcSheetRow` gain `cancelledBy?: string`. `changeHistoryMarkdown(repo, reqId): string` → table (Phiên bản | CR | Ngày | Nội dung | Người duyệt) appended under heading "Lịch sử thay đổi" (H2 under PHỤ LỤC) before rendering TKCT.

Rules: stages persist `scope_status` from Claude outputs; after a CR, PLANNING keeps done tasks `done` unless in `affected.tasks`; DEVELOP processes only `active` + not done; TEST targets `active` TCs lacking P at current baseline (`test_cases.baseline` < current or no P) + regression rule broadened (DEVELOP merges also bump the fix/merge sequence); DONE guard adds "no active TC without result"; report.md "Các thay đổi trong vòng này"; final MR description updated via `addMRNote` if MR exists (no new MR).

- [ ] Tests: `artifactName/latestArtifact incl. v1 name`, `prompt includes changes section only when changes exist`, `breakdown keeps ids and marks cancelled; ULNL v2 excludes cancelled effort with note`, `testcase xlsx cancelled row excluded from counts`, `TKCT v2 has change history table from DB`, `planning keeps done tasks not affected`, `develop skips cancelled tasks`, `test re-runs TCs modified by CR and regression after any merge`, `done guard fails when active TC has no result`.
- [ ] FAIL → implement → PASS → commit.

### Task 5: Web UI for change requests

**Files:** Create `src/web/routes/changes.ts`, `views/partials/changes.eta`, `views/partials/scope.eta`, `views/partials/change-form.eta`; Modify `views/request-detail.eta`, `views/partials/actions.eta`, `views/partials/docs.eta`, `views/dashboard.eta`, `views/survey.eta`, `src/web/routes/survey.ts`, `src/web/routes/requests.ts` (tab list), `public/app.css`; Test `tests/web/changes.test.ts`.

Routes: `POST /requests/:id/changes` (multipart: title, description, kind, files[] ≤50MB each → inputs/changes/<CR>/ via existing cleanName/safe save) → submitChange; `POST /requests/:id/changes/:cr/decide` (decision, note) → decideChange; `POST /requests/:id/changes/:cr/accept-proposal`, `/reject-proposal`; `GET /requests/:id/changes/:cr/impact` renders impact.md escaped. Tabs "Thay đổi" and "Phạm vi" (features with scope status, changed_by_cr, buttons "Đề xuất bỏ khỏi phạm vi"/"Đề xuất sửa" → `?tab=changes&prefill=remove:F-03`). Progress bar label for CHANGE "Thay đổi"; header "Phiên bản yêu cầu vN · Vòng lặp M". Docs tab groups artifacts by version (newest first). Dashboard column "Phiên bản" + pending CR count. Survey: optional textarea `proposal` "Đề xuất thay đổi hoặc bổ sung khác"; on submit or save with non-empty text → proposeChange(source customer, title "Đề xuất của khách hàng"). PipelineBusy/CrNotAllowed → flash error.

- [ ] Tests: `cr form visible for all statuses except cancelled`, `post change creates CR and calls submitChange with attachments`, `decide endpoint per CR`, `impact page escapes html`, `scope tab lists cancelled features`, `customer proposal escaped and not auto-run`, `server mode requires auth and Origin for CR routes`.
- [ ] FAIL → implement → PASS → commit.

### Task 6: End-to-end and docs

**Files:** Modify `tests/fixtures/mock-claude.ts` (role `change-analyst`), Create `tests/e2e/change-requests.test.ts`; Modify `README.md`, `.env.example`, v1 spec §4 note pointing to v2 spec.

E2E (inject, mock Claude, fake GitLab, bare remote): (a) auto mode request reaches DEVELOP; submit CR "add" small → CHANGE auto-accepts → re-enters BREAKDOWN → new feature F-0N, new task + TC, previously done tasks not redone (assert developer prompts count) → DONE with v2 artifacts and v1 kept; (b) CR "remove" on done request → waits for decision → accept → iteration 2, cancelled feature/tasks/TCs, removal task developed, DONE, same final MR (one MR created total); (c) reject path restores done.
README: new section "Điều chỉnh yêu cầu (Agile)" explaining CR flow, statuses, auto-accept threshold, versioned documents, customer proposals.

- [ ] Write e2e → run → fix integration issues (each with regression test) → PASS full suite, tsc, build → commit.
