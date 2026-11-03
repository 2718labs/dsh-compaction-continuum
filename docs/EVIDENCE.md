# Evidence: why this plugin exists (plain version)

> Conclusions first, then numbers, then how to reproduce them. Technical readers can jump to the appendix at the end.

## In one sentence

Every shipped compaction makes the model **re-read about 550,000 tokens of history at full price**, which is money that does not need to be spent (measured: the cache does not connect). This plugin either makes that call optional (`deterministic`: zero model calls) or spends it on a **verifiable checkpoint** (`extract`) instead of prose nobody can audit.

## Three numbers

| Case | Extra input cost (tokens) | What it means |
| --- | --- | --- |
| Shipped automatic compaction, once | **~720,000** | ~550,000 is a re-read of history that could be avoided; ~170,000 is the unavoidable re-read after publishing |
| This plugin, `deterministic` mode | **~170,000** | no model call at all → about **4× cheaper** |
| Three compactions in one session | **5.3% of that session's input cost** | `deterministic` brings it down to **1.2%** |

> In human terms: 550,000 tokens is roughly a 400-page book. "Re-read" is literal — the model reads it again and the provider bills it as new input.

## Why the shipped compaction is expensive

1. Providers charge for "how much new text did I just read". Text read before is cached and is much cheaper (the measured steady-state hit rate in long sessions is **99.20%**).
2. The shipped compaction sends the model a replayed conversation and asks for a summary. Measured, that request only connects with the **first 9,856 cached tokens**; the remaining ~550,000 tokens are billed as fresh input.
3. This is not a fluke. The request right before each of the three measured compactions hit 99.93% / 99.85% / 99.07% of its prompt, 12.8 / 0.1 / 1.1 seconds earlier — the cache was hot, yet the summarizer could not use it.
4. The cause is replay-based summarization itself: the request it builds is not byte-identical to the live request (some request-time material is not in the durable log), so the cached prefix ends in the middle.

**This plugin's `extract` mode uses the same replay, so it does not save that money — and we do not pretend it does.** What we do is make the call optional (`deterministic`) or spend it on a better artifact (`extract`).

## Three options, side by side

| Option | Model call | Extra input per automatic compaction | Relative | What gets published |
| --- | --- | --- | --- | --- |
| Shipped summarizer | 1 call, re-reads ~550k | ~720k | 1× | free-form summary, no provenance |
| This plugin, `extract` | 1 call, same re-read | ~720k | ≈1× | verbatim quotes + structural certificate |
| This plugin, `deterministic` | **none** | ~170k | **≈0.25×** | structurally selected source text |

So "why do we need it" has two different answers:

- **Save cost** → `deterministic` removes the single most expensive call in compaction.
- **Keep quality** → `extract` costs the same as shipped but publishes something auditable, and refuses to publish when a critical constraint would be lost.

## Quality difference (the main point)

| Question | Shipped summary | This plugin |
| --- | --- | --- |
| Can it silently drop "use plan A", "the port is 8080", "this field must not change"? | Yes, and nobody can tell | Constraints and anchors are pinned as supports; publication is refused if one is lost (tested) |
| Can a claim be traced back to the source? | No, it is rewritten prose | Yes; every item must quote the source verbatim or it is discarded |
| What if compaction fails? | throws; the session may end up without a checkpoint | three-level fallback: structural → zero-model render → shipped summary; always a checkpoint |
| Is the result deterministic? | no, depends on the model | yes; the same input renders byte-identical |

Measured shipped summaries were 1,728–5,131 tokens of prose. This plugin's checkpoint has a budget (6,000 tokens by default) and only contains verifiable material.

## Two other measured findings

- **Pruning loses money.** The desktop preset mounts the shipped tool-result pruner. Three runs "saved" 141,041 tokens but forced subsequent requests to re-read **1,675,192 tokens** (~12×). This compressor therefore does no pruning.
- **A manual compaction after idling is genuinely cold.** A `/compact` 49 minutes after the last request paid 331,799 uncached tokens for the summary call. No design avoids that (the cache really had expired); it is listed separately from the avoidable ~550k.

