# Paper Trail design

The contributor contract. For behaviour see [how-it-works.md](how-it-works.md); for the threat model see [privacy-and-security.md](privacy-and-security.md).

## Module map

| Path | Role |
|---|---|
| `server.ts` | Plugin entry: settings, RPC contract, handlers, CLI, the 10-minute tick. Registers features in `FEATURE_ORDER`. |
| `lib/engine/` | The core. `service.ts` (day, week, backfill, fill gaps, tick), `rating.ts` (day rating and week judgment prompts and validators), `grid.ts` (the graph payload), `evidence.ts` (fenced evidence blocks, sanitising), `runner.ts` (jobs, retry, concurrency), `extensions.ts` (hooks), plus `queue.ts`, `schedule.ts`, `dates.ts`, `time.ts`, `markdown.ts`, `meetings.ts`, `json.ts`. |
| `lib/capture/` | One module per source family (`meetings`, `jira`, `confluence`, `github`, `slack`, `identity`, `connector-check`) and the shared `common.ts` (coverage helpers, https-only links). `sources.ts` lists the nine sources. |
| `lib/features/*` | Self-contained feature modules (below). |
| `lib/framework/` | The role framework: default, rubric text, import. |
| `lib/storage/` | `port.ts` (the `Store` interface and `KIND` constants), `store.ts` and `db.ts` (SQLite), `memory.ts` (in-memory store for tests). |
| `lib/handlers/` | RPC handlers, one file per feature plus `core.ts`. |
| `lib/contract.ts` | The zod RPC contract shared by server and app. |
| `lib/worker.ts` | The `WorkerPort` on bb hidden threads. |
| `lib/types.ts`, `lib/settings.ts` | Schemas and plugin settings. |
| `components/*` | The app: `graph`, `time`, `plan`, `threads`, `review`, `radar`, `guardrails`, `onboarding`, `settings`, `ui`, plus `safeHref.ts`. |

## Storage

One SQLite database owned by the plugin: `records(kind, id, version, json, updated_at)` and `meta(key, value)`. The `Store` port offers `get`, `set`, `list`, `delete`, `getMeta` and `setMeta`; every read goes through a zod schema, and rows that fail the schema are skipped. Kinds (from `lib/storage/port.ts`, always use `KIND.*`, never string literals): `day`, `week`, `index`, `framework`, `connectors`, `targets`, `drift`, `rules`, `violation`, `override`, `plan`, `threads`, `thread-edit`, `closure`, `ghost`, `addenda`, `mix`, `packet`, `profile`, `setup`, `goals`. `version` defaults to 1 and is bumped per kind when a breaking schema change needs an upgrade step.

## Features and extension points

Each feature lives in `lib/features/<f>/` and exports `register(reg)` from its `index.ts`. `server.ts` calls them in `FEATURE_ORDER`:

`connectors`, `framework`, `overrides`, `goals`, `plan`, `drift`, `threads`, `guardrails`, `ghost`, `packet`, `migrate`

(`setup` also lives under `lib/features/` but is driven by its handlers rather than registered.) Order matters: it is the order hooks and grid contributors run. A feature adds behaviour through the `Registry` in `lib/engine/extensions.ts`, without editing shared engine files:

| Extension | Purpose |
|---|---|
| `PromptExtension` | Extra day-rating rules (`dayRules`), week-judgment rules (`weekRules`), reply-example keys (`weekReplyExample`) and a validator for its keys (`validateWeekExtra`, stored at `week.ext[id]`; throwing rejects the reply and the runner retries once). |
| `WeekHook` | `afterWeekSaved(week, ctx)`. |
| `DayHook` | `afterDayRated(day, ctx)`. |
| `TickHook` | `onTick(ctx)` on every scheduled tick, fire-and-forget, must be cheap when idle. |
| `GridContributor` | `contribute(grid, ctx)` mutates the grid payload in place (lens fields, markers, lens availability). |

Hook failures are logged and never fail the run. Every hook gets a `FeatureCtx` (store, settings, framework, runner, log, publish, now).

## The worker

`lib/worker.ts` implements `WorkerPort`. One job is one fresh **hidden** thread (`visibility: "hidden"`) on the capture host, archived and stopped when the job ends.

- **Host selection.** The `captureHost` setting is matched by name against the bb hosts. Empty means the primary host, then the first connected host. A missing or disconnected host throws a plain error.
- **Environment.** The personal project on that host; if the personal workspace is refused, another project with a source on the host.
- **Permission modes.** `permissionModeFor(configured, tools)`: tool-less jobs (`tools: "none"`) always get `accept-edits`; everything else gets `accept-edits` if configured, otherwise `auto`. `full` is never used. A thread blocked on a pending approval fails fast with "permission needed".
- **Concurrency and single-flight.** The runner limits parallel jobs (setting, default 2). The service serialises work through a queue keyed by day or week, and a run joining one that is waiting upgrades it. The tick has an in-flight guard, the connector check refuses to start while one is running, and framework import and data import refuse a second concurrent run.

Jobs carry a `guard` text (default `READ_ONLY_GUARD`) prepended to the prompt.

## The app-bundle rule

`dist/app.js` runs in the browser. It must not contain zod or the server SDK. Keep zod schemas on the server side of the contract; the app side must not pull them in. `npm run check:app` builds and then fails if the bundle contains `ZodError`, `zod` or the server SDK.

## Testing

```sh
npm run typecheck        # tsc for the plugin and for the tests
npx vitest run           # unit tests (the in-memory store stands in for SQLite)
npm run check:app        # build, then verify the app bundle is clean
npm run build            # bb plugin build
```

Run all four before a pull request.

## Rules a change has to keep

- Anything from a connector is untrusted: sanitise with `promptText`, wrap with `fencedData`, validate the reply strictly.
- Links are https-only, on the server (`httpsLink`) and in the UI (`safeHref`).
- Tool-less jobs stay tool-less. New connector jobs declare `tools: "read"` and keep a read-only guard.
- Do not add credentials, network code or new storage outside the `Store` port.
- Keep examples and fixtures fictional (Alex Rivera, ACME-142, `America/New_York`).
