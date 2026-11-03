# Measurement report: cost structure of context compaction

This report records 2718Labs' measurements of context-compaction cost in DeepSeek Harness. The object of measurement is the shipped compaction backend (`@deepseek-ai/dsh-compaction-basic`); the purpose is to determine the cost structure and to inform the design of this plugin. All figures can be recomputed from session logs with the tooling in [`bench/`](../bench/README.md).

## Summary

- Sample: 25 sessions, 3,515 requests, 997,002,631 prompt tokens; steady-state prefix-cache hit rate 99.20%.
- Each automatic compaction by the shipped backend reads approximately 720,000 additional input tokens: about 550,000 from the summarizer's re-read of history and about 170,000 from the re-read that follows any rewrite.
- The re-read is not caused by cache expiry. The request preceding each of the three measured compactions hit 99.93%, 99.85% and 99.07% of its prompt, 12.8 s, 0.1 s and 1.1 s earlier respectively; the summarizer request itself matched only 0 to 9,856 tokens.
- This plugin's `deterministic` mode performs no model call and skips the approximately 550,000-token re-read; `extract` mode performs one model call at approximately the same cost as the shipped backend.
- The three compactions together account for 5.3% of that session's input cost. With `deterministic` mode the figure would be 1.2%.
- Tool-result pruning in the same session freed 141,041 tokens and forced 1,675,192 additional tokens of reading.

## 1. Objective and scope

The measurement answers three questions:

1. What composes the input cost of a long session;
2. At which step the extra cost of shipped compaction is incurred;
3. Whether an alternative path exists that does not reduce compression quality.

The measurement covers desktop Harness session logs only and makes no subjective judgement of model output quality. Quality is addressed through contract tests and the certificate mechanism, described in section 7.

## 2. Data and method

- Source: session logs persisted by Harness (`session*.jsonl.zstd`, format versions v2 to v4).
- Read scope: `usage` on `assistant/message` events; `compaction/start`, `compaction/summary`, `compaction/end` and `compaction/prune` markers. Message content is not read; summaries contribute only their character length, used to estimate publication size.
- Session identifiers: the first 8 hex digits of SHA-256 over the session directory name, shown as `s-xxxxxxxx`. Stable on one machine, not comparable across machines.
- Cost unit: miss-equivalent input tokens, defined as `uncached input + 0.1 × cache read`. The 0.1 factor models the provider's published cache-read discount and is adjustable with `--hit-ratio`.
- Compaction cost: for each `compaction/start` to `compaction/end` bracket, the nearest request before the start and the first request after the end. Summarizer usage is read from the `compaction/summary` event; publication cost is the uncached input of that first request after the end.
- Pruning cost: contiguous `compaction/prune` markers form one run; the nearest request before the run and the first request after the last marker. A run adjacent to a subsequent compaction cannot be attributed and is excluded.
- Environment: DeepSeek Harness `0.2.1-rc.5` desktop; provider `deepseek-account`, model `deepseek-flash`.

## 3. Baseline

| session | requests | prompt tokens | cache read | uncached | hit rate |
| --- | --- | --- | --- | --- | --- |
| s-3e456bb3 | 874 | 387,283,144 | 384,347,520 | 2,935,624 | 99.24% |
| s-571cf6f7 | 371 | 121,480,662 | 121,145,472 | 335,190 | 99.72% |
| s-07b44f00 | 237 | 85,896,733 | 85,124,096 | 772,637 | 99.10% |
| s-6e5ce206 | 208 | 59,863,020 | 59,692,416 | 170,604 | 99.72% |
| s-f52bb728 | 171 | 29,906,043 | 29,691,520 | 214,523 | 99.28% |
| total (25 sessions) | 3,515 | 997,002,631 | 989,058,176 | 7,944,455 | 99.20% |

Input cost in long sessions is carried mainly by the cache. Any compaction scheme that introduces a prefix divergence increases uncached input directly.

## 4. Automatic compaction cost

Three automatic compactions in session s-3e456bb3:

| turn | before prompt | summarizer call (cached / uncached / output) | after prompt | publication miss | total miss-equivalent | share of session input |
| --- | --- | --- | --- | --- | --- | --- |
| 22 | 726,882 | 0 / 552,771 / 4,124 | 189,833 | 179,977 | 733,734 | 1.77% |
| 47 | 724,803 | 9,856 / 562,954 / 5,059 | 171,536 | 161,680 | 726,605 | 1.76% |
| 83 | 729,572 | 9,856 / 549,132 / 3,206 | 180,230 | 170,374 | 721,477 | 1.74% |

The three events total 2,181,816 miss-equivalent, or 5.27% of that session's input cost. Of this, 512,031 uncached tokens of publication cost are unavoidable for any scheme that rewrites history; the 1,666,828 miss-equivalent of summarizer calls is the controllable part examined here.

## 5. Attribution

