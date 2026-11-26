---
name: paper-trail
description: Paper Trail keeps a private, evidence-backed contribution graph of the user's engineering work: rated workdays and weeks, each linked to its sources. Use when the user asks about their rated days or weeks, wants a day captured or a week judged, a review packet or data export, or wants to know why capture is failing.
---

# Paper Trail

Paper Trail captures each finished workday from the user's connectors through hidden agent threads, rates it against their role, and judges each week on Friday. Every rating and claim cites evidence ids that link to a source over https. The data is the user's own, kept in the bb server's plugin database.

- Setup, goals, role framework, work split, guardrails and sources are edited in the Paper Trail app (Settings tab) and in Settings → Plugins → Paper Trail. Point the user there.
- A day's rating is provisional until its week is judged. The user can confirm or override any rating with a note.
- A source that shows `off` in a day's coverage is not counted against the user. Do not present a thin day as a bad one without checking coverage.
- Do not paste evidence, ticket titles or chat text from Paper Trail into other places unless the user asks.

## Commands

| Command | Effect |
| --- | --- |
| `bb paper-trail status [--json]` | Run and queue status. |
| `bb paper-trail day <YYYY-MM-DD> [--json]` | Capture and provisionally rate one day (waits for the result). |
| `bb paper-trail week <YYYY-Www> [--recapture] [--json]` | Judge a week (waits for the result). |
| `bb paper-trail backfill [--weeks N] [--force]` | Queue the last N finished weeks (default 4, at most 40). |
| `bb paper-trail doctor` | Check that a capture thread can run on the capture host. |
| `bb paper-trail connectors [--check] [--json]` | Show the connector check; `--check` runs a fresh one. |
| `bb paper-trail packet <from> <to> [--out FILE]` | Review packet for a date range as markdown. |
| `bb paper-trail export [--from DATE --to DATE] [--out FILE]` | Data bundle as JSON. |
| `bb plugin config paper-trail set <key> <value>` | Change a setting, for example `timeZone`. |

Large results need `--out FILE`; `packet` and `export` refuse to print past the stdout limit.

## Key RPCs

Call these through the plugin RPC route (`/api/v1/plugins/paper-trail/rpc/<method>`).

- `grid.get`, `day.get`, `week.get`, `week.markdown`: read the graph, one day with its override, one week with plan and violations.
- `run.start` (`day`, `week`, `backfill`, `fill_gaps`) and `run.status`: queue work and watch it.
- `connectors.get`, `connectors.check`, `diag.ping`: sources and capture health.
- `setup.get`, `setup.answer`, `setup.synthesize`, `setup.apply`: zero-config setup.
- `override.set`, `override.clear`, `override.stats`: the user's rating overrides.
- `plan.get`, `plan.set`, `plan.now`, `plan.accuracy`: the week plan and its accuracy.
- `threads.list`, `threads.edit`, `closure.set`: work that spans weeks.
- `ghost.list`, `ghost.claim`, `ghost.dismiss`: the invisible-work radar.
- `packet.build`, `packet.markdown`, `packet.narrative.start`, `packet.writeNote`: review packets.
- `data.export`, `data.import`, `migrate.status`: data bundles.

## Troubleshooting

1. `bb paper-trail doctor` confirms a capture thread can run. If it fails, check the `captureHost` setting.
2. `bb paper-trail connectors --check` shows which sources the capture host can reach and as which account.
3. `bb paper-trail status` shows the running job, the queue and the last error.
