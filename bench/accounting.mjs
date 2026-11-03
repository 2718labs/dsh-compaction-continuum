#!/usr/bin/env node
/**
 * Per-session accounting detail, for reading one session's cache trajectory.
 *
 *   node bench/accounting.mjs <session-file-or-dir> [--hit-ratio 0.1] [--json]
 *
 * Prints the same metrics as bench/report.mjs for a single session: request
 * count, cache read/miss, each compaction's summary call and publication cost,
 * and each pruner run's net effect. No message content is printed.
 */
import { analyzeSession } from "./lib/analyze.mjs";
import { findSessionFiles, readSessionFile, sessionLabel } from "./lib/session-log.mjs";
import { renderText } from "./lib/render.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const hitRatioAt = argv.indexOf("--hit-ratio");
const hitRatio = hitRatioAt >= 0 ? Number(argv[hitRatioAt + 1]) : 0.1;
const valueIndex = hitRatioAt >= 0 ? hitRatioAt + 1 : -1;
const roots = argv.filter((arg, index) => !arg.startsWith("--") && index !== valueIndex);

if (roots.length === 0 || !Number.isFinite(hitRatio) || hitRatio < 0 || hitRatio > 1) {
  console.error("usage: node bench/accounting.mjs <session-file-or-dir> [--hit-ratio 0.1] [--json]");
  process.exit(2);
}

const files = roots.flatMap((root) => findSessionFiles(root));
if (files.length === 0) {
  console.error("no session logs found");
  process.exit(2);
}

const results = [];
for (const file of files) {
  try {
    const { events } = readSessionFile(file);
    results.push(analyzeSession(events, { hitRatio, label: sessionLabel(file) }));
  } catch (error) {
    console.error(`cannot read ${file}: ${String(error?.message ?? error)}`);
  }
}

if (json) {
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
} else {
  for (const result of results) process.stdout.write(renderText(result) + "\n\n");
}
