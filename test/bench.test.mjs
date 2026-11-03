/**
 * Offline tests for the benchmark harness. Runs on any Node >= 20: the fixtures
 * are in-memory events, so no zstd support and no Harness install is required.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSession, aggregate } from "../bench/lib/analyze.mjs";
import { renderMarkdown, renderText } from "../bench/lib/render.mjs";
import { findSessionFiles, sessionLabel } from "../bench/lib/session-log.mjs";

let failures = 0;
function checkTrue(name, value, detail = "") {
  console.log(`${value ? "PASS" : "FAIL"}  ${name}${value ? "" : `  ${detail}`}`);
  if (!value) failures += 1;
}
function checkEqual(name, actual, expected) {
  checkTrue(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const usage = (inputTokens, cacheReadTokens, outputTokens = 0) => ({ inputTokens, cacheReadTokens, outputTokens });
const request = (seq, input, cached) => ({ type: "assistant/message", seq, data: { usage: usage(input, cached, 10) } });

const events = [
  { type: "session", version: 4, id: "session-test" },
  request(10, 100, 900),
  request(20, 100, 4900),
  { type: "compaction/start", seq: 30, data: { compactionId: "c1", turn: 2 } },
  {
    type: "compaction/summary",
    seq: 31,
    data: {
      compactionId: "c1",
      shadowedTokenCount: 4000,
      shadowedSeqs: [1, 2, 3],
      provider: "p",
      model: "m",
      usage: usage(4000, 1000, 500),
      summary: [{ type: "text", text: "<compacted-summary>\n## Primary Request and Intent\n- one line" }],
      rawOutput: [{ type: "text", text: "<compacted-summary>" }],
      llmStreamCall: true,
    },
  },
  { type: "compaction/end", seq: 32, data: { compactionId: "c1", turn: 2 } },
  request(40, 2500, 500),
  { type: "compaction/prune", seq: 50, data: { shadowedSeqs: [41], shadowedTokenCount: 300 } },
  { type: "compaction/prune", seq: 51, data: { shadowedSeqs: [42], shadowedTokenCount: 200 } },
  request(60, 2600, 200),
];

const session = analyzeSession(events, { hitRatio: 0.1, label: "s-test" });
checkEqual("request count", session.requests, 4);
checkEqual("prompt tokens", session.promptTokens, 1000 + 5000 + 3000 + 2800);
checkEqual("cache read tokens", session.cacheRead, 900 + 4900 + 500 + 200);
checkTrue(
  "hit rate is computed",
  Math.abs(session.hitPct - (6500 / 11800) * 100) < 1e-9,
  String(session.hitPct),
);
checkEqual("miss-equivalent uses the hit ratio", session.totalMissEquivalent, 5300 + 0.1 * 6500);

const compaction = session.compactions[0];
checkEqual("compaction row exists", session.compactions.length, 1);
checkEqual("shipped backend is detected", compaction.backend, "shipped");
checkEqual("pre-compaction prompt", compaction.beforePrompt, 5000);
checkEqual("post-compaction prompt", compaction.afterPrompt, 3000);
checkEqual("freed tokens", compaction.freedTokens, 2000);
checkEqual("summary input miss", compaction.summaryInputMiss, 4000);
checkEqual("summary cache read", compaction.summaryCacheRead, 1000);
checkEqual("summary output tokens", compaction.summaryOutputTokens, 500);
checkTrue("summary size is measured in chars", compaction.summaryChars > 0, String(compaction.summaryChars));
checkTrue("summary tokens are estimated", compaction.summaryTokensEstimated > 0, String(compaction.summaryTokensEstimated));
checkEqual("publication miss", compaction.publicationMiss, 2500);
checkEqual("publication cost equivalent", compaction.publicationCost, 2500 + 0.1 * 500);
checkEqual("total compaction cost equivalent", compaction.totalCost, 4000 + 0.1 * 1000 + 2500 + 0.1 * 500);
checkTrue(
  "share of session input is computed",
  Math.abs(compaction.shareOfSessionInputPct - (compaction.totalCost / session.totalMissEquivalent) * 100) < 1e-9,
);

checkEqual("pruner runs are grouped", session.prunes.length, 1);
checkEqual("pruner run counts markers", session.prunes[0].count, 2);
checkEqual("pruner shadowed tokens are summed", session.prunes[0].shadowedTokens, 500);
checkEqual("pruner freed tokens", session.prunes[0].freedTokens, 200);
checkEqual("pruner publication miss", session.prunes[0].publicationMiss, 2600);

// Backend detection: the structural compressor publishes an audit JSON block.
const continuumEvents = [
  request(10, 100, 900),
  { type: "compaction/start", seq: 20, data: { compactionId: "c2", turn: null } },
  {
    type: "compaction/summary",
    seq: 21,
    data: {
      compactionId: "c2",
      usage: usage(50, 1000, 200),
      summary: [{ type: "text", text: "## Primary Request and Intent\n- verbatim" }],
      rawOutput: [{ type: "text", text: JSON.stringify({ mode: "extract", certificate: { condensationExact: true } }) }],
    },
  },
  { type: "compaction/end", seq: 22, data: { compactionId: "c2" } },
  request(30, 500, 1000),
];
const continuum = analyzeSession(continuumEvents, { hitRatio: 0.1, label: "s-continuum" });
checkEqual("continuum backend is detected", continuum.compactions[0].backend, "continuum");

// Sibling compactions must not leak into each other's brackets.
const two = analyzeSession(
  [
    request(10, 100, 900),
    { type: "compaction/start", seq: 20, data: { compactionId: "a" } },
    { type: "compaction/summary", seq: 21, data: { compactionId: "a", usage: usage(1, 1, 1), summary: [] } },
    { type: "compaction/end", seq: 22, data: { compactionId: "a" } },
    request(30, 100, 1900),
    { type: "compaction/start", seq: 40, data: { compactionId: "b" } },
    { type: "compaction/summary", seq: 41, data: { compactionId: "b", usage: usage(1, 1, 1), summary: [] } },
    { type: "compaction/end", seq: 42, data: { compactionId: "b" } },
    request(50, 100, 1900),
  ],
  { hitRatio: 0.1, label: "s-two" },
);
checkEqual("both compactions are reported", two.compactions.length, 2);
checkEqual("second compaction sees its own pre-request", two.compactions[1].beforePrompt, 2000);
checkEqual("second compaction sees its own post-request", two.compactions[1].afterPrompt, 2000);

// A prune run followed by a compaction must not claim the compaction's prompt drop.
const flaggedEvents = [
  request(10, 100, 900),
  request(20, 100, 1900),
  { type: "compaction/prune", seq: 30, data: { shadowedSeqs: [2], shadowedTokenCount: 400 } },
  { type: "compaction/prune", seq: 31, data: { shadowedSeqs: [3], shadowedTokenCount: 400 } },
  { type: "compaction/start", seq: 40, data: { compactionId: "f", turn: 3 } },
  { type: "compaction/summary", seq: 41, data: { compactionId: "f", usage: usage(10, 10, 10), summary: [] } },
  { type: "compaction/end", seq: 42, data: { compactionId: "f" } },
  request(50, 300, 700),
];
const flagged = analyzeSession(flaggedEvents, { hitRatio: 0.1, label: "s-flagged" });
checkEqual("flagged prune run is detected", flagged.prunes[0].followedByCompaction, true);
checkEqual("flagged run reports no freed tokens", flagged.prunes[0].freedTokens, null);
checkEqual("flagged run reports no publication cost", flagged.prunes[0].publicationCost, null);
const flaggedReport = aggregate([session, flagged], { hitRatio: 0.1 });
checkEqual("aggregate counts attributed runs only", flaggedReport.pruneCost.runs, 1);
checkEqual("aggregate reports excluded runs", flaggedReport.pruneCost.followedByCompaction, 1);
checkEqual("aggregate excludes flagged runs from cost", flaggedReport.pruneCost.publicationCost, 2600 + 0.1 * 200);

// Aggregate + renderers.
const report = aggregate([session, continuum, two], { hitRatio: 0.1 });
checkEqual("aggregate session count", report.totals.sessions, 3);
checkTrue("aggregate totals add up", report.totals.requests === session.requests + continuum.requests + two.requests);
checkTrue("aggregate finds all compactions", report.compactions.length === 4, String(report.compactions.length));
checkTrue("aggregate prices compaction", report.compactionCost.publicationCost > 0);
checkTrue("aggregate prices pruning", report.pruneCost.publicationCost === 2600 + 0.1 * 200);

const markdown = renderMarkdown(report);
checkTrue("markdown has baseline section", markdown.includes("### Session cache baseline"));
checkTrue("markdown has compaction section", markdown.includes("### Compaction anatomy"));
checkTrue("markdown has pruner section", markdown.includes("### Tool-result pruner runs"));
checkTrue("markdown distinguishes backends", markdown.includes("| shipped |") && markdown.includes("| continuum |"));
checkTrue("markdown never prints raw session ids", !markdown.includes("session-test"));
checkTrue("text renderer works", renderText(session).includes("compaction @30..32"));

// Discovery + labels, against a temporary directory.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "continuum-bench-"));
try {
  fs.mkdirSync(path.join(directory, "--proj--", "session-abc"), { recursive: true });
  fs.writeFileSync(path.join(directory, "--proj--", "session-abc", "session.v4.jsonl"), JSON.stringify(events[0]) + "\n");
  fs.writeFileSync(path.join(directory, "--proj--", "session-abc", "notes.txt"), "ignored");
  const found = findSessionFiles(directory);
  checkEqual("session files are discovered", found.length, 1);
  const label = sessionLabel(found[0]);
  checkTrue("labels are hashed", /^s-[0-9a-f]{8}$/.test(label), label);
  checkTrue("labels do not leak the directory", !label.includes("session-abc"), label);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL BENCH CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
