/**
 * Pure metric extraction over session events.
 *
 * Everything here is derived from durable `assistant/message` usage and the
 * compaction/prune marker events. Nothing reads message content except the
 * published summary blocks, from which only a length is derived (for an
 * estimated checkpoint size).
 *
 * Price model: a provider bills a cache hit at a fraction `hitRatio` of a miss
 * (DeepSeek documents a large discount; the default here is 0.1 and it is
 * configurable). All costs are reported as "miss-equivalent input tokens":
 *
 *     missEquivalent = inputTokens + hitRatio * cacheReadTokens
 *
 * Output tokens are reported separately and are never mixed into input cost.
 */
import { estimateTokens } from "../../lib/pipeline.js";

const PRUNE_RUN_GAP = 4;

/** One `assistant/message` request with provider usage. */
function requestsOf(events) {
  const requests = [];
  for (const event of events) {
    const usage = event?.data?.usage;
    if (event?.type !== "assistant/message" || usage === undefined) continue;
    const miss = usage.inputTokens ?? 0;
    const hit = usage.cacheReadTokens ?? 0;
    requests.push({
      seq: event.seq,
      miss,
      hit,
      output: usage.outputTokens ?? 0,
      prompt: miss + hit,
    });
  }
  return requests.sort((left, right) => left.seq - right.seq);
}

function requestBefore(requests, seq) {
  let found;
  for (const request of requests) if (request.seq < seq) found = request;
  return found;
}

function requestAfter(requests, seq) {
  return requests.find((request) => request.seq > seq);
}

const missEquivalent = (request, hitRatio) => request.miss + hitRatio * request.hit;

/** True when a compaction summary was produced by the structural compressor. */
function backendOf(summary) {
  const raw = Array.isArray(summary?.rawOutput) ? summary.rawOutput : [];
  for (const block of raw) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const trimmed = block.text.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && ("mode" in parsed || "certificate" in parsed)) return "continuum";
    } catch {
      /* published model text, not an audit record */
    }
  }
  return "shipped";
}

