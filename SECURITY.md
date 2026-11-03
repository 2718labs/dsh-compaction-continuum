# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x | Yes |
| <= 0.2.x | No (internal revisions, no public releases) |

Security fixes are released on `main` and tagged. Because the plugin runs inside the Harness host with the privileges of any installed plugin, there is no attempt to backport to unreleased revisions.

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Include:

- the plugin version and the Harness version,
- the smallest reproduction you can construct (config row, command, route),
- the impact you believe it has.

You will get an initial response within a reasonable time; this is a small volunteer project, so please allow a few days.

## What this plugin can and cannot do

- It runs as a normal Host plugin. It can therefore read whatever the Harness exposes to plugins, including session state. Review the code before installing it into a profile that handles sensitive data.
- It performs no telemetry and makes no network requests of its own. Model calls go through the host LLM service, using the route that the session is already using.
- It publishes its checkpoints into the session log exactly like the shipped backend does: one replacement user message plus the retained tail.
- It writes none of its own state to disk. The accounting ledger and the diagnostics are in-memory and are lost when the host restarts.

## Diagnostics endpoints

Two loopback-only, unauthenticated endpoints are registered when `statusCommands` is enabled:

- `GET /compaction-continuum/ping` — version, policy and cache counters.
- `GET /compaction-continuum/selftest` — counts, policy, hook identity, failure stacks, and the projection-alignment check. `?test=extract` additionally performs one small synthetic model call.

Neither returns conversation content. They do expose opaque session identifiers to anything that can reach the loopback port; on a shared machine, set `statusCommands: false` if that is not acceptable. Set `mode: off` to keep the plugin loaded but fully hand compression back to the shipped summarizer.
