# The bill: where compaction money actually goes

This isn't a paper. It's accounting I did on my own session logs. The tooling is in [`bench/`](../bench/README.md); run it on your logs and check the numbers yourself.

## The short version

Normal requests are cheap: the cache hit rate is 99.20% across 3,515 requests and 997M prompt tokens. But every shipped compaction makes the model re-read roughly **550,000 tokens of history** at fresh-input prices. 550k tokens is about a 400-page book. That's one book per compaction.

One session compacted three times. Together those compactions added about **5.3%** to that session's total input cost. With `deterministic` mode it would have been **1.2%**.

## The three compactions I measured

| turn | before prompt | summarizer call (cached / uncached / output) | after prompt | publication miss | total eq. | share of session input |
| --- | --- | --- | --- | --- | --- | --- |
| 22 | 726,882 | 0 / 552,771 / 4,124 | 189,833 | 179,977 | 733,734 | 1.77% |
| 47 | 724,803 | 9,856 / 562,954 / 5,059 | 171,536 | 161,680 | 726,605 | 1.76% |
| 83 | 729,572 | 9,856 / 549,132 / 3,206 | 180,230 | 170,374 | 721,477 | 1.74% |

"total eq." counts a cached read as 10% of a fresh read. The first request after a compaction has to re-read the new prefix, and no approach that changes history avoids that.

## Why it re-reads even when the cache is hot

I didn't believe the "cache expired" explanation, so I checked the request that came right before each compaction:

| turn | gap to previous request | previous request hit rate |
| --- | --- | --- |
| 22 | 12.8 s | 99.93% |
| 47 | 0.1 s | 99.85% |
| 83 | 1.1 s | 99.07% |

The cache was hot. Yet the summarization request only connected with the first 9,856 cached tokens and paid for the rest. It comes down to replay: at compaction time the harness rebuilds the history into a request and sends it to the model. That rebuilt request isn't identical to the request it actually sent, because part of the real request was assembled at request time and never made it into the session log. Where they diverge, the cache stops.

## I tried to make it cheaper and failed

My first idea was to make the extraction call reuse that cache. It doesn't work, for the reason above. So now there are two paths:

- Want the bill down: `deterministic`, no model call during compaction at all.
- Want the quality: `extract`, same cost as the shipped summarizer, no cheaper.

I'm not putting "saves 75%" in the README because it's only true for `deterministic`, which is a different trade-off.

## The three options

| Option | Model call | Extra input per automatic compaction | Relative | What comes out |
| --- | --- | --- | --- | --- |
| Shipped summarizer | one, re-reads ~550k | ~720k | 1× | model-written summary, no provenance |
| This plugin, `extract` | one, same re-read | ~720k | ≈1× | verbatim quotes + structural certificate |
| This plugin, `deterministic` | none | ~170k | ≈0.25× | structurally selected source text |

(`deterministic` publishes a slightly different amount than a shipped summary; treat these as the same order of magnitude.)

## The other half is quality

Cost is half the story. The other half: when a shipped summary drops a sentence, you can't tell.

| Question | Shipped summary | This plugin |
| --- | --- | --- |
| Can it quietly lose "the port is 8080"? | Yes, and nobody notices | Constraints are pinned as supports; publication is refused if one is dropped (tested) |
| Where did this sentence come from? | No idea, the model rewrote it | Every item must quote the source verbatim or it's discarded |
| What happens when compaction fails? | Throws; the session may end up with no checkpoint | Falls back to a local render, then to the shipped summarizer; there's always a checkpoint |
| Same input, same output? | Depends on the model | Yes, byte-identical |

Measured shipped summaries were 1,728 to 5,131 tokens of prose. This plugin's checkpoint has a budget (6,000 tokens by default) and only contains verifiable material.

## Two more numbers

**Pruning loses money.** The shipped preset still mounts the tool-result pruner. Three runs "saved" 141,041 tokens and cost 1,675,192 tokens of extra re-reading, about 12×. This compressor does no pruning.

**A manual compaction after idling is genuinely cold.** One `/compact` came 49 minutes after the last request; the summarizer call paid 331,799 uncached tokens. Nothing avoids that — the cache really had expired. I keep it separate from the avoidable 550k.

## Where these numbers come from

The Harness already writes session logs (`session*.jsonl.zstd`). The tooling reads usage records and compaction markers only, no message content, and hashes session names.

```bash
npm test                                   # 80 offline assertions, no Harness needed
node bench/report.mjs                      # account this machine's sessions
node bench/report.mjs <dir> --format md    # render the same tables
```

The tests also cover the contract: invented or paraphrased quotes are rejected; a dropped support is rejected; an ungrounded structure is reported singular; a checkpoint that can't shrink its source is rejected; extractor failure degrades to a zero-model render; `deterministic` never calls the model; identical atoms render byte-identically.

Once installed, `GET /compaction-continuum/selftest` tells you whether the hook is live, and `?test=extract` runs one synthetic extraction through it and reports `units=30 candidates=33 kept=33 certificate={...}`.

## Where this is weak

- The three automatic compactions come from one long session. Each event is measured, but that's the whole sample. If you have more logs, run the tool and post the numbers.
- `extract` costing "the same" is an argument, not an A/B: same replay, same publication. A real A/B would need to compact the same session twice, and compaction is one-way.
- `deterministic` is cheaper but worse than `extract`; it has no semantic extraction, only structural selection.
- "A cached read costs 10% of a fresh one" is a price assumption; change it with `--hit-ratio`.
- The fix that would make `extract` cheap is a byte-identical replay of the live request. It needs data the log doesn't have. It's on the roadmap, not in the code.

## Appendix

<details>
<summary>Field definitions and scope</summary>

- Cost unit: uncached input + 0.1 × cache read. Change the 0.1 with `--hit-ratio`.
- "Summarizer call" is the model usage recorded on the `compaction/summary` event.
- "Publication miss" is the uncached input of the first request after `compaction/end`.
- "Share of session input" = (summarizer call + publication) / the session's total input cost.
- One pruner run sits right before a compaction, so it can't be attributed; it's excluded.
- Session labels are hashes of the session directory name: stable on one machine, not comparable across machines.
- Sample: 25 sessions, 3,515 requests, 997,002,631 prompt tokens, 99.20% hit rate.
- Environment: DeepSeek Harness `0.2.1-rc.5` desktop, `deepseek-account` / `deepseek-flash`.

</details>
