# Measurement report: cost structure of context compaction

This report records 2718Labs' measurements of context-compaction cost in DeepSeek Harness. The object of measurement is the shipped compaction backend (`@deepseek-ai/dsh-compaction-basic`); the purpose is to determine the cost structure and to inform the design of this plugin. All figures can be recomputed from session logs with the tooling in [`bench/`](../bench/README.md).

## Summary

| Observation | Measured value |
| --- | --- |
| Sample | 25 sessions, 3,515 requests, 997,002,631 prompt tokens |
| Steady-state prefix-cache hit rate | 99.20% |
| Additional input per shipped automatic compaction | approximately 720,000 tokens (about 550,000 for the summarizer call, about 170,000 for the publication re-read) |
| Cache state of the request preceding each compaction | 99.93% / 99.85% / 99.07% hit, 12.8 s / 0.1 s / 1.1 s earlier |
| Cache hit of the summarizer request | 0 to 9,856 tokens |

This cache behavior follows from a difference between the replayed request and the request actually sent: content assembled at request time is not in the session log, so a replay cannot reproduce it. The constraint applies to any replay-based summarizer and is not a functional defect of the shipped backend.

- This plugin's `deterministic` mode performs no model call and skips the approximately 550,000-token re-read; `extract` mode performs one model call at approximately the same cost as the shipped backend.
- The three compactions together account for 5.3% of that session's input cost. With `deterministic` mode the figure would be 1.2%.
- Tool-result pruning in the same session freed 141,041 tokens and forced 1,675,192 additional tokens of reading.

## Plugin-installed measurement

The figures below were measured after installing this plugin; the object of measurement is the plugin's compressor. Precondition: the self-test reports `backendUsesHookedSummarize: true`.

| Observation | Measured value |
| --- | --- |
| Replayed span | 366 messages (system + 365 shadowed nodes), 41 tools |
| Extraction call | 333,184 cached input / 468 uncached input / 9,954 output tokens |
| Extraction duration | 47.6 s |
| Structural compile | 365 candidates, 46 retained |
| Checkpoint | 2,243 characters, approximately 1,121 tokens (audit recorded 1,076 tokens) |
| Certificate | supports preserved, selection consistent, condensation reconstructs — all true; reconstruction error 0 |
| Fallbacks | none |
| Shipped summary for the same span (reference) | 20,011 characters, approximately 5,131 tokens |

These figures were measured on v0.3.0, before verbatim retention became the default. From v0.5.0 the published checkpoint also carries the retention block (real user requests and recent units up to `verbatimTokens`), so published size is larger by that block; the extraction and structural figures above are unchanged.

Method and limitations:

- This is a replay measurement: the most recent recorded compaction span in the session is rebuilt and passed through one `summarize` call, reporting actual usage and output without publishing anything. Publication cost — the re-read of the new prefix by the first request after a real compaction — is therefore not included.
- The replays prefix matched a provider cache entry (333,184 tokens) because that prefix had been sent by real requests before; whether it remains valid depends on the provider's retention policy. With a cold cache the call costs approximately one full prompt read.
- Publication cost is measured after a real compaction: run `/compact`, then `node bench/report.mjs`; the event whose `backend` column reads `continuum` is the plugin's real record.
- Reproduction: `Invoke-RestMethod 'http://127.0.0.1:<port>/compaction-continuum/selftest?test=replay'`. The call reads the recorded compaction span from the session and sends it to the model; confirm that this data may be sent before running it.

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

Conclusion: for any replay-based summarization, the summarizer call cannot reuse the pre-compaction cache and costs approximately one full prompt read. The constraint applies to the shipped backend and to this plugin's `extract` mode alike, and is not a functional defect of the shipped backend. The shipped backend's remaining flow — transaction, lock, overflow recovery, retained tail and replay — is preserved unchanged by this plugin.

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
| Continuation anchor for the successor | a model-written "Next Step" section, no structural guarantee | an extracted `next_step` atom pinned as a support, else a verbatim floor naming the latest request; recorded as `nextStepAnchored` (tested across three successive generations) |
| Verbatim continuation of user intent | none; all content is model-written | real user requests are copied from the source under a budget; the certificate records `userMessagesVerbatim` |
| Behaviour on compaction failure | throws; a session may end up without a checkpoint | three-level fallback: structural → local render → shipped summarizer |
| Render determinism | model-dependent | byte-identical for identical input |

Measured shipped summaries are 1,728 to 5,131 tokens long. This plugin's structural checkpoint is bounded by `checkpointMaxTokens` (default 6,000) and contains only verifiable material; the published checkpoint additionally carries a verbatim retention block bounded by `verbatimTokens` (default 20,000) and clamped to keep the checkpoint smaller than its source.

The offline suite contains 110 assertions covering: rejection of invented and paraphrased quotes, rejection of lost supports, reporting of ungrounded structures, rejection of checkpoints that cannot shrink the source, degradation on extractor failure, absence of model calls in `deterministic` mode, byte-identical rendering, continuation anchoring across three successive compaction generations, and verbatim retention of the user requests across those generations.

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
npm test                                   # 110 offline assertions, no Harness installation required
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
