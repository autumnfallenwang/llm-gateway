---
name: update-progress
description: Update the progress doc after finishing work
---

Update `docs/progress.md` to reflect the current state of the project.

## Steps

1. Read `docs/progress.md` and `docs/dev-plan.md` to understand the task list and current status.
2. Scan the codebase to determine what actually exists and works:
   - Check which source files exist under `src/` (services, lib, routes, schemas, app, index)
   - Run `npx vitest run` to get the current test count and pass/fail status
   - Run `npx biome check src/ tests/` to get the current lint error/warning count
3. Compare what exists against the dev-plan task list. For each task, determine:
   - **Done**: all files exist, tests pass, functionality is wired up
   - **Partial**: some files exist or placeholder handlers still in place
   - **Not started**: files don't exist yet
4. Rewrite `docs/progress.md` with:
   - Accurate task status table
   - "What's Working" section reflecting actual state
   - "What's Next" section describing the next task(s) in the dependency chain
   - Correct test count (e.g. "27/27 passing")

If $ARGUMENTS is provided, treat it as additional context about what was just completed (e.g. "finished task 4 model registry").

Do NOT change any source code. Only update `docs/progress.md`.
