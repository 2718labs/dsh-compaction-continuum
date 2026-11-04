# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.6.x | Yes |
| <= 0.5.x | No (superseded; upgrade to the latest release) |

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
- It publishes its checkpoints into the session log exactly like the shipped backend does: one replacement user message plus the retained tail. Verbatim retention and cross-generation anchor carry are ordinary checkpoint text; retained image blocks are copied into that same user message.
- `context_recall` is a model-facing tool, registered by default and gated by the `recallTool` config key. On a model's request it reads the calling agent's own durable session events and returns them to that model within the same session request; the plugin does not transmit or store the result anywhere else. Diagnostics remain content-free.
- It writes none of its own state to disk. The accounting ledger and the diagnostics are in-memory and are lost when the host restarts.

## Diagnostics endpoints

Two loopback-only, unauthenticated endpoints are registered when `statusCommands` is enabled:

- `GET /compaction-continuum/ping` — version, policy and cache counters.
- `GET /compaction-continuum/selftest` — counts, policy, hook identity, failure stacks, and the projection-alignment check. `?test=extract` runs one small synthetic model call on a built-in fixture. `?test=replay` rebuilds the most recent recorded compaction span from the live session and runs one real model call on it; that span is session content, so only run this if that content may be sent to the model provider. Neither test publishes anything.

Neither returns conversation content in its response. They do expose opaque session identifiers to anything that can reach the loopback port; on a shared machine, set `statusCommands: false` if that is not acceptable. Set `mode: off` to keep the plugin loaded but fully hand compression back to the shipped summarizer.
