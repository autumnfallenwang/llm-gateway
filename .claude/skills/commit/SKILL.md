---
name: commit
description: Git commit with conventional format
---

Before committing:
1. Run `npx biome check src/ tests/` - abort if errors
2. Run `npm run test:fast` - abort if failures (fast unit tests only)
3. Stage changed files with `git add` (specific files, not -A)
4. Commit with message: `$ARGUMENTS`

Message must use conventional commits: feat:, fix:, refactor:, docs:, test:, chore:

Append `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>` to commit body.
