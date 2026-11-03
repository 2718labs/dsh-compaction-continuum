/** Markdown/text rendering for benchmark results. Deterministic: same input, same bytes. */

const numberFormat = new Intl.NumberFormat("en-US");

export function formatInt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return numberFormat.format(Math.round(value));
}

export function formatPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

function table(headers, rows) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

/** Aggregate markdown report used by docs/EVIDENCE.md and by humans. */
export function renderMarkdown(report) {
  const { totals, sessions, compactions, prunes, pruneCost, compactionCost, hitRatio } = report;
  const sections = [];

  sections.push("### Session cache baseline");
  sections.push("");
  sections.push(
    table(
      ["session", "requests", "prompt tokens", "cached", "uncached", "hit rate"],
      sessions.map((session) => [
        session.label,
        formatInt(session.requests),
        formatInt(session.promptTokens),
        formatInt(session.cacheRead),
        formatInt(session.missTokens),
        formatPct(session.hitPct),
      ]),
    ),
  );
  sections.push("");
  sections.push(
    `**Total:** ${formatInt(totals.requests)} requests across ${formatInt(totals.sessions)} sessions, ` +
      `${formatInt(totals.promptTokens)} prompt tokens, ${formatPct(totals.hitPct)} cached, ` +
      `miss-equivalent ${formatInt(totals.totalMissEquivalent)} tokens at hit = ${hitRatio} × miss.`,
  );

  sections.push("");
  sections.push("### Compaction anatomy");
  sections.push("");
  if (compactions.length === 0) {
    sections.push("_No compaction events in the measured sessions._");
  } else {
    sections.push(
      table(
        [
          "session",
          "backend",
          "turn",
          "before prompt",
          "after prompt",
          "freed",
          "shadowed tokens",
          "summary call (cached / uncached / out)",
          "summary chars",
          "summary ≈ tokens",
          "publication miss",
          "publication cost eq.",
          "share of session input",
        ],
        compactions.map((row) => [
          row.label,
          row.backend,
          row.turn === null ? "—" : String(row.turn),
          formatInt(row.beforePrompt),
          formatInt(row.afterPrompt),
          formatInt(row.freedTokens),
          formatInt(row.shadowedTokens),
          `${formatInt(row.summaryCacheRead)} / ${formatInt(row.summaryInputMiss)} / ${formatInt(row.summaryOutputTokens)}`,
          formatInt(row.summaryChars),
          formatInt(row.summaryTokensEstimated),
          formatInt(row.publicationMiss),
          formatInt(row.publicationCost),
          formatPct(row.shareOfSessionInputPct),
        ]),
      ),
    );
    sections.push("");
    sections.push(
      `**Totals:** summary calls ${formatInt(compactionCost.summaryCost)} miss-equivalent, ` +
        `publication re-reads ${formatInt(compactionCost.publicationCost)} miss-equivalent. ` +
        "_A publication re-read is the cost of any rewrite; it is not a defect of a specific backend._",
    );
  }

  sections.push("");
  sections.push("### Tool-result pruner runs");
  sections.push("");
  if (prunes.length === 0) {
    sections.push("_No `compaction/prune` events in the measured sessions._");
  } else {
    sections.push(
      table(
        ["session", "seq range", "prune markers", "shadowed tokens", "freed", "next request miss", "publication cost eq.", "note"],
        prunes.map((row) => [
          row.label,
          `${row.firstSeq}–${row.lastSeq}`,
          formatInt(row.count),
          formatInt(row.shadowedTokens),
          formatInt(row.freedTokens),
          formatInt(row.publicationMiss),
          formatInt(row.publicationCost),
          row.followedByCompaction ? "followed by compaction — not attributed" : "",
        ]),
      ),
    );
    sections.push("");
    sections.push(
      `**Totals (attributed runs only, ${formatInt(pruneCost.runs)}):** freed ${formatInt(pruneCost.freedTokens)} tokens; ` +
        `publication re-reads ${formatInt(pruneCost.publicationCost)} miss-equivalent. ` +
        (pruneCost.followedByCompaction > 0
          ? `${formatInt(pruneCost.followedByCompaction)} run(s) were followed by a compaction and are excluded from the totals. `
          : "") +
        "_This is why the compressor itself adds no pruning: the freed tokens are real, but the cache divergence costs more_ " +
        "(at hit = " +
        hitRatio +
        " × miss).",
    );
  }

  return sections.join("\n");
}

/** Human-readable per-session text. */
export function renderText(session) {
  const lines = [];
  lines.push(`${session.label}: ${formatInt(session.requests)} requests, ${formatInt(session.promptTokens)} prompt tokens`);
  lines.push(`  cached ${formatInt(session.cacheRead)}, uncached ${formatInt(session.missTokens)}, hit ${formatPct(session.hitPct)}`);
  lines.push(`  miss-equivalent ${formatInt(session.totalMissEquivalent)} tokens`);
  for (const row of session.compactions) {
    lines.push(
      `  compaction @${row.startSeq}..${row.endSeq} (${row.backend}, turn ${row.turn ?? "—"}): ` +
        `prompt ${formatInt(row.beforePrompt)} -> ${formatInt(row.afterPrompt)} (freed ${formatInt(row.freedTokens)}), ` +
        `summary ${formatInt(row.summaryChars)} chars (~${formatInt(row.summaryTokensEstimated)} tokens), ` +
        `publication miss ${formatInt(row.publicationMiss)}, cost eq. ${formatInt(row.publicationCost)}`,
    );
  }
  for (const row of session.prunes) {
    lines.push(
      `  prune run @${row.firstSeq}..${row.lastSeq}: freed ${formatInt(row.freedTokens)}, ` +
        `next-request miss ${formatInt(row.publicationMiss)}`,
    );
  }
  return lines.join("\n");
}
