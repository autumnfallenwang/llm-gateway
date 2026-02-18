---
name: test
description: Run Vitest test suite
---

Run tests. Show failures clearly with file and line numbers.

- No arguments: run fast tests only (`npm run test:fast` — excludes e2e/compatibility)
- `--all` or `all`: run full suite including e2e/compatibility (`npm test`)
- Any other arguments: pass through to vitest (`npx vitest run $ARGUMENTS`)
