# Design notes

This document explains the model behind the compressor, the cache constraints that shaped it, and why it attaches to the host the way it does.

## 1. The premise: compaction is a structural problem

A summarizer is asked to decide what matters. That is a judgement call: it rewrites, paraphrases, drops detail, and cannot be audited. This project treats the question as a mechanics problem instead:

- The span to compress is a **structure**.
- Each candidate block is a **degree of freedom (DOF)**.
- Evidence coupling between blocks is **stiffness**.
- The current request is the **load**.
- Facts that may never be dropped — exact anchors, open loops, explicit constraints — are **supports** (fixed DOFs).
- Compression is a **static condensation**: keep the DOFs that carry the response, eliminate the rest, and prove the eliminated part does not change the response.

The model is therefore restricted to extraction: it may only propose atoms together with a verbatim quote and a source unit. Every quote is verified as a substring of the replayed source; unverifiable atoms are discarded. The model never writes checkpoint prose, so the published text is always traceable.

### Model mapping

| Mechanics | Context meaning |
| --- | --- |
| coordinate / DOF | candidate block (extracted atom, or a message unit in deterministic mode) |
| element `w·(e_a − e_b)(e_a − e_b)ᵀ` | evidence relation between two blocks with weight `w` |
| stiffness `K` | assembled from evidence weights (shared source `1.0`, same capsule `0.75`, adjacency `0.5`, same kind `0.25`, same slot `0.125`; in the shipped pipeline: shared source unit `1.0`, adjacency `0.5`, same kind `0.25`) |
| load `f` | activation of each block by the current request text (lexical Jaccard overlap) |
| supports / constraints `C u = d` | anchors and open loops pinned with `fix_one` |
| response `u` | how much each block carries the request |
| static condensation | keep load-bearing DOFs, eliminate the rest, derive reconstruction operator |
| certificate | supports preserved, selection consistent, condensation reconstructs the full response |

### Solve

With supports pinned, the equilibrium is the KKT system

```
[ K  Cᵀ ] [ u ]   [ f ]
[ C   0 ] [ λ ] = [ d ]
```

The implementation assembles `K` as a weighted Laplacian (no diagonal regularisation: an ungrounded component is singular and is reported as such), grounds components that have no support at their most activated member, and solves with LU partial pivoting.

Guyan condensation of the retained set `R` and eliminated set `E`:

```
K_RR' = K_RR − K_RE K_EE⁻¹ K_ER
f_R'  = f_R  − K_RE K_EE⁻¹ f_E
reconstructionOperator = −K_EE⁻¹ K_ER
reconstructionOffset   =  K_EE⁻¹ f_E
```

The certificate re-solves the full structure and compares it against the response reconstructed from the condensed one; `reconstructionError` must be zero (within `1e-8`). The selection certificate additionally requires that the least load-bearing kept coordinate is at least as load-bearing as the most load-bearing dropped one.

What the certificate does **not** prove: information-theoretic completeness. That comes from two other mechanisms — the quote-substring extraction contract (nothing enters the checkpoint unless it appears verbatim in the source) and the retained tail of the shipped engine (recent history is kept verbatim, not compressed).

## 2. Cache constraints

Providers cache prompt prefixes. A request pays full price for the longest common prefix with a recently seen request; everything after the first divergence is charged as input. The compaction backend materially affects this:

- Any publication replaces part of the surface. The next request therefore diverges at the publication point and re-reads the new prefix once.
- A summarizer that runs with its own system prompt, or on a different model, diverges at token zero and pays for the whole prompt.
- Rewriting history repeatedly per turn multiplies that cost; measured simulations showed per-turn rewriting collapsing the steady-state hit rate to ~13% and roughly doubling effective input cost.

The shipped engine already has the right shape: it replays the conversation prefix and appends the instruction as the final user message. This plugin keeps that shape and only replaces the summarizer's job with extraction. It also keeps the strict policy:

