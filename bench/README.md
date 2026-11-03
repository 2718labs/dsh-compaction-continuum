# bench — offline accounting over recorded session logs

These tools compute what compaction and pruning actually cost in a real session, using only the durable session logs the Harness already writes. They are the source of the numbers in [`docs/EVIDENCE.md`](../docs/EVIDENCE.md).

Nothing here talks to a model, needs a running Harness, or reads message content. It reads `assistant/message` usage records plus the `compaction/*` marker events and prints counts.

## Requirements

- Node.js >= 20 for plain `.jsonl` logs.
- For the desktop app's compressed `session*.jsonl.zstd` logs, a Node build with `zlib.zstdDecompressSync`: Node >= 22.15, or the Node bundled with the Harness (`<install>/resources/runtime/primary-runtime/dependencies/node/bin/node.exe`). The tool prints an explicit error if zstd is unavailable.

## Usage

```bash
# aggregate every recorded session (default: ~/.dsh/sessions)
node bench/report.mjs

# explicit roots, markdown (this is how docs/EVIDENCE.md was produced)
node bench/report.mjs "C:/Users/me/.dsh/sessions" --format md

# machine-readable
node bench/report.mjs --format json

# one session in detail
node bench/accounting.mjs "C:/Users/me/.dsh/sessions/--proj--/<session-id>"
```

Session labels are `s-<sha256(dir)[:8]>` by default so a report can be pasted in public without leaking paths; pass `--show-paths` for your own inspection.

## What is measured

| Field | Definition |
| --- | --- |
| prompt tokens | `usage.inputTokens + usage.cacheReadTokens` for every completed request |
| hit rate | `cacheRead / promptTokens` |
| miss-equivalent | `inputTokens + hitRatio × cacheReadTokens`; `--hit-ratio` defaults to `0.1` (a provider cache hit bills at a fraction of a miss) |
| compaction: summary call | the `usage` recorded on `compaction/summary` — cache reads, uncached input, output tokens |
| compaction: summary size | characters of the published summary, plus an estimated token count using the plugin's own estimator |
| compaction: publication | the first request after `compaction/end`: its prompt size and its miss cost. That request necessarily re-reads the new prefix; it is the unavoidable cost of any rewrite |
| compaction: backend | `continuum` when `compaction/summary.rawOutput` carries the plugin's audit JSON, `shipped` otherwise |
| pruning | contiguous `compaction/prune` markers grouped into runs, with shadowed tokens, prompt delta and the next request's miss |
| share of session input | (summary call + publication) / session miss-equivalent |

## Limitations (read before quoting numbers)

- One compaction cannot be A/B tested on the same session: publication is one-way. Cross-session comparisons are subject to different prompt sizes, cache warmth and idle gaps; the reports show the raw quantities so the reader can judge.
- A publication re-read is not a defect of a backend; it is the price of changing the prefix at all. What a backend can change is **how much** it publishes (summary size) and **how much** history it rewrites.
- `hitRatio` is a price model, not a provider fact; output tokens are reported separately and never mixed into input cost.
- The pruner rows are measured with the same method as compaction rows, so they are comparable, but a pruner run inside a turn can be interleaved with other requests; the "next request" is the first completed request after the last marker.
- Logs are app-versioned (`session.jsonl`, `session.v3.jsonl`, `session.v4.jsonl`). The reader accepts all three; fields that a version does not record are shown as `—`.

## Reproducing docs/EVIDENCE.md

```bash
node bench/report.mjs <session-root> --format md > /tmp/accounting.md
```

The document keeps the methodology and interpretation around those tables; the tables themselves are copy-pasted output so they can be regenerated at any time.