function summaryTextOf(summary) {
  const blocks = Array.isArray(summary?.summary) ? summary.summary : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Group consecutive prune markers into runs. */
function pruneRunsOf(events) {
  const prunes = events.filter((event) => event?.type === "compaction/prune");
  const runs = [];
  let current;
  for (const prune of prunes) {
    if (current === undefined || prune.seq - current.lastSeq > PRUNE_RUN_GAP) {
      current = {
        firstSeq: prune.seq,
        lastSeq: prune.seq,
        count: 0,
        shadowedNodes: 0,
        shadowedTokens: 0,
      };
      runs.push(current);
    }
    current.lastSeq = prune.seq;
    current.count += 1;
    const seqs = Array.isArray(prune.data?.shadowedSeqs) ? prune.data.shadowedSeqs.length : 1;
    current.shadowedNodes += seqs;
    current.shadowedTokens += prune.data?.shadowedTokenCount ?? 0;
  }
  return runs;
}

/** Analyze one session's events. */
export function analyzeSession(events, options = {}) {
  const hitRatio = typeof options.hitRatio === "number" ? options.hitRatio : 0.1;
  const requests = requestsOf(events);

  const promptTokens = requests.reduce((sum, request) => sum + request.prompt, 0);
  const cacheRead = requests.reduce((sum, request) => sum + request.hit, 0);
  const missTokens = requests.reduce((sum, request) => sum + request.miss, 0);
  const outputTokens = requests.reduce((sum, request) => sum + request.output, 0);
  const totalMissEquivalent = missTokens + hitRatio * cacheRead;

  const starts = new Map();
  const summaries = new Map();
  const ends = [];
  const startSeqs = [];
  for (const event of events) {
    if (event?.type === "compaction/start") {
      starts.set(event.data?.compactionId, event);
      startSeqs.push(event.seq);
    } else if (event?.type === "compaction/summary") summaries.set(event.data?.compactionId, event);
    else if (event?.type === "compaction/end") ends.push(event);
  }
  startSeqs.sort((left, right) => left - right);

  const compactions = [];
  for (const end of ends) {
    const id = end.data?.compactionId;
    const start = starts.get(id);
    const summary = summaries.get(id);
    if (start === undefined) continue;
    const before = requestBefore(requests, start.seq);
    const after = requestAfter(requests, end.seq);
    const usage = summary?.data?.usage;
    const text = summaryTextOf(summary?.data);
    const summaryCost = usage === undefined ? 0 : usage.inputTokens + hitRatio * (usage.cacheReadTokens ?? 0);
    const publicationCost = after === undefined ? null : missEquivalent(after, hitRatio);
    compactions.push({
      compactionId: id,
      backend: backendOf(summary?.data),
      turn: start.data?.turn ?? null,
      error: end.data?.error !== undefined,
      startSeq: start.seq,
      endSeq: end.seq,
      beforePrompt: before?.prompt ?? null,
      afterPrompt: after?.prompt ?? null,
      freedTokens: before === undefined || after === undefined ? null : before.prompt - after.prompt,
      shadowedTokens: summary?.data?.shadowedTokenCount ?? null,
      shadowedNodes: Array.isArray(summary?.data?.shadowedSeqs) ? summary.data.shadowedSeqs.length : null,
      summaryProvider: summary?.data?.provider ?? null,
      summaryModel: summary?.data?.model ?? null,
      summaryCacheRead: usage?.cacheReadTokens ?? null,
      summaryInputMiss: usage?.inputTokens ?? null,
      summaryOutputTokens: usage?.outputTokens ?? null,
      summaryChars: text.length,
      summaryTokensEstimated: text.length === 0 ? null : estimateTokens(text),
      publicationMiss: after?.miss ?? null,
      publicationCost,
      totalCost: publicationCost === null ? null : summaryCost + publicationCost,
      shareOfSessionInputPct:
        totalMissEquivalent > 0 && publicationCost !== null
          ? ((summaryCost + publicationCost) / totalMissEquivalent) * 100
          : null,
    });
  }

  const prunes = [];
  for (const run of pruneRunsOf(events)) {
    const before = requestBefore(requests, run.firstSeq);
    const after = requestAfter(requests, run.lastSeq);
    // If a compaction starts between the prune run and the next completed
    // request, the prompt delta and the next-request miss belong to that
    // compaction, not to pruning. Flag the row instead of mis-attributing it.
    const followedByCompaction = startSeqs.some(
      (seq) => seq > run.lastSeq && (after === undefined || seq < after.seq),
    );
    prunes.push({
      firstSeq: run.firstSeq,
      lastSeq: run.lastSeq,
      count: run.count,
      shadowedNodes: run.shadowedNodes,
      shadowedTokens: run.shadowedTokens,
      followedByCompaction,
      beforePrompt: before?.prompt ?? null,
      afterPrompt: followedByCompaction ? null : after?.prompt ?? null,
      freedTokens:
        followedByCompaction || before === undefined || after === undefined ? null : before.prompt - after.prompt,
      publicationMiss: followedByCompaction ? null : after?.miss ?? null,
      publicationCost:
        followedByCompaction || after === undefined ? null : missEquivalent(after, hitRatio),
    });
  }

  return {
    label: options.label ?? "session",
    events: events.length,
    requests: requests.length,
    promptTokens,
    cacheRead,
    missTokens,
    outputTokens,
    hitPct: promptTokens === 0 ? null : (cacheRead / promptTokens) * 100,
    totalMissEquivalent,
    compactionCount: compactions.length,
    compactions,
    pruneRuns: prunes.length,
    prunes,
  };
}

/** Aggregate several analyzed sessions. */
export function aggregate(sessions, options = {}) {
  const hitRatio = typeof options.hitRatio === "number" ? options.hitRatio : 0.1;
  const totals = sessions.reduce(
    (sum, session) => ({
      sessions: sum.sessions + 1,
      requests: sum.requests + session.requests,
      promptTokens: sum.promptTokens + session.promptTokens,
      cacheRead: sum.cacheRead + session.cacheRead,
      missTokens: sum.missTokens + session.missTokens,
      compactionCount: sum.compactionCount + session.compactionCount,
      pruneRuns: sum.pruneRuns + session.pruneRuns,
    }),
    { sessions: 0, requests: 0, promptTokens: 0, cacheRead: 0, missTokens: 0, compactionCount: 0, pruneRuns: 0 },
  );
  const compactions = sessions.flatMap((session) =>
    session.compactions.map((compaction) => ({ ...compaction, label: session.label })),
  );
  const prunes = sessions.flatMap((session) =>
    session.prunes.map((prune) => ({ ...prune, label: session.label })),
  );
  // Prune runs immediately followed by a compaction cannot be attributed:
  // mark them separately and keep them out of the cost totals.
  const attributedPrunes = prunes.filter((prune) => !prune.followedByCompaction);
  return {
    hitRatio,
    totals: {
      ...totals,
      hitPct: totals.promptTokens === 0 ? null : (totals.cacheRead / totals.promptTokens) * 100,
      totalMissEquivalent: totals.missTokens + hitRatio * totals.cacheRead,
    },
    sessions,
    compactions,
    prunes,
    pruneCost: {
      runs: attributedPrunes.length,
      followedByCompaction: prunes.length - attributedPrunes.length,
      freedTokens: attributedPrunes.reduce((sum, prune) => sum + (prune.freedTokens ?? 0), 0),
      publicationCost: attributedPrunes.reduce((sum, prune) => sum + (prune.publicationCost ?? 0), 0),
    },
    compactionCost: {
      summaryCost: compactions.reduce((sum, row) => sum + (row.summaryInputMiss ?? 0) + hitRatio * (row.summaryCacheRead ?? 0), 0),
      publicationCost: compactions.reduce((sum, row) => sum + (row.publicationCost ?? 0), 0),
    },
  };
}
