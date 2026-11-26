# Security policy

## Supported versions

Security fixes go into the latest release. bb users who installed Paper Trail receive them
through bb's plugin updates.

| Version | Supported |
|---|---|
| Latest 0.x release | Yes |
| Older releases | No (please update) |

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead:
[Security → Report a vulnerability](https://github.com/vanZeben/bb-paper-trail/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get
a first response within a week. Once a fix is released, the advisory is published with credit
to you, unless you'd rather stay anonymous.

## What Paper Trail can and can't do

bb plugins run with full trust inside the bb server. The full account of how Paper Trail
handles your data, its defences against prompt injection and the remaining risk is in
[docs/privacy-and-security.md](docs/privacy-and-security.md). Read it before you assess a
report. In short:

- It stores no credentials and has no network code of its own. Capture runs as hidden agent
  threads that use your agent's own connectors.
- Its data lives in the bb server's plugin database.
- Capture threads cannot be sandboxed by the plugin, so a hostile ticket or chat message
  reaching a capture thread is the main remaining risk, and reports about it are in scope.

Issues in bb itself, or in a connector or provider, belong with those projects.