| Rule | Reason |
| --- | --- |
| one publication per epoch | a second publication pays a second full re-read |
| never rewrite mid-history | divergence point moves closer to the start |
| prefer a deep cut | one big re-read is cheaper than several small ones |
| pressure-driven, not turn-driven | a turn counter keeps rewriting a warm prefix |
| never summarize a cold prefix on purpose | after a long idle period the cache is already gone; always check the gap first |
| no pruning in this compressor | measured tool-result pruning freed tens of thousands of tokens but caused ~1.1M miss-equivalent over three runs; the desktop preset still ships its own pruner, which this plugin does not control |

Measured on real sessions (27 sessions, 4400+ requests): steady-state hit rate 99.1%–99.7%; one publication costs one full re-read of the new prefix; a manual compaction after a 49-minute idle gap paid 331,799 uncached input tokens because the provider cache had expired — a cost no design avoids.

The replay contract is checked at runtime: `projection alignment` in the self-test compares the compaction replay against the durable surface projection, and it is identical (`live=399 replayed=399 identical=true`).

**But identity with the durable projection is not identity with the live request.** Measured on three automatic compactions in one long session: the request immediately before compaction was 99.07%–99.93% cached (0.1–12.8 s earlier), yet the summarizer call matched only 0–9,856 tokens of its ~550k prompt — the cached prefix ends after the system/tools head, then diverges because the live request carried request-time material the durable log does not reproduce. Consequences:

- Any replay-based summarizer pays a near-full prompt read per compaction (~549k–563k uncached in the measured runs, in addition to the ~162k–181k publication re-read).
- This backend therefore keeps the model call **optional**: `deterministic` mode removes it (measured events → ~4× cheaper overall), while `extract` mode claims cost parity and spends the call on a certified, cited checkpoint instead of prose.
- Making the replay byte-identical to the live request would turn the extraction call nearly free. It requires capturing the request-time envelope, which is not durable today; it is a roadmap item.

See [`EVIDENCE.md`](./EVIDENCE.md) for the tables and method.

## 3. Why the prototype hook

The desktop app composes the compaction backend in the **agent-preset plane**: each preset declares

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
```

with a shipped `@deepseek-ai/dsh-compaction-basic` inside. Isolation means a Host-plane `compaction` provider is invisible to the engine that compacts a session, and a plugin in the Host plane cannot reach into a preset declaration.

Three options were considered:

1. **Mount a second `compaction` provider in the Host plane.** It works only for compositions without presets; on the desktop it is inert. This is what the plugin does *in addition* to the hook, for non-desktop use.
2. **Override every shipped preset declaration** and restate its entire plugin list with the backend swapped. Supported by the bundle patch dialect, but it duplicates four presets (standard, ptc, minimal, cordis), pins their whole plugin lists to this repository, and silently goes stale when the app updates. Rejected as maintenance debt.
3. **Replace the shipped engine's single documented hook** — `BasicCompactionEngine.prototype.summarize` — which is dispatched dynamically by `regionDependencies()` on every compaction. One method, both planes, all instances, reversible on unload, and the engine keeps owning the transaction, lock, overflow recovery, retained tail and replay.

The plugin takes option 3, plus option 1 for non-desktop compositions. If the shipped class ever loses that method, the plugin's compressor is never called, the shipped summarizer runs, and the self-test reports `backendUsesHookedSummarize: false`.

## 4. Pipeline shape

```
lib/pipeline.js
  segmentMessages(input.messages)      head (system) + units
  callModel(EXTRACTION_INSTRUCTION)    one call; returns {text, provider, model, maxTokens, usage}
  validateAtoms(json, units)           quote must be a substring; most recent unit wins
  selectKeepers({items, queryText, supports, ...})
    relations → assembleStiffness → load → solveConstrained → scores
    keep supports + score ≥ threshold·maxScore, top-up to minKeep, close dependency groups
  renderCheckpoint(items, kept, budget)  deterministic sections; Next Step laid out first
  buildVerbatimRetention(units, budget)  verbatim user requests → recent units
  recall hint (optional)                 ## Recall (exact original)
  certificate checks + shrink check
  (lib/index.js, host half)
  collectRetainedImages(input.messages)  image blocks spliced into the checkpoint message
