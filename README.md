# dsh-compaction-continuum

English | [简体中文](./README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-v0.3.0-A44742)](./CHANGELOG.md)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5-1F6B5B)](https://github.com/deepseek-ai)
[![License](https://img.shields.io/badge/license-MIT-263238)](./LICENSE)
[![CI](https://github.com/2718labs/dsh-compaction-continuum/actions/workflows/ci.yml/badge.svg)](https://github.com/2718labs/dsh-compaction-continuum/actions/workflows/ci.yml)

A context-compaction backend for DeepSeek Harness. I call it Structural Compression.

Harness's built-in compaction asks a model to read the history and write a summary, then puts that summary back into the context. This plugin does something different: it pulls cited sentences out of the original text, works out which of them are load-bearing, and keeps only those — each one traceable back to the source.

## Why I built it

Before writing any code I measured where the money goes in long sessions. I ran the numbers over 25 session logs from this machine (3,515 requests, 997M prompt tokens):

- Normal requests hit the provider cache 99.20% of the time. That part is cheap.
- Every shipped compaction makes the model re-read roughly 550k tokens of history at the price of fresh input.
- That's not cache expiry. The request right before one measured compaction hit 99.85% of its prompt, 0.1 seconds earlier. The summarization request only matched the first 9,856 cached tokens.

550k tokens is about a 400-page book. Each compaction makes it read that book again.

I wanted the extraction call to reuse the cache too. It doesn't work: the request the harness replays at compaction time isn't byte-identical to the request it actually sent, because some of that request lived outside the session log. So there are two options now:

- **`deterministic`**: no model call at all during compaction, just structural selection. Skips those 550k tokens, but the output is rougher.
- **`extract`**: still one model call, roughly the same cost as the shipped summarizer — but every line in the checkpoint traces back to the source, and publication is refused if a pinned constraint would be dropped.

I run `extract` myself, because I trust what comes out. If you care more about the bill, `deterministic` cuts about three quarters of that input.

## What a checkpoint looks like

Here's what a render looks like, using the test fixture's theme (schematic, but the shape is what the renderer emits):

```
## Primary Request and Intent
- Make the static route table in router.ts lazy while keeping /api/health
- User note: don't break the cache hit rate

## Critical Context
- /api/health must stay
- Decision: lazy registration in stages, leave /api/health alone

## Verbatim Anchors
- target file — "G:/proj/src/router.ts"
- E_ROUTE_DUP lives in registry.ts:88 — "E_ROUTE_DUP"
```

The quoted text is verbatim from the source. If the quote isn't found in the original, that item doesn't make it into the checkpoint. The model only picks sentences and copies them; layout, budget, and what gets dropped are all local arithmetic.

## How it works

One compaction, roughly:

1. Replay the span being compacted (plus the system prompt and tools) to the model, append an instruction, and ask for JSON: each item has a kind, a short summary, and a quote that must appear verbatim in the source.
2. Verify every quote locally. Missing quotes and invented ones are dropped.
3. Treat the survivors as degrees of freedom. Shared source, adjacency, and same-kind become stiffness; the current request is the load; exact anchors and open loops are pinned as supports.
4. Solve a KKT system, run static condensation, keep the load-bearing set.
5. Emit a certificate: were supports eliminated, is the selection self-consistent, does the condensation reconstruct the original response? If any check fails, nothing is published.
6. Render the result into the checkpoint budget.

Any failure falls back one step: structural compile fails → deterministic render with no model call; that fails too → the shipped summarizer. A session never ends up without a checkpoint.

## Where it attaches

This part is unusual, so it's worth knowing.

The desktop app puts the compaction backend inside each agent preset's isolated scope. A `compaction` provider mounted on the Host plane can't see it. So the plugin doesn't register a second provider; it replaces the one extension point the shipped engine publicly admits: `BasicCompactionEngine.prototype.summarize`. The shipped compaction flow calls that method dynamically every time, so swapping it covers the preset-plane engine as well. The shipped transaction, lock, overflow recovery, retained tail, and replay stay exactly as shipped, and unloading the plugin restores the original method.

The plugin also mounts a Host-plane `compaction` provider, so compositions without a preset plane still work.

After installing, the self-test tells you which engine is actually active:

```json
"hook": {
  "installedOnShippedClass": true,
  "backendIsShippedClass": true,
  "backendUsesHookedSummarize": true
}
```

## Install

You need the desktop Harness, with `BasicCompactionEngine` reachable in the composition (verified on `0.2.1-rc.5`).

With the plugin manager, install the bundle from its GitHub spec:

```
target: github:2718labs/dsh-compaction-continuum#v0.3.0
```

Manually, add the dependency and the bundle to `~/.dsh/profiles/<profile>/package.json`. The bundle must come after `@deepseek-ai/dsh-web-app`:

```json
{
  "dependencies": {
    "dsh-compaction-continuum": "github:2718labs/dsh-compaction-continuum#v0.3.0"
  },
  "dsh": { "profile": { "bundles": ["...", "dsh-compaction-continuum"] } }
}
```

Then run `/context_status` in a session, or hit `http://127.0.0.1:<port>/compaction-continuum/ping`. The port is the one `dsh web` gave you; mine is 48483.

## Commands

| Command | What it does |
| --- | --- |
| `/compact` | Compact now. On desktop the preset's own command reaches this compressor; the plugin also registers a same-name fallback. |
| `/context_status` | Context size, trigger, the last compaction's cost, real cache hit rate. No conversation content. |
| `/context_inspect` | The compaction ledger: cut ranges, publication cost, structural audit, certificate result. |

`/context_status` looks like this:

```
hook               : installed on @deepseek-ai/dsh-compaction-basic; active engine shipped BasicCompactionEngine (preset plane, hooked)
trigger threshold  : 727040 tokens (ratio 0.8)
current context    : 273740 tokens (26.1% of window, 453300 below trigger)
last audit         : compiled mode=extract units=318 candidates=41 kept=27 checkpoint≈5837 tokens certificate={...}
extractor call     : 312480 cached / 640 uncached input tokens
cache accounting   : 123 requests, hit 99.24% (384347520 cached / 2935624 uncached)
```

## Configuration

The plugin row only configures the compressor. Thresholds and retention belong to the shipped engine that runs it.

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `extract` | `extract` makes one model call; `deterministic` stays local; `off` hands everything back to the shipped summarizer |
| `extractorMaxTokens` | `12000` | Output cap for the extraction call |
| `checkpointMaxTokens` | `6000` | Checkpoint budget |
| `selectionThreshold` | `0.35` | Load-bearing cutoff, relative to the maximum displacement |
| `minKeep` | `8` | Minimum number of kept items |
| `statusCommands` | `true` | Register the commands and loopback diagnostics |
| `maxRecordedCompactions` | `32` | Ledger entries per session |
| `logDecisions` | `true` | Log compile decisions |

Keys shared with the shipped backend — `thresholdRatio`, `retainTokens`, `maxTokens` and the rest — only apply when this plugin is itself the `compaction` provider (compositions without a preset plane). On desktop the preset engine's policy is what runs; `/context_status` reports the resolved values.

## Numbers

Method and per-event tables are in [docs/EVIDENCE.md](./docs/EVIDENCE.md). The short version:

| Observation | Value |
| --- | --- |
| Steady-state cache hit rate (25 sessions / 3,515 requests) | 99.20% |
| One shipped automatic compaction | ~720k extra input tokens: ~550k re-reading history + ~170k for the re-read any rewrite pays |
| The summarizer call in those events | matched 0–9,856 cached tokens of its ~550k prompt, while the request 0.1–12.8 s earlier hit 99%+ |
| Manual `/compact` after a long idle | the summarizer call paid 331,799 uncached tokens; the cache really had expired, so that one is unavoidable |
| Tool-result pruning | three runs freed 141,041 tokens and forced 1,675,192 tokens of re-reading (~12×). This compressor does no pruning |

Run `node bench/report.mjs` to see your own machine's numbers.

## Things that are wrong or missing

- Thresholds and retention come from the preset's shipped engine. Manual `/compact` cuts deeper than automatic compaction (the shipped engine retains 0 for manual).
- If extraction can't produce verifiable quotes, the checkpoint falls back to deterministic rendering; if that can't shrink the source either, the shipped summarizer runs. So quality depends on how disciplined the model is about quoting. The certificate proves the structure is self-consistent, not that no information was lost.
- The extraction call can't reuse the live request prefix, so `extract` costs the same as the shipped summarizer. `deterministic` avoids the call entirely. Making the replay byte-identical to the live request needs request-time data the log doesn't have; it's on the roadmap and I don't have it working.
- The hook targets one specific shipped method. If a future release renames or moves it, the plugin silently falls back to the shipped summarizer rather than breaking a session — check `hook.backendUsesHookedSummarize` after upgrades.
- The desktop preset still mounts the shipped tool-result pruner. It measured as a net loss, but this plugin doesn't touch it. Disabling it means overriding the preset declaration; `docs/DESIGN.md` explains why I didn't do that.

## Development

```bash
npm run check   # syntax
npm test        # 80 offline assertions, no Harness install needed
node bench/report.mjs   # cache accounting over this machine's session logs
```

Layout:

```
lib/index.js            host side: engine hook, commands, accounting, diagnostics
lib/pipeline.js         extraction → structure → render
lib/structure/core.js   stiffness assembly, KKT, static condensation, certificates
bench/                  read session logs, account for cache and compaction
test/                   offline tests
docs/DESIGN.md          design notes
docs/EVIDENCE.md        measured evidence
```

Invariants a PR must keep are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Privacy

No telemetry, no network calls of its own, no disk state. The two loopback diagnostic endpoints are for local debugging and contain no conversation content; set `statusCommands: false` to turn them off. Details in [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 2718Labs.
