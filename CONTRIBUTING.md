# Contributing to Paper Trail

Thanks for helping. This guide covers the setup, the rules every change has to keep, and how a
pull request gets merged.

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md). Report security issues
privately, as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## Ways to help

- **Report a rating that looks wrong** with the "Rating feedback" issue form. Use fictional or
  paraphrased examples.
- **Report a bug** with the bug template: bb version, sources involved, what you did, what
  happened.
- **Suggest a feature** with the feature template, starting from the problem rather than the
  solution.
- **Pick up an issue** labelled `good first issue` or `help wanted`, and say so in the issue
  so nobody duplicates the work.
- **Improve the docs.** If something here or in [docs/](docs/) confused you, it will confuse
  the next person too. The diagrams are generated: edit `scripts/render-diagrams.mjs` and run
  `npm run docs:render`.

## Development setup

You need Node.js 22 or later, npm, and bb 0.50 or later.

```sh
git clone https://github.com/vanZeben/bb-paper-trail.git
cd bb-paper-trail
npm install
npm run typecheck     # tsc for the plugin and for the tests
npx vitest run        # unit and integration tests
npm run check:app     # builds, then fails if dist/app.js carries zod or the server SDK
npm run build         # bb plugin build: dist/server.js and dist/app.js
npm run docs:render   # regenerate the diagrams
```

To try a change in your bb:

```sh
bb plugin install .     # register this checkout (once)
bb plugin dev           # rebuild and reload on every save
bb plugin logs paper-trail -f
```

## Rules every change keeps

A pull request that breaks one of these won't be merged, however useful the rest of it is.

1. **No zod and no server SDK in the app bundle.** The app imports only types from
   `lib/contract.ts`. A runtime import of the server SDK or zod breaks installs and bloats the
   bundle. `npm run check:app` fails when `dist/app.js` contains either.
2. **Fictional names only in test fixtures.** Tests, docs, screenshots and examples never use a
   real person, employer, ticket or private channel name.
3. **No credentials.** The plugin stores none and adds no network code of its own; capture uses
   the agent's connectors.
4. **Evidence stays traceable.** Every rating and claim cites evidence ids, and links are
   https-only.
5. **Tool-less judging.** Day rating, week judgment and narratives run without tools.
6. **Append-only migrations.** Never edit or reorder an existing storage migration; add a new
   one.

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep each pull request to one change. Large changes start as an issue, so we can agree on the
   approach first.
3. Add or update tests. Bug fixes come with a test that failed before the fix.
4. Run `npm run typecheck`, `npx vitest run` and `npm run check:app` locally; CI runs the same.
5. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would
   notice.
6. Fill in the pull request template.

Write commit messages in the imperative ("Skip off sources when rating a day"), with a body
explaining why when it isn't obvious.

## Questions

Ask in [GitHub Discussions](https://github.com/vanZeben/bb-paper-trail/discussions) or open an
issue. [SUPPORT.md](SUPPORT.md) lists where to go for what.