## Where the numbers come from, and how to reproduce them

- Source: the session logs the Harness already writes (`session*.jsonl.zstd`). Only usage records and compaction markers are read; **no message content**, and session names are hashed.
- Tool: [`bench/`](../bench/README.md) in this repository, no dependencies.
- Reproduce:

```bash
npm test                                   # 80 offline assertions, no Harness install needed
node bench/report.mjs                      # account this machine's sessions
node bench/report.mjs <dir> --format md    # render the same tables
```

- Contract tests (`npm test`): invented or paraphrased quotes are rejected; a lost support is rejected; an ungrounded structure is reported singular; a checkpoint that cannot shrink its source is rejected; extractor failure degrades to a zero-model render; `deterministic` mode never calls the model; identical atoms render byte-identically.
- Live self-test (after installing): `GET /compaction-continuum/selftest` reports whether the backend hook is active; `?test=extract` runs one real synthetic summarization through it and reports `units=30 candidates=33 kept=33 certificate={... all true}`.

## Limitations, honestly

- The three automatic compactions come from **one** long session. Each event is a measurement, but the sample is small; run `bench` on your own logs and publish the numbers if you want a bigger sample.
- `extract`'s cost parity is a structural argument (same replay, same publication), not a live A/B — compaction is one-way per session, so a true A/B is impossible there.
- `deterministic` is cheaper but lower quality than `extract` (no semantic atoms, only structural selection).
- The price model (a cache hit costs 10% of a miss) is an assumption; change it with `--hit-ratio`.
- The real fix that would make `extract` cheap is a byte-identical replay of the live request; it needs request-time material the log does not have. That is a roadmap item, **not something the current version does**.

## Appendix (for readers who want the raw numbers)

<details>
<summary>Expand: the three automatic compactions</summary>

| turn | before prompt | summarizer call (cached / uncached / output) | after prompt | publication miss | total cost eq. | share of session input |
| --- | --- | --- | --- | --- | --- | --- |
| 22 | 726,882 | 0 / 552,771 / 4,124 | 189,833 | 179,977 | 733,734 | 1.77% |
| 47 | 724,803 | 9,856 / 562,954 / 5,059 | 171,536 | 161,680 | 726,605 | 1.76% |
| 83 | 729,572 | 9,856 / 549,132 / 3,206 | 180,230 | 170,374 | 721,477 | 1.74% |

</details>

<details>
<summary>Expand: pruning detail and the manual-compaction case</summary>

Pruning (same session; one run immediately followed by a compaction is excluded as un-attributable):

| seq range | markers | freed tokens | next request miss | cost eq. |
| --- | --- | --- | --- | --- |
| 2828–2858 | 16 | 72,475 | 629,037 | 631,443 |
| 5226–5246 | 11 | 36,174 | 493,166 | 512,814 |
| 7314–7334 | 11 | 32,392 | 512,797 | 530,935 |
| total | 38 | 141,041 | — | 1,675,192 |

Manual compaction after idle:

| before prompt | summarizer call (cached / uncached / output) | publication miss | total cost eq. | share of session input |
| --- | --- | --- | --- | --- |
| 333,341 | 1,920 / 331,799 / 9,516 | 8,422 | 340,221 | 10.73% |

</details>

<details>
<summary>Expand: field definitions and scope</summary>

- Cost unit is **miss-equivalent input tokens** = uncached input + 0.1 × cache read. Change the 0.1 with `--hit-ratio`.
- "Summarizer call" is the model usage recorded on the `compaction/summary` event.
- "Publication miss" is the uncached input of the first request after `compaction/end`; any rewrite of history pays it.
- "Share of session input" = (summarizer call + publication) / the session's total miss-equivalent input.
- Session labels are hashes of the session directory name: stable on one machine, not comparable across machines.
- Sample: 25 sessions, 3,515 requests, 997,002,631 prompt tokens, steady-state hit rate 99.20%.
- Measured on DeepSeek Harness `0.2.1-rc.5` desktop (`deepseek-account` / `deepseek-flash`).

</details>
