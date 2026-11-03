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

The shipped compaction engine still owns everything durable — the bracket, the lock, the overflow recovery, the retained tail and the replay. This plugin replaces only how the checkpoint content is produced.

## Why this exists (measured)

Compaction is rare, but the shipped one is expensive in a way that is easy to miss: it makes the model **re-read about 550,000 tokens of history at full price** — even when the cache is hot.

| Case | Extra input cost | Relative |
| --- | --- | --- |
| Shipped automatic compaction, once | ~720,000 tokens (≈550k avoidable re-read + ~170k unavoidable publication) | 1× |
| This plugin, `deterministic` mode | ~170,000 tokens (no model call at all) | **~0.25×** |
| This plugin, `extract` mode | ~720,000 tokens | ~1×, but cited and certified |

The second half is quality, and it is the main point: the shipped output is free-form prose with no provenance. This plugin publishes only material traceable to a verbatim source quote, pins constraints and anchors so publication is refused when one would be lost, and always leaves a session with a checkpoint.

Why can't the shipped call use the cache? The request right before each measured compaction hit 99.07%–99.93% and was 0.1–12.8 s old, yet the summarizer request matched only the first 9,856 cached tokens. A replay cannot reproduce request-time material the durable log does not record. `extract` mode shares that replay, so it claims **parity, not savings**.

Full tables, method and honest limitations: [docs/EVIDENCE.md](./docs/EVIDENCE.md). Reproduce on your own logs with `node bench/report.mjs`.

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

The extraction call replays the session's own durable prefix — same system prompt, same tool catalog, same logged history, with only the instruction appended — and never switches models or adds a summarizer-specific system prompt. Measured caveat: the live request contains request-time material the durable log does not record, so the cached part of this replay ends after the system/tools head (0 – 9,856 of ~550k tokens in the measured runs). That is why `extract` mode claims cost parity, not savings, and why the zero-model `deterministic` mode exists.

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

## Cache economics (details)

The full method, per-event tables and caveats live in [docs/EVIDENCE.md](./docs/EVIDENCE.md). Short version, measured on the shipped backend:

| Observation | Value |
| --- | --- |
| Steady-state cache hit rate (25 sessions / 3,515 requests / 997M prompt tokens) | 99.20% |
| Cost of one shipped automatic compaction | ~720k extra input tokens: ~550k a summarizer re-read that could be avoided + ~170k the re-read any rewrite pays |
| Summarizer call in those events | matched only 0–9,856 cached tokens of its ~550k prompt, despite a 99%+ hot request 0.1–12.8 s earlier |
| Manual `/compact` after a long idle | summary call paid 331,799 uncached tokens (cache really expired — unavoidable) |
| Replay vs. the durable surface projection | identical (`live=399 replayed=399`); it diverges from the *live request*, not from the log |
| Tool-result pruning (`tool-result-pruner`) | freed 141,041 tokens, caused 1,675,192 tokens of re-read (~12×) — why this compressor adds no pruning (the desktop preset still mounts the shipped pruner, which this plugin does not control) |

("Extra input tokens" counts cached reads at 10% of a fresh read, matching the provider's documented cache discount; change it in `bench` with `--hit-ratio`.)

Hard rules the implementation keeps: one publication per epoch; never rewrite mid-history; prefer a deep cut over frequent shallow ones; drive compaction by window pressure, not by turn count; never summarize a cold prefix deliberately; make the summarizing call optional.

## Known limitations

- The threshold and retained-tail policy on the desktop come from the preset's shipped engine. Manual `/compact` cuts deeper than automatic compaction (the shipped engine retains `0` for it).
- If the extraction call returns unverifiable quotes, the checkpoint falls back to deterministic structural rendering; if that cannot shrink the source, the shipped summarizer runs. Quality is therefore bounded by the extractor's citation discipline, and the certificate proves structure, not information-theoretic completeness.
- The extraction call cannot currently reuse the live request prefix: the measured replay hits only the system/tools head, so `extract` mode is cost parity with the shipped summarizer. `deterministic` mode avoids the call entirely. Making the replay byte-identical to the live request is a roadmap item (docs/DESIGN.md §7).
- The hook targets one specific shipped engine seam. It fails open, but a future Harness release that renames or relocates `summarize` would silently return to the shipped summarizer — check `hook.backendUsesHookedSummarize` after upgrades.
- The desktop preset still mounts the shipped tool-result pruner inside its isolated group. Real-session measurements show it is a net cache loss (≈1.1M miss-equivalent over three runs). Removing it means overriding the preset declaration (the option rejected in `docs/DESIGN.md` §3); this bundle intentionally does not do that.

## Development

```bash
npm run check   # syntax
npm test        # offline: structural core + pipeline + bench harness (80 assertions, no Harness needed)
```

Layout:

```
lib/index.js            host half: engine hook, commands, accounting, diagnostics
lib/pipeline.js         extraction → structure → render pipeline (pure, testable offline)
lib/structure/core.js   stiffness assembly, KKT solve, static condensation, certificates
bench/                  reproducible cache/compaction accounting over recorded session logs
test/                   offline suites
docs/DESIGN.md          design notes: structural model, cache constraints, hook rationale
docs/EVIDENCE.md        measured evidence: baseline, compaction anatomy, pruner cost, contracts
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the invariants a PR must keep.

## Security and privacy

No telemetry, no network calls of its own, no disk state. Loopback diagnostics are unauthenticated but content-free; `statusCommands: false` disables them. See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 2718Labs.
