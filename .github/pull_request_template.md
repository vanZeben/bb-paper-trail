## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Fixes #123". -->

## How I checked it

- [ ] `npm run typecheck`, `npx vitest run` and `npm run check:app` pass locally
- [ ] Tests added or updated (bug fixes include a test that failed before the fix)
- [ ] For UI changes: tried it in a real bb (describe how below)

<!-- How you tried it in bb, with screenshots for UI changes. Use fictional data only. -->

## Rules kept

- [ ] The app bundle has no zod and no server SDK (`npm run check:app`)
- [ ] Test fixtures use fictional names only
- [ ] No credentials stored; evidence links stay https-only

## Changelog

- [ ] Added a line under **Unreleased** in `CHANGELOG.md` (or this change isn't user-visible)