```

Deterministic mode skips extraction entirely: message units themselves become the coordinates, with kinds inferred from role and content. It performs zero model calls, so it is suitable for privacy-constrained or cost-constrained profiles; quality is lower because no semantic atoms exist.

### Continuity layers

A checkpoint must let the successor continue, and must not accumulate completed work forever. Five layers bound that lifecycle:

- **Next Step.** The extractor supplies a `next_step` atom, pinned as a support; if it declines, a deterministic floor quotes the latest real request (or the latest assistant state). Certificate: `nextStepAnchored`.
- **Verbatim retention.** Real user requests are copied uncompressed, newest first, followed by recent non-user units, under `verbatimTokens`. The block is clamped so the checkpoint still shrinks its source. Certificate: `userMessagesVerbatim`.
- **Carried anchors.** Fresh anchors from the previous checkpoint are carried once into `## Carried Anchors (older)` and pinned; the next generation releases them unless fresh extraction re-evidences them, so a stale pin lives about two generations. Certificate: `carriedAnchorsPreserved`.
- **Release.** The extraction instruction requires dropping completed steps, fixed errors, resolved tasks and finished requests. Retention drops the oldest under pressure; retained images are capped newest-first. Released material stays in the durable log.
- **Recall and images.** `context_recall` searches or reads the calling agent's durable events on demand, and the checkpoint carries a hint to it; non-offloaded image blocks are spliced into the checkpoint message (bounded by `maxRetainedImages`) rather than replaced by a placeholder.

## 5. Failure modes

| Failure | Behavior |
| --- | --- |
| extractor unavailable / truncated / non-JSON | deterministic render, `audit.extractionError` records why |
| too few verified atoms (< 4) or acceptance ratio < 0.75 | deterministic render |
| singular structure (no grounding) | grounded at the most activated member; if still singular, fail |
| certificate fails | refuse publication, fall through |
| checkpoint cannot shrink the source | fall through |
| anything else thrown | shipped summarizer |

`mode: off` skips all of this and calls the shipped summarizer directly. Unloading restores the prototype method.

## 6. Costs

- Extraction: one model call of at most `extractorMaxTokens` output. Its input is the replayed durable prefix, which — measured — only matches the live request up to the system/tools head, so treat it as a cold call unless the live envelope can be reproduced (see §2).
- Dispatched checking: `deterministic` mode performs no model call at all; on the measured automatic compactions that is the difference between ~721k–734k and ~165k–185k miss-equivalent per compaction.
- Arithmetic: O(n³) LU on at most 48 candidates — sub-millisecond, no network, deterministic.
- Accounting: per-session counters in memory only; no persistence, lost on restart.
- Checkpoint size: the structural index is bounded by `checkpointMaxTokens`; verbatim retention adds up to `verbatimTokens` on top, so a near-lossless publication is roughly 20k tokens larger than the v0.3 measurement and the one-time publication re-read grows with it. `verbatimTokens: 0` restores the compression-first size.

## 7. Roadmap

- Capture the exact live request envelope so the extraction request can hit the provider cache instead of paying a cold read.
- Let the plugin state its retention preference for the preset-owned engine instead of inheriting the shipped default.
- Relation weights learned from observed publication cost instead of fixed constants.
- Checkpoint budget adaptation from the measured re-read cost.
- Richer extraction kinds and a stricter quote parser (reject quotes that only match after normalisation).
- Re-evidence scoring for carried anchors instead of the one-generation expiry rule.
- Attachment resolution for images that fall outside the retained set.
