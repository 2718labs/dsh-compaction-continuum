#!/usr/bin/env node
/**
 * Aggregate cache/compaction accounting over recorded session logs.
 *
 *   node bench/report.mjs                       # scan ~/.dsh/sessions
 *   node bench/report.mjs <dir-or-file> [...]   # scan explicit roots
 *   node bench/report.mjs --format text|md|json
 *   node bench/report.mjs --hit-ratio 0.1       # price model for cache hits
 *   node bench/report.mjs --show-paths          # use relative paths instead of hashed labels
 *
 * Output contains counts, tokens and publish sizes only. Session labels are
 * hashes by default; no message content is ever printed.
 */
import { analyzeSession, aggregate } from "./lib/analyze.mjs";
import { defaultSessionRoot, findSessionFiles, readSessionFile, sessionLabel } from "./lib/session-log.mjs";
import { renderMarkdown, renderText } from "./lib/render.mjs";

function parseArgs(argv) {
  const options = { roots: [], format: "text", hitRatio: 0.1, showPaths: false, verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--format") options.format = argv[++index] ?? "text";
    else if (arg === "--hit-ratio") options.hitRatio = Number(argv[++index]);
    else if (arg === "--show-paths") options.showPaths = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else options.roots.push(arg);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log("usage: node bench/report.mjs [roots...] [--format text|md|json] [--hit-ratio 0.1] [--show-paths] [--verbose]");
  process.exit(0);
}
if (!Number.isFinite(options.hitRatio) || options.hitRatio < 0 || options.hitRatio > 1) {
  console.error("--hit-ratio must be a number in [0, 1]");
  process.exit(2);
}

const roots = options.roots.length > 0 ? options.roots : [defaultSessionRoot()];
const files = [];
for (const root of roots) {
  try {
    files.push(...findSessionFiles(root));
  } catch (error) {
    console.error(`cannot read ${root}: ${String(error?.message ?? error)}`);
    process.exit(2);
  }
}
if (files.length === 0) {
  console.error(`no session logs found under: ${roots.join(", ")}`);
  process.exit(2);
}

const sessions = [];
for (const file of files) {
  try {
    const { events } = readSessionFile(file);
    // A session with no requests carries no accounting signal (blank/forked logs).
    const label = options.showPaths ? file : sessionLabel(file);
    sessions.push(analyzeSession(events, { hitRatio: options.hitRatio, label }));
  } catch (error) {
    if (options.verbose) console.error(`skipped ${file}: ${String(error?.message ?? error)}`);
  }
}
const analyzed = sessions.filter((session) => session.requests > 0);
if (analyzed.length === 0) {
  console.error("no measurable requests found in the selected logs");
  process.exit(2);
}

const report = aggregate(analyzed, { hitRatio: options.hitRatio });

if (options.format === "json") {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else if (options.format === "md") {
  process.stdout.write(renderMarkdown(report) + "\n");
} else {
  process.stdout.write([...analyzed.map(renderText), ""].join("\n") + "\n");
}
