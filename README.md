# dsh-compaction-continuum

English | [简体中文](./README.zh-CN.md)

[![Version](https://img.shields.io/badge/version-v0.3.0-A44742)](./CHANGELOG.md)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5-1F6B5B)](https://github.com/deepseek-ai)
[![License](https://img.shields.io/badge/license-MIT-263238)](./LICENSE)
[![CI](https://github.com/2718labs/dsh-compaction-continuum/actions/workflows/ci.yml/badge.svg)](https://github.com/2718labs/dsh-compaction-continuum/actions/workflows/ci.yml)

**结构性压缩 · Structural Compression** — a context-compaction backend for DeepSeek Harness.

> Compress like a structure, not like a summary.
>
> A model may only quote; arithmetic decides what carries load.

Instead of asking a model to write a free-form summary, this backend treats the conversation as a structure. Candidate blocks become degrees of freedom, evidence coupling becomes stiffness, the current request becomes the load, exact anchors and open loops become supports, and compression is a **static condensation**: keep the load-bearing coordinates, eliminate the rest, and publish a checkpoint only when the reduction carries a certificate. The checkpoint is assembled deterministically from quotes that were verified as substrings of the replayed source.

The shipped compaction engine still owns everything durable — the bracket, the lock, the overflow recovery, the retained tail and the warm-prefix replay. This plugin replaces only how the checkpoint content is produced.

## Status

- `0.3.0`, first public release. Verified against DeepSeek Harness `0.2.1-rc.5` (packaged desktop app, Windows).
- The plugin is a normal Host bundle; it does not patch the Harness itself.
- It installs its compressor on the shipped backend's documented single customization hook and restores it when unloaded. If that seam ever changes shape, the plugin fails open to the shipped summarizer instead of breaking sessions.

## How it works

One extraction call, then local arithmetic:

```
shadowed span
 └─ 1 model call: extract cited atoms  {kind, text, unit, exact quote}
       └ mechanical validation: the quote must appear verbatim in the replayed source
 └─ build the structure: atom = DOF; shared source / adjacency / same kind = stiffness;
    current request = load; anchors + open loops = supports
 └─ solve  [K Cᵀ; C 0][u;λ] = [f;d]  (KKT)
 └─ static condensation: keep load-bearing DOFs, eliminate the rest, derive a
    reconstruction operator
 └─ certificate: supports preserved, selection consistent, condensation reconstructs
    the full response — otherwise nothing is published
 └─ deterministic render: pack the kept atoms into the checkpoint budget
```

**Fail-open ladder.** Structural compile → deterministic render (no model call at all) → shipped LLM summarizer. A session always ends up with a checkpoint.

The extraction call reuses the session's own prefix: same system prompt, same tool catalog, same history, with only the instruction appended. It does not introduce a summarizer-specific system prompt and never switches models, so the provider prefix cache stays warm when compaction runs close to a request.

## How it attaches to the host

The desktop app moves the compaction backend into the **agent-preset plane**: each preset mounts a shipped `@deepseek-ai/dsh-compaction-basic` inside an isolated `compaction` service group, so a Host-plane provider cannot compact those sessions. The only seam both planes share is the shipped engine's sole documented subclass hook:

```
BasicCompactionEngine.prototype.summarize
  └─ regionDependencies() dispatches through this.summarize(...) on every compaction
       └─ replaced by: extraction → structure → condensation → deterministic render
```

Consequences:

- The shipped engine's transaction, idle admission, overflow recovery, retained-tail policy and warm-prefix replay all stay exactly as shipped.
- The replacement is installed when the plugin loads and restored when it unloads.
- The plugin also mounts a Host-plane `compaction` provider so that compositions without a preset plane work normally.

Run the self-test to see which backend is active:

```json
"hook": {
  "installedOnShippedClass": true,
  "backendIsShippedClass": true,
  "backendUsesHookedSummarize": true
}
```

## Install

Requirements: a DeepSeek Harness desktop install whose composition exposes the `BasicCompactionEngine` seam (verified on `0.2.1-rc.5`), and write access to your profile.

### With the plugin manager

Install the bundle from its GitHub spec, exactly like any other profile bundle:

```
target: github:2718labs/dsh-compaction-continuum#v0.3.0
```

Pin a tag or commit for reproducibility. The manager adds the dependency, appends the bundle to `dsh.profile.bundles`, and applies the patch to the running host.

### Manually

In `~/.dsh/profiles/<profile>/package.json`:

```json
{
  "dependencies": {
    "dsh-compaction-continuum": "github:2718labs/dsh-compaction-continuum#v0.3.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-compaction-continuum"]
    }
  }
}
```

The bundle must come **after** `@deepseek-ai/dsh-web-app` in `bundles`, so its patch applies after the web layer disables the shipped backend rows.

### Verify

```powershell
# liveness + policy + hook (no login, loopback only)
Invoke-WebRequest http://127.0.0.1:48483/compaction-continuum/ping -UseBasicParsing | Select-Object -Expand Content

# full content-free diagnosis
Invoke-RestMethod http://127.0.0.1:48483/compaction-continuum/selftest | ConvertTo-Json -Depth 8

# end-to-end extraction contract: one small synthetic model call, no session data, no publication
Invoke-RestMethod 'http://127.0.0.1:48483/compaction-continuum/selftest?test=extract' |
  Select-Object -Expand probes | Where-Object name -eq 'extraction contract' | Select-Object -Expand value
```

Replace `48483` with the port printed by `dsh web`.

## Commands

| Command | What it does |
| --- | --- |
| `/compact` | Compact this conversation now. On the desktop the preset's own command reaches the hooked backend; this plugin also registers a fallback with the same name. |
| `/context_status` | Pressure, trigger threshold, retention, the active engine, the last audit, the extraction call's cache accounting, and the real cache hit rate. Content-free. |
| `/context_inspect` | The content-free ledger: cut seqs, publication cost, structural audit and certificate results. |

Sample `/context_status`:

```
hook               : installed on @deepseek-ai/dsh-compaction-basic; active engine shipped BasicCompactionEngine (preset plane, hooked)
trigger threshold  : 727040 tokens (ratio 0.8)
retained verbatim  : 126812 tokens on automatic compaction; manual /compact cuts deeper
current context    : 273740 tokens (26.1% of window, 453300 below trigger)
last audit         : compiled mode=extract units=318 candidates=41 kept=27 checkpoint≈5837 tokens certificate={...}
extractor call     : 312480 cached / 640 uncached input tokens
cache accounting   : 123 requests, hit 99.24% (384347520 cached / 2935624 uncached)
```

## Configuration

The plugin row configures the **compressor**; the compaction policy (threshold, retention) belongs to the backend engine that runs it:

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `extract` | `extract` (one extraction call + structure), `deterministic` (no model call at all), `off` (hand everything back to the shipped summarizer) |
| `extractorMaxTokens` | `12000` | Output cap for the extraction call |
| `checkpointMaxTokens` | `6000` | Checkpoint budget |
| `selectionThreshold` | `0.35` | Load-bearing threshold, relative to the maximum displacement |
| `minKeep` | `8` | Minimum number of kept candidates |
| `statusCommands` | `true` | Register the commands and the loopback diagnostics |
| `maxRecordedCompactions` | `32` | Ledger entries kept per session |
| `logDecisions` | `true` | Log compile decisions |

Keys that only apply when this plugin is itself the `compaction` provider (non-desktop compositions) follow the shipped backend: `thresholdRatio`, `headroomTokens`, `retainTokens`, `retainRatio`, `maxTokens`, `summarizationProvider/Model`, `compactionRetries`, `maxOverflowRetries`, `modelPolicies`, `auto`. On the desktop, the preset engine's own policy is what runs; `/context_status` reports the resolved values.

## Cache economics

Measured on real sessions (27 sessions, 4400+ requests) with the desktop app:

| Observation | Value |
| --- | --- |
| Steady-state prefix-cache hit rate | 99.1% – 99.7% |
| One-time publication re-read after a compaction | one full read of the new prefix, unavoidable for any rewrite |
| Manual `/compact` after a 49-minute idle gap | extraction call paid 331,799 uncached tokens (provider cache had expired — no design can avoid this) |
| Compaction replay vs. the agent's own request projection | identical: `live=399 replayed=399 identical=true` |
| Tool-result pruning (`tool-result-pruner`) | net cache loss: ≈1.1M miss-equivalent over three runs — this compressor adds no pruning of its own (the desktop preset still mounts the shipped pruner, which this plugin does not control) |

Hard rules the implementation keeps: one publication per epoch; never rewrite mid-history; prefer a deep cut over frequent shallow ones; drive compaction by window pressure, not by turn count; never summarize a cold prefix deliberately.

## Known limitations

- The threshold and retained-tail policy on the desktop come from the preset's shipped engine. Manual `/compact` cuts deeper than automatic compaction (the shipped engine retains `0` for it).
- If the extraction call returns unverifiable quotes, the checkpoint falls back to deterministic structural rendering; if that cannot shrink the source, the shipped summarizer runs. Quality is therefore bounded by the extractor's citation discipline, and the certificate proves structure, not information-theoretic completeness.
- The prefix cache must still be warm for the extraction call to be cheap. A manual compaction minutes or hours after the last request pays a full read.
- The hook targets one specific shipped engine seam. It fails open, but a future Harness release that renames or relocates `summarize` would silently return to the shipped summarizer — check `hook.backendUsesHookedSummarize` after upgrades.
- The desktop preset still mounts the shipped tool-result pruner inside its isolated group. Real-session measurements show it is a net cache loss (≈1.1M miss-equivalent over three runs). Removing it means overriding the preset declaration (the option rejected in `docs/DESIGN.md` §3); this bundle intentionally does not do that.

## Development

```bash
npm run check   # syntax
npm test        # offline structural core + pipeline suite (30+ assertions, no Harness needed)
```

Layout:

```
lib/index.js            host half: engine hook, commands, accounting, diagnostics
lib/pipeline.js         extraction → structure → render pipeline (pure, testable offline)
lib/structure/core.js   stiffness assembly, KKT solve, static condensation, certificates
test/                   offline suites
docs/DESIGN.md          design notes: structural model, cache math, hook rationale
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the invariants a PR must keep.

## Security and privacy

No telemetry, no network calls of its own, no disk state. Loopback diagnostics are unauthenticated but content-free; `statusCommands: false` disables them. See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 2718Labs.
