---
name: dev-task
description: Plan and implement the next development task
---

Pick up the next task from the development plan and implement it.

## Phase 1: Understand current state

1. Read `docs/progress.md` to see what's done, what's partial, what's next, and the full task plan.
2. Identify the next task to work on — follow the dependency chain (earlier tasks must be done before later ones).
3. If $ARGUMENTS is provided, treat it as the specific task to work on (e.g. "task 5" or "completion service") instead of auto-detecting.

## Phase 2: Explore and plan

4. Read all source files relevant to the next task:
   - Files the task will create or modify
   - Files the task depends on (imports, types, existing patterns)
   - Existing test files to understand testing conventions
5. If the task involves external libraries (pi-ai, Hono, Zod), check type definitions in `node_modules/` to understand exact APIs.
6. Check the reference docs in `docs/` for any relevant specs (OpenAI API format, Ollama compat, error format).
7. Enter plan mode and write a detailed implementation plan that includes:
   - Files to create/modify (with exact paths)
   - Types and interfaces to define
   - Functions to implement (with signatures and key logic)
   - Tests to write (with test names and what they verify)
   - Changes to existing files (imports, wiring)
   - Verification steps (lint, test, manual check)

## Phase 3: Implement (after plan approval)

8. Create/modify files according to the approved plan.
9. Run `npx biome check --write` on new files to fix formatting.
10. Run `npm test` to verify all tests pass (full suite including e2e).
11. Run `npx biome check src/ tests/` to verify 0 lint errors.
12. Update `docs/progress.md` with the new task status.
