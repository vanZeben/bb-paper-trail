# Changelog

All notable changes to Paper Trail are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- A private contribution graph of rated workdays, with lenses for rating, role area, meeting load, evidence volume and plan. Click a day or week for its rating, reasoning, claims, coverage and evidence links.
- Capture through hidden agent threads that use your agent's own connectors (calendar, Granola, Fellow, Jira, Confluence, GitHub, Slack, notes and memory). The plugin holds no credentials.
- Zero-config setup: give it a name, an email and a role card, and the agent infers role areas, rubric, work split, guardrails, goals and manager, then queues a four-week backfill.
- Tool-less daily rating and weekly judgment, with strictly validated replies, https-only links and a random per-prompt fence around evidence.
- Confirm or override any rating with a note; overrides feed back into later prompts as calibration.
- Time split against a target with weekly drift, and guardrails for meeting load, a neglected area, stale asks, a failing source and too many threads in flight.
- A week loop: a Monday scan writes an intent and commitments with "done when" marks, Friday marks each one hit, partial or missed with a retro, and a plan-accuracy trend calibrates the next scan.
- Threads for work that spans weeks, with agent-drafted closure notes that your own always override.
- An invisible-work radar for substantive evidence that no rating, claim or commitment cites.
- Review packets for any date range as markdown, with an optional agent-written narrative; copy, download or save to a notes folder.
- Data export and import as a JSON bundle.
- The `bb paper-trail` command (`status`, `day`, `week`, `backfill`, `doctor`, `connectors`, `packet`, `export`) and a skill for agents.
- Plugin settings for scheduled capture, time zone, capture host, provider and models, worker permission mode, parallelism, timeouts, schedules, enabled sources and graph length.
