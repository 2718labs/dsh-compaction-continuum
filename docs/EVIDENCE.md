# Evidence

This document answers one question: **why does a compacting harness need this backend rather than the shipped summarizer?** Everything below is reproducible from recorded session logs with the tooling in [`bench/`](../bench/README.md). No claim here depends on a benchmark we cannot share.

## TL;DR

Measured over **25 recorded sessions, 3,515 completed requests, 997,002,631 prompt tokens** on DeepSeek Harness `0.2.1-rc.5` desktop (provider `deepseek-account` / `deepseek-flash`, price model: cache hit = 0.1 × miss):

| Finding | Measured value |
| --- | --- |
| Steady-state prefix-cache hit rate | **99.20%** overall (per-session 95.2% – 99.7%) |
| Cost of one shipped automatic compaction | **~721k – 734k miss-equivalent** (3 events) |
| ↳ of which the summarizer call | **~549k – 563k uncached input** (cache read 0 – 9,856 tokens) |
| ↳ of which the publication re-read | ~162k – 181k miss-equivalent |
| Cache state of the request just before it | 99.07% – 99.93% cached, 0.1 – 12.8 s earlier |
| Tool-result pruning (3 runs) | freed 141,041 tokens, caused **1,675,192 miss-equivalent** of re-read |
| This plugin, `extract` mode | one call, same replay shape → **cost parity**, but certified/cited output |
| This plugin, `deterministic` mode | **no model call at all** → removes ~549k–563k per compaction (~4× cheaper on the measured events) |

The shipped summarizer's own replay does not reproduce the live request prefix: even immediately after a request that hit 99.85%, its summarization call matches only **9,856 tokens** (the system/tools head) and pays for the rest. That is the dominant cost of compaction, and it is the part this plugin makes optional.

## Method

- Input: the durable session logs the Harness already writes (`session*.jsonl.zstd`). Only `assistant/message` usage records and `compaction/*` marker events are read; no message content is analyzed except the published summary length.
- Cost unit: **miss-equivalent input tokens** = `uncachedInput + 0.1 × cacheRead`. Output tokens are reported separately.
- Compaction anatomy: for each `compaction/start`…`compaction/end` bracket, the last request before the start and the first request after the end. The summarizer call's own usage is recorded on `compaction/summary`; the publication re-read is that first request's uncached input.
- Pruning: contiguous `compaction/prune` markers grouped into runs; a run followed by a compaction before the next request is flagged and excluded (its delta would be misattributed).
- Session labels are hashes; no paths, ids or content appear in this document.

Reproduce:

```bash
# this machine's logs
node bench/report.mjs --format md

# any exported session directory
node bench/report.mjs <session-root> --format md
```

## 1. Baseline: the cache is the budget

| session | requests | prompt tokens | cached | uncached | hit rate |
| --- | --- | --- | --- | --- | --- |
| s-3e456bb3 | 874 | 387,283,144 | 384,347,520 | 2,935,624 | 99.24% |
| s-571cf6f7 | 371 | 121,480,662 | 121,145,472 | 335,190 | 99.72% |
| s-07b44f00 | 237 | 85,896,733 | 85,124,096 | 772,637 | 99.10% |
| s-6e5ce206 | 208 | 59,863,020 | 59,692,416 | 170,604 | 99.72% |
| s-f52bb728 | 171 | 29,906,043 | 29,691,520 | 214,523 | 99.28% |
| **all 25 sessions** | **3,515** | **997,002,631** | **989,058,176** | **7,944,455** | **99.20%** |

Long sessions live on the prefix cache. A backend that introduces a cache divergence pays for it directly; that is the constraint every design decision here is measured against.

## 2. The shipped compaction's dominant cost is a cold summarizing call

Three automatic compactions in one 874-request session:

| turn | before prompt | after prompt | freed | summarizer call (cached / uncached / output) | publication miss | total cost eq. | share of session input |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 22 | 726,882 | 189,833 | 537,049 | 0 / 552,771 / 4,124 | 179,977 | 733,734 | 1.77% |
| 47 | 724,803 | 171,536 | 553,267 | 9,856 / 562,954 / 5,059 | 161,680 | 726,605 | 1.76% |
| 83 | 729,572 | 180,230 | 549,342 | 9,856 / 549,132 / 3,206 | 170,374 | 721,477 | 1.74% |

The request immediately before each compaction was itself warm:

| turn | gap to previous request | previous request hit rate |
| --- | --- | --- |
| 22 | 12.8 s | 99.93% |
| 47 | 0.1 s | 99.85% |
| 83 | 1.1 s | 99.07% |

So the ~550k-token miss is **not** cache expiry. The summarizer request replays the durable conversation prefix, but the live request carried request-time material that the durable log does not reproduce; the cached part ends after the system/tools head (9,856 tokens), and everything after it is billed as fresh input. The same replay shape is used by this plugin's `extract` mode, so `extract` mode intentionally claims **cost parity, not savings**.

A second case, a manual `/compact` after an idle period, shows the other limiting factor — a genuinely expired cache:

| before prompt | after prompt | summarizer call (cached / uncached / output) | publication miss | total cost eq. | share of session input |
| --- | --- | --- | --- | --- | --- |
| 333,341 | 19,174 | 1,920 / 331,799 / 9,516 | 8,422 | 340,221 | 10.73% |

No backend can avoid a cold cache. The question a backend can answer is whether it needs that call at all.

## 3. What `deterministic` mode removes

The model call is the expensive, verifiable-to-be-cold part. With `mode: deterministic` the compressor performs **zero model calls** and publishes a structurally selected, verbatim checkpoint. On the measured automatic compactions that removes the 549k–563k uncached summarizer input and leaves only the publication re-read:

| mode | model call | publication | total per auto compaction | vs shipped |
| --- | --- | --- | --- | --- |
| shipped summarizer | ~549k–563k uncached | ~162k–181k | ~721k–734k | 1.00× |
| continuum `extract` | same replay shape (cold by structure) | ~162k–181k | ~721k–734k | ~1.00× |
| continuum `deterministic` | **none** | ~162k–181k (+ checkpoint size delta) | **~165k–185k** | **~0.25×** |

This is the honest economic case: the plugin's cost advantage is not a smarter summarizer, it is **making the summarizer optional**.

## 4. Why not prune instead

The desktop preset also mounts the shipped tool-result pruner. Three attributed runs in the same session:

| seq range | prune markers | shadowed tokens | freed | next-request miss | publication cost eq. |
| --- | --- | --- | --- | --- | --- |
| 2828–2858 | 16 | 73,256 | 72,475 | 629,037 | 631,443 |
| 5226–5246 | 11 | 39,346 | 36,174 | 493,166 | 512,814 |
| 7314–7334 | 11 | 37,336 | 32,392 | 512,797 | 530,935 |
| **total** | 38 | 149,938 | **141,041** | — | **1,675,192** |

Freeing 141k tokens cost 1.68M miss-equivalent — the cache divergence is ~12× the freed tokens even before pricing the freed tokens as future cache hits. This compressor adds no pruning for that reason. (A fourth marker run at 7449–7451 sits before a compaction and is excluded rather than misattributed.)

## 5. What the plugin does publish, and how that is verified

The measured economics make the model call optional; the checkpoint content is what makes the backend worth using at all.

| property | shipped summarizer | this plugin |
| --- | --- | --- |
| checkpoint content | free prose, 3,459 / 2,460 / 1,728 / 5,131 tokens in the measured runs | quoted atoms + structurally selected text, budget-bounded |
| provenance | none | every atom must quote its source verbatim; unverifiable atoms are rejected |
| anchors and open loops | may be dropped silently | pinned as supports; publication is refused if one is lost |
| determinism | model-dependent | deterministic renderer; same atoms produce byte-identical text |
| no-model option | — | `mode: deterministic` |
| failure behavior | throws; no checkpoint | structural → deterministic → shipped summarizer |
| audit | none | audit JSON is part of the published summary event; `/context_status` reports it |

Contract evidence (all offline, no Harness required — `npm test`):

- 80 assertions across the structural core, the pipeline, and the benchmark harness.
- Rejection tests: a paraphrased or invented quote is rejected; a dropped support is rejected; a structure that cannot be grounded is reported singular; a checkpoint that does not shrink its source is rejected.
- Fail-open tests: garbage extraction degrades to deterministic rendering; a throwing extractor degrades too; `deterministic` mode never calls the model; the same atoms render byte-identically.
- Live self-test (`GET /compaction-continuum/selftest`): the preset-plane backend reports `backendUsesHookedSummarize: true`, and `?test=extract` runs one real synthetic summarization through it:
  `units=30 candidates=33 kept=33 certificate={"supportsPreserved":true,"selectionConsistent":true,"condensationExact":true,"reconstructionError":0}`.

## 6. Limitations

- The three automatic compactions come from **one** long session. The per-event figures are measurements; the "~4× cheaper in deterministic mode" figure is their arithmetic consequence, not a second experiment.
- `extract` mode's parity is a structural claim (same replay, same publication), not a claim that it was measured on a live A/B — compaction is a one-way operation per session, so a true A/B would require two runs of the same session.
- The price model `hit = 0.1 × miss` matches the provider's published cache discount; change `--hit-ratio` to re-run with another assumption.
- Publications are unavoidable for any compaction: replacing history changes the prefix. Only the *size* of the publication and the *model call* are controllable.
- The root cause of the cold summarizer call is inferred from the measurement (the cached prefix ends at the system/tools head); the exact request-time material that diverges is not durable and therefore not recoverable. Making the extraction request byte-identical to the live request is a roadmap item.

## 7. Reproduce

```bash
npm test                    # 80 offline assertions, no Harness needed
node bench/report.mjs       # this machine's scheduled sessions
node bench/report.mjs <dir> --format md   # tables as rendered here
node bench/report.mjs --format json       # raw data
```

See [`bench/README.md`](../bench/README.md) for field definitions and the zstd/Node requirement.