To rule out cache expiry, the request immediately preceding each compaction was inspected:

| turn | gap to preceding request | hit rate of that request |
| --- | --- | --- |
| 22 | 12.8 s | 99.93% |
| 47 | 0.1 s | 99.85% |
| 83 | 1.1 s | 99.07% |

The cache was valid. The summarizer request matched 0 to 9,856 tokens, which places the prefix divergence after that point.

Additional check: at compaction time the replayed durable-surface projection matches the runtime projection (self-test output `live=399 replayed=399 identical=true`). The divergence is therefore not in how the durable log is reconstructed; it is in the **live request**. The request actually sent contains request-time material that was never written to the log, and a replay cannot reproduce it.

Conclusion: for any replay-based summarization, the summarizer call cannot reuse the pre-compaction cache and costs approximately one full prompt read. This applies to the shipped backend and to this plugin's `extract` mode alike.

## 6. Mode comparison

| mode | model call | additional input per automatic compaction | relative | published content |
| --- | --- | --- | --- | --- |
| shipped summarizer | one, re-reads ~550k | ~720k | 1× | model-written summary, no provenance |
| this plugin, `extract` | one, same re-read | ~720k | ≈1× | verbatim quotes + structural certificate |
| this plugin, `deterministic` | none | ~170k | ≈0.25× | structurally selected source text |

Publication size in `deterministic` mode differs from a shipped summary; the table treats them as the same order of magnitude. The cost of that mode is the absence of semantic extraction, which lowers compression quality relative to `extract`.

## 7. Quality constraints on published content

Beyond cost, the plugin imposes testable constraints on what is published:

| constraint | shipped summary | this plugin |
| --- | --- | --- |
| Detectability of a dropped critical constraint | none | constraints and anchors are pinned as supports; publication is refused if one is lost (tested) |
| Traceability of content | none | every item must quote the source verbatim; unlocatable items are discarded |
| Behaviour on compaction failure | throws; a session may end up without a checkpoint | three-level fallback: structural → local render → shipped summarizer |
| Render determinism | model-dependent | byte-identical for identical input |

Measured shipped summaries are 1,728 to 5,131 tokens long. This plugin's checkpoint is bounded by `checkpointMaxTokens` (default 6,000) and contains only verifiable material.

The offline suite contains 80 assertions covering: rejection of invented and paraphrased quotes, rejection of lost supports, reporting of ungrounded structures, rejection of checkpoints that cannot shrink the source, degradation on extractor failure, absence of model calls in `deterministic` mode, and byte-identical rendering.

## 8. Additional observations

Tool-result pruning in the same session, excluding one run adjacent to a compaction:

| seq range | markers | freed tokens | next request miss | cost equivalent |
| --- | --- | --- | --- | --- |
| 2828–2858 | 16 | 72,475 | 629,037 | 631,443 |
| 5226–5246 | 11 | 36,174 | 493,166 | 512,814 |
| 7314–7334 | 11 | 32,392 | 512,797 | 530,935 |
| total | 38 | 141,041 | — | 1,675,192 |

Manual compaction after idle (session s-f52bb728):

| before prompt | summarizer call (cached / uncached / output) | publication miss | total miss-equivalent | share of session input |
| --- | --- | --- | --- | --- |
| 333,341 | 1,920 / 331,799 / 9,516 | 8,422 | 340,221 | 10.73% |

In this case the cache had genuinely expired (about 49 minutes since the preceding request). The cost is not avoidable and is reported separately from the figure in section 4.

## 9. Uncertainty and limitations

- The three automatic compactions all come from one long session. Individual events are measured; the sample is limited, and cross-session extrapolation is inference.
- The cost parity of `extract` mode is a structural argument (same replay, same publication), not an A/B comparison on one session. Compaction is one-way per session, so a direct A/B is not possible.
- The price assumption (cache read at 10% of a miss) is adjustable, and changing it affects every derived figure in this report.
- The exact divergence point between the summarizer request and the live request is inferred; the live request body was not captured, because the log does not record request-time content.
- Reusing the cache for the extraction call requires a request body byte-identical to the live request. This is not implemented.

## 10. Reproduction

```bash
npm test                                   # 80 offline assertions, no Harness installation required
node bench/report.mjs                      # account this machine's sessions
node bench/report.mjs <dir> --format md    # render tables in the same format as this report
node bench/report.mjs --format json        # raw data
```

## Appendix: definitions

- **Summarizer call**: model usage recorded on the `compaction/summary` event, including cache read, uncached input and output tokens.
- **Publication miss**: uncached input of the first request after `compaction/end`. Unavoidable for any scheme that rewrites history.
- **Total miss-equivalent**: sum of the summarizer call and publication miss-equivalent input.
- **Share of session input**: total miss-equivalent divided by the session's miss-equivalent input across all requests.
- **Freed tokens**: sum of `shadowedTokenCount` across the `compaction/prune` markers in a run.
