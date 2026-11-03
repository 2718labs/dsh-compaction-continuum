# Contributing

This document describes how to contribute to the project. The plugin is small and focused: a compression backend for DeepSeek Harness, not a general context toolkit. Contributions that keep it small and measurable are preferred.

## Development setup

Requirements: Node.js >= 20 (no package installation needed — the plugin and its tests have no runtime or dev dependencies).

```bash
npm test    # offline: structural core + pipeline + benchmark harness, 95 assertions
npm run check
node bench/report.mjs   # accounting over this machine's recorded sessions (or pass a directory)
```

The offline suite is the contract: the extraction prompt shape, quote provenance, the stiffness/KKT/condensation arithmetic, the certificates, the deterministic render, and the fail-open ladder. Host behavior is verified on a live Harness install (see below).

## How the plugin attaches to the host

Two seams are relevant:

1. **Host plane** — the bundle patch mounts this package as the `compaction` service of a composition that has no preset plane.
2. **Preset plane** — the desktop app isolates one shipped `@deepseek-ai/dsh-compaction-basic` instance per agent preset. The plugin installs its compressor on that engine's single documented customization hook (`BasicCompactionEngine.prototype.summarize`) and restores it on unload. Do not add a second `compaction` provider: the composition rejects it, and the preset plane would not see it.

`docs/DESIGN.md` explains the structural model and why the hook is the only viable seam on the desktop.

## Cache invariants

The project exists to compress without destroying the provider prefix cache. Changes must preserve:

- one publication per epoch; never rewrite mid-history;
- no per-turn or mid-session re-summarization;
- the extraction call replays the session's own prefix (`input.messages` + `input.tools`) with only the instruction appended — no dedicated summarizer system prompt, no model switch;
- fail-open order: structural compile → deterministic render (zero model calls) → shipped summarizer.

If a change affects compaction frequency or retained tokens, include measured cache numbers (cached vs uncached input tokens from `compaction/summary.usage` and the following request) in the PR.

## Pull requests

- One concern per PR, Conventional Commits style messages.
- Update both `README.md` and `README.zh-CN.md`, plus `CHANGELOG.md` under `Unreleased`.
- Never commit conversation content, prompts, session logs, credentials, or absolute local paths.
- New behavior needs an offline assertion unless it is inherently host-only; host-only changes must state the DSH version tested and include the content-free diagnostics output.

## Live verification

Install the working copy into a profile as a local bundle, then:

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/compaction-continuum/selftest | ConvertTo-Json -Depth 8
Invoke-RestMethod 'http://127.0.0.1:<port>/compaction-continuum/selftest?test=extract' |
  Select-Object -Expand probes | Where-Object name -eq 'extraction contract' | Select-Object -Expand value
```

In a session: `/context_status`, `/context_inspect`, and `/compact` for a real publication. The `hook` block must report the backend engine as the shipped class with `backendUsesHookedSummarize: true`.

## Reporting bugs

See `.github/ISSUE_TEMPLATE/bug_report.yml`. Include the plugin version (from `/compaction-continuum/ping`) and the Harness version.
