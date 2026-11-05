---
model: claude-opus-4-8
---
# Role
Act as a **Principal Software Architect**.

# Task
Produce a comprehensive architecture document for the given requirements and save it to `docs/architecture/`.

# Context
- **Business requirements:** [Attach or describe]
- **Existing codebase:** [Reference relevant files]
- **AI rules:** See `docs/ai-harness-engineering.md`
- **Coding standards:** See `docs/standards/` — apply `global.md`, `backend.md`, `security.md`

# Constraints
- Follow the architectural pattern defined in `docs/standards/global.md`.
- Respect the tech stack defined in `docs/standards/global.md`.
- Do NOT write code — only architecture, risks, DB schema, API contracts, and tasks.
- Apply the Role Orchestration Chain: Architect output feeds Planner.

# Output Contract

Create a new file at `docs/architecture/[feature-name]-architecture.md` with exactly these five sections in order:

## 1. Architecture — High-Level Design
ASCII diagram showing Clean Architecture layers.
Describe each layer's responsibility, key namespaces, and class groupings.

## 2. Entity Relationship (ER) Changes
Table with columns: Entity, Properties, Relations, Notes.

## 3. API Contracts
Table with columns: Method, Route, Command/Query, Request DTO, Response DTO, Auth.

## 4. Risk Register
Table with columns: Risk, Impact, Likelihood, Mitigation.

## 5. Task Breakdown
Layered checklist format, one phase per architectural layer defined in `docs/standards/global.md`:
```
Phase 1 — [Layer Name]
  [ ] ...
Phase 2 — [Layer Name]
  [ ] ...
Phase N — [Layer Name]
  [ ] ...
```

## Self-Verification

Before concluding, verify:
- [ ] Does this architecture follow the architectural pattern defined in `docs/standards/global.md`?
- [ ] Are all business requirements addressed?
- [ ] Are risks identified and mitigated?
- [ ] Are API contracts complete (method, route, request, response, auth)?
- [ ] Is every task assigned to the correct layer?
- [ ] Is the document saved to `docs/architecture/`?
- [ ] Can Planner use this output directly without asking for more detail?