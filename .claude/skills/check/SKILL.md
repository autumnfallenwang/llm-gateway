---
name: check
description: Run lint + test + type-check in sequence
---

Run all three checks and report results:

1. `npx biome check src/ tests/`
2. `npx tsc --noEmit`
3. `npm run test:fast` (unit tests only — excludes slow e2e/compatibility)

Stop on first failure. Report pass/fail for each step.
