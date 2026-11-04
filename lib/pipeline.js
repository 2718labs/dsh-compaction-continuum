/**
 * dsh-compaction-continuum — compilation pipeline.
 *
 * One model call turns the shadowed span into *cited atoms*; the structural core
 * decides which atoms carry load; a deterministic renderer writes the checkpoint.
 * The model never writes prose into the checkpoint, so nothing unverifiable can
 * reach the surface.
 *
 * Pure module: the caller supplies `callModel(promptText, signal)`, which keeps
 * this testable without a Host.
 */

import {
  assembleStiffness,
  solveConstrained,
  condense,
  certify,
  dependencyGroups,
} from "./structure/core.js";

// ---------------------------------------------------------------------------
// Token estimation (deliberately conservative for CJK-heavy sessions)
// ---------------------------------------------------------------------------

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

/** Rough token estimate: one token per CJK character, four characters otherwise. */
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (CJK.test(character)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

// ---------------------------------------------------------------------------
// Segmentation: messages -> units
// ---------------------------------------------------------------------------

const KIND_BY_ROLE = new Map([
  ["user", "user"],
  ["assistant", "assistant"],
  ["tool", "tool-result"],
  ["system", "system"],
]);

function blockText(block) {
  if (block === null || typeof block !== "object") return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "tool-call") {
    const name = typeof block.name === "string" ? block.name : "tool";
    const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
    return `<tool ${name}> ${args}`;
  }
  if (block.type === "image") return "<image>";
  if (block.type === "file") return `<file ${block.name ?? ""}>`;
  if (typeof block.text === "string") return block.text;
  return "";
}

/**
 * Split the replayed prefix into addressable units.
 * The first system message is the stable head: it is context for provenance but
 * never part of the compressible span.
 * @returns `{ head, units }`.
 */
export function segmentMessages(messages) {
  const head = [];
  const units = [];
  for (let index = 0; index < (messages?.length ?? 0); index += 1) {
    const message = messages[index];
    const role = typeof message?.role === "string" ? message.role : "unknown";
    const content = message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const text = blocks.map(blockText).filter((part) => part.length > 0).join("\n").trim();
    if (text.length === 0) continue;
    if (role === "system" && units.length === 0) {
      head.push(text);
      continue;
    }
    units.push({
      index: units.length,
      message,
      role,
      kind: KIND_BY_ROLE.get(role) ?? "note",
      text,
      chars: text.length,
    });
  }
  return { head, units };
}

// ---------------------------------------------------------------------------
// Extractive compilation
// ---------------------------------------------------------------------------

const EXTRACTION_INSTRUCTION = `You are compiling the conversation ABOVE into cited atoms for a structural context compressor. You are NOT writing a summary.

Return ONLY this JSON object, nothing else:

{"atoms":[{"kind":"<kind>","text":"<one terse bullet>","quote":"<exact substring copied from the conversation above>","unit":<optional hint: which message, 0 = first non-system message>}],"dropped":[{"reason":"<why some span is worth nothing>"}]}

<kind> is one of: goal, constraint, decision, progress, next_step, open_loop, preference, entity, error_fix, file, anchor.

Rules, in order of importance:
1. "quote" MUST be copied character-for-character from the conversation above. It is verified mechanically against the source span; a paraphrase is rejected and the atom is discarded. Do not include the surrounding quotation marks in the quote.
2. Prefer anchors: exact file paths, shell commands, error strings, identifiers, numeric values. Those are the highest-value atoms and they go in kind "anchor".
3. "text" is one terse bullet (max 200 characters). Do not restate the quote; state what it establishes.
4. Always include exactly one kind "next_step" atom: the immediate action a successor must take to continue the task. Its quote must be the text that establishes that step: the latest request, or the latest stated pending action. If the task is complete, use "No pending step." as text and quote the sentence that shows completion.
5. RELEASE COMPLETED WORK. A prior checkpoint can appear in the conversation: treat it as state evidence, never copy its items forward. Drop steps that are done, errors that are fixed, tasks that were resolved, and requests that are finished; they remain in the durable log and must not keep occupying the checkpoint. Keep only what is still actionable or still true.
6. At most 48 atoms. Merge duplicates. Never invent facts that are not in the conversation.
7. Cover every distinct thread that a successor must know: goals, live constraints, decisions, current progress, open loops, blockers, exact anchors.
8. Output raw JSON only: no markdown fence, no commentary.`;

function parseJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalize(text) {
  return String(text)
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ATOM_KINDS = new Set([
  "goal",
  "constraint",
  "decision",
  "progress",
  "next_step",
  "open_loop",
  "preference",
  "entity",
  "error_fix",
  "file",
  "anchor",
]);

/**
 * Validate the extractor's output against the replayed span.
 *
 * Provenance is resolved by locating the quote in the units, so the model never
 * has to number messages: a quote that cannot be found discards its atom, which
 * makes "the model invented something" mechanically impossible to publish.
 */
export function validateAtoms(parsed, units, { minQuoteChars = 8 } = {}) {
  const atoms = [];
  let rejected = 0;
  let accepted = 0;
  const cited = new Set();
  const normalizedUnits = units.map((unit) => normalize(unit.text));
  for (const raw of Array.isArray(parsed?.atoms) ? parsed.atoms : []) {
    if (raw === null || typeof raw !== "object") {
      rejected += 1;
      continue;
    }
    const kind = ATOM_KINDS.has(raw.kind) ? raw.kind : "note";
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    const quote = typeof raw.quote === "string" ? normalize(raw.quote) : "";
    if (text.length === 0 || quote.length < minQuoteChars) {
      rejected += 1;
      continue;
    }
    const hint = Number.isInteger(Number(raw.unit)) ? Number(raw.unit) : null;
    let resolved = -1;
    if (hint !== null && units[hint] !== undefined && normalizedUnits[hint].includes(quote)) {
      resolved = hint;
    } else {
      // Deterministic: the most recent unit containing the quote wins.
      for (let index = units.length - 1; index >= 0; index -= 1) {
        if (normalizedUnits[index].includes(quote)) {
          resolved = index;
          break;
        }
      }
    }
    if (resolved < 0) {
      rejected += 1;
      continue;
    }
    accepted += 1;
    cited.add(resolved);
    atoms.push({
      id: `atom:${atoms.length}`,
      kind,
      text: text.length > 400 ? `${text.slice(0, 397)}...` : text,
      quote,
      unit: resolved,
      sourceUnit: resolved,
    });
  }
  const uncovered = units.map((unit) => unit.index).filter((index) => !cited.has(index));
  return { atoms, accepted, rejected, uncovered, dropped: [] };
}

// ---------------------------------------------------------------------------
// Structural selection
// ---------------------------------------------------------------------------

function lexicalSet(text) {
  const set = new Set();
  for (const character of String(text).toLowerCase()) {
    if (CJK.test(character)) set.add(character);
    else if (/[a-z0-9_./:-]/u.test(character)) set.add(character);
  }
  return set;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Build the structure and pick the load-bearing set.
 *
 * stiffness: evidence coupling; load: activation by the current request;
 * supports: atoms that must never be eliminated.
 */
export function selectKeepers({ items, dependencies, queryText, supports, selectionThreshold, minKeep }) {
  const count = items.length;
  const relations = [];
  for (let left = 0; left < count; left += 1) {
    for (let right = left + 1; right < count; right += 1) {
      let weight = 0;
      if (items[left].sourceUnit === items[right].sourceUnit) weight += 1.0;
      if (Math.abs(items[left].sourceUnit - items[right].sourceUnit) === 1) weight += 0.5;
      if (items[left].kind === items[right].kind) weight += 0.25;
      if (weight > 0) relations.push({ a: left, b: right, weight });
    }
  }
  const dependencyRelations = dependencies ?? relations;
  const stiffness = assembleStiffness(count, relations);
  const query = lexicalSet(queryText ?? "");
  const load = items.map((item) => jaccard(query, lexicalSet(item.text)));

  // Physical grounding: every disconnected sub-structure needs at least one
  // support, otherwise its Laplacian block is singular and the KKT system has no
  // solution. Ground each unsupported component at its most activated member.
  const grounded = new Set(supports);
  for (const component of dependencyGroups(count, relations)) {
    if (component.some((index) => grounded.has(index))) continue;
    let best = component[0];
    for (const index of component) if (load[index] > load[best]) best = index;
    grounded.add(best);
  }

  const constraintRows = [...grounded].map((index) => {
    const row = new Float64Array(count);
    row[index] = 1;
    return { row, rhs: 1 };
  });
  const solved = solveConstrained(stiffness, load, constraintRows);
  if (solved.solution === null) return null;

  const scores = Array.from(solved.solution, (value) => Math.abs(value));
  const maxScore = Math.max(1e-12, ...scores);
  const threshold = selectionThreshold * maxScore;
  const kept = new Set(grounded);
  for (let index = 0; index < count; index += 1) if (scores[index] >= threshold) kept.add(index);
  if (kept.size < Math.min(minKeep, count)) {
    const ranked = scores.map((score, index) => ({ index, score })).sort((left, right) => right.score - left.score);
    for (const { index } of ranked) {
      if (kept.size >= Math.min(minKeep, count)) break;
      kept.add(index);
    }
  }

  // Dependency groups are the atomic units of removal: a group with no support is
  // all-optional and may be dropped as a whole; a group with a support may not.
  const groups = dependencyGroups(count, dependencyRelations);
  const groupOf = new Map();
  groups.forEach((group, groupIndex) => {
    for (const index of group) groupOf.set(index, groupIndex);
  });
  const protectedGroups = new Set([...kept].map((index) => groupOf.get(index)));

  return {
    scores,
    maxScore,
    relations,
    dependencyRelations,
    groups,
    groupOf,
    kept,
    grounded,
    supports: grounded,
    protectedGroups,
    load,
    stiffness,
    constraints: constraintRows,
  };
}

// ---------------------------------------------------------------------------
// Deterministic rendering
// ---------------------------------------------------------------------------

const SECTION_BY_KIND = new Map([
  ["goal", "Primary Request and Intent"],
  ["constraint", "Critical Context"],
  ["decision", "Critical Context"],
  ["preference", "Critical Context"],
  ["entity", "Key Technical Concepts"],
  ["error_fix", "Errors and Fixes"],
  ["file", "Files and Code"],
  ["anchor", "Verbatim Anchors"],
  ["progress", "Current Work"],
  ["next_step", "Next Step"],
  ["open_loop", "Pending Jobs"],
  ["note", "Critical Context"],
  ["user", "Primary Request and Intent"],
  ["assistant", "Current Work"],
  ["tool-result", "Files and Code"],
  ["tool-call", "Files and Code"],
  ["system", "Critical Context"],
]);

const SECTION_ORDER = [
  "Primary Request and Intent",
  "Key Technical Concepts",
  "Files and Code",
  "Errors and Fixes",
  "Pending Jobs",
  "Current Work",
  "Next Step",
  "Critical Context",
  "Verbatim Anchors",
  "Carried Anchors (older)",
];

// ---------------------------------------------------------------------------
// Continuation anchor
//
// A successful compaction must leave the successor with an actionable "next
// step", otherwise a long task loses its thread even when every atom is
// certified. The extractor is asked for a next_step atom; if it declines, the
// renderer falls back to a deterministic quote of the latest real request, or of
// the latest recorded assistant state. This floor is what makes the "Next Step"
// section reachable at all — it used to render "(none)" unconditionally.
// ---------------------------------------------------------------------------

const CHECKPOINT_PREFIX = "This is an automatically generated checkpoint";
const CHECKPOINT_CLOSE = "</compacted-summary>";
const SCAFFOLDING_CUT = /\n\s*(?:Current runtime context\.|Time sampled while preparing turn|<system-reminder>)/;
const SCAFFOLDING_PREFIX = /^(?:Current runtime context\.|Time sampled while preparing turn|<system-reminder>)/;

/** Reduce one user message to the real request it carries. */
function requestText(text) {
  let value = String(text ?? "");
  if (value.startsWith(CHECKPOINT_PREFIX)) {
    // A prior checkpoint can be merged with the current turn in one message.
    const close = value.lastIndexOf(CHECKPOINT_CLOSE);
    value = close < 0 ? "" : value.slice(close + CHECKPOINT_CLOSE.length);
  }
  const cut = value.search(SCAFFOLDING_CUT);
  if (cut >= 0) value = value.slice(0, cut);
  return normalize(value);
}

function excerpt(text, limit = 200) {
  return text.length > limit ? `${text.slice(0, limit - 3).trimEnd()}...` : text;
}

/**
 * Deterministic continuation floor.
 *
 * @returns `{ source, text, quote }` or `null` when the span carries no anchorable
 * continuation at all.
 */
function continuationFloor(units) {
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit.role !== "user") continue;
    const text = requestText(unit.text);
    if (text.length === 0 || SCAFFOLDING_PREFIX.test(text)) continue;
    return { source: "latest-request", text: "Continue the latest request", quote: excerpt(text) };
  }
  // No user message in the span: anchor the last recorded state instead, so the
  // successor still sees where the work stopped.
  for (const role of ["assistant", undefined]) {
    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index];
      if (role !== undefined && unit.role !== role) continue;
      const text = normalize(unit.text);
      if (text.length === 0 || text.startsWith(CHECKPOINT_PREFIX) || SCAFFOLDING_PREFIX.test(text)) continue;
      return { source: "latest-state", text: "Continue from the latest recorded state", quote: excerpt(text) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Release and cross-generation carry
//
// Near-lossless must not become "never forget": after several generations the
// checkpoint would otherwise accumulate finished work. Two deterministic rules
// bound the lifetime of carried material: anchors are carried from the previous
// checkpoint at most once (so a stale anchor lives about two generations after it
// was last re-evidenced), and the extraction instruction is told to release
// completed steps. The durable session log keeps the released originals.
// ---------------------------------------------------------------------------

const ANCHOR_LINE = /^-\s+(.+?)\s+—\s+"([\s\S]*)"\s*$/u;
const RECALL_HINT = "## Recall (exact original)\n- The full pre-compaction transcript is durable. Call `context_recall` with a literal `query` to find exact original wording, or with `fromSeq`/`toSeq` to read an event range.";

function anchorSection(text, heading) {
  const start = text.lastIndexOf(`## ${heading}`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 3);
  const end = rest.indexOf("\n## ");
  return end < 0 ? rest : rest.slice(0, end);
}

function parseAnchorLines(body) {
  const anchors = [];
  for (const rawLine of body.split("\n")) {
    const match = ANCHOR_LINE.exec(rawLine.trim());
    if (match === null) continue;
    const label = match[1].trim();
    const quote = match[2].replace(/\\"/g, '"').trim();
    if (label.length === 0 || quote.length < 8) continue;
    anchors.push({ label, quote });
  }
  return anchors;
}

/**
 * Anchors from the previous checkpoint to carry once, plus the count of anchors
 * released because they were already a carry from an earlier generation.
 */
function priorCheckpointAnchors(units) {
  const carry = [];
  let released = 0;
  for (const unit of units) {
    if (unit.role !== "user") continue;
    if (!unit.text.startsWith(CHECKPOINT_PREFIX)) continue;
    for (const anchor of parseAnchorLines(anchorSection(unit.text, "Verbatim Anchors"))) {
      carry.push({
        kind: "anchor",
        text: anchor.label.slice(0, 400),
        quote: anchor.quote,
        unit: unit.index,
        sourceUnit: unit.index,
        carried: true,
      });
    }
    released += parseAnchorLines(anchorSection(unit.text, "Carried Anchors (older)")).length;
  }
  return { carry, released };
}

/**
 * Keep the newest non-offloaded image blocks from the replayed messages, bounded
 * by count. The blocks are spliced into the checkpoint message as real image
 * content, so a compacted conversation keeps its visual evidence instead of a
 * text placeholder.
 */
export function collectRetainedImages(messages, maxImages = 4) {
  if (!(maxImages > 0)) return [];
  const seen = new Set();
  const images = [];
  for (let index = (messages?.length ?? 0) - 1; index >= 0 && images.length < maxImages; index -= 1) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = content.length - 1; blockIndex >= 0 && images.length < maxImages; blockIndex -= 1) {
      const block = content[blockIndex];
      if (block?.type !== "image" || block.offloaded === true) continue;
      if (block.attachment === undefined || typeof block.attachment !== "object") continue;
      const id = typeof block.attachment.attachmentId === "string" ? block.attachment.attachmentId : JSON.stringify(block.attachment);
      if (seen.has(id)) continue;
      seen.add(id);
      images.push(block);
    }
  }
  return images;
}

/**
 * Render the kept atoms into the shipped checkpoint shape. No model output is
 * copied verbatim into prose; only verified quotes appear, and always quoted.
 *
 * Next-step atoms are laid out first so the budget can never squeeze the
 * continuation anchor out; `nextStep` is the deterministic floor used when the
 * extractor supplied none. The floor is allowed to exceed `maxTokens` by its own
 * size, because a checkpoint without a next step is not publishable.
 */
export function renderCheckpoint(items, keptIndexes, { maxTokens, maxBulletChars = 240, nextStep } = {}) {
  const kept = [...keptIndexes].map((index) => items[index]);
  const ordered = [
    ...kept.filter((item) => item.kind === "next_step"),
    ...kept.filter((item) => item.carried === true),
    ...kept.filter((item) => item.kind !== "next_step" && item.carried !== true),
  ];
  const sections = new Map(SECTION_ORDER.map((name) => [name, []]));
  const floorLabel = typeof nextStep?.text === "string" ? nextStep.text.trim() : "";
  const floorQuote = typeof nextStep?.quote === "string" ? nextStep.quote.replace(/\s+/g, " ").trim() : "";
  const floor =
    floorLabel.length > 0 && floorQuote.length > 0 ? `- ${floorLabel} — "${floorQuote.replace(/"/g, '\\"')}"` : null;
  let tokens = 0;
  let nextStepAnchored = false;
  for (const item of ordered) {
    const section = item.carried === true ? "Carried Anchors (older)" : SECTION_BY_KIND.get(item.kind) ?? "Critical Context";
    let bullet = String(item.text).replace(/\s+/g, " ").trim();
    if (bullet.length > maxBulletChars) bullet = `${bullet.slice(0, maxBulletChars - 3)}...`;
    if (item.quote !== undefined && ["anchor", "file", "error_fix"].includes(item.kind)) {
      bullet = `${bullet} — "${item.quote}"`;
    }
    const line = `- ${bullet}`;
    const cost = estimateTokens(line);
    if (tokens + cost > maxTokens) break;
    tokens += cost;
    sections.get(section).push(line);
    if (section === "Next Step") nextStepAnchored = true;
  }
  if (!nextStepAnchored && floor !== null) {
    tokens += estimateTokens(floor);
    sections.get("Next Step").push(floor);
    nextStepAnchored = true;
  }
  const lines = [];
  for (const name of SECTION_ORDER) {
    const body = sections.get(name) ?? [];
    lines.push(`## ${name}`);
    if (body.length === 0) lines.push("(none)");
    else lines.push(...body);
    lines.push("");
  }
  return { text: lines.join("\n").trim(), tokens, nextStep: nextStepAnchored };
}

// ---------------------------------------------------------------------------
// Verbatim retention (near-lossless continuity layer)
//
// The structural checkpoint is an index: it says what is load-bearing. It is not
// a transcript, and a successor cannot recover the exact wording of the user's
// requests from one. Codex-class compaction solves that by retaining real user
// messages verbatim (up to a budget) next to a handoff summary. This layer does
// the same for Harness: user requests first (newest wins until the budget runs
// out), then the most recent non-user units, all quoted from the source and
// bounded so the published checkpoint is never larger than the span it replaces.
// ---------------------------------------------------------------------------

const RETENTION_PER_UNIT_TOKENS = 2000;
const RETENTION_SECTION_RESERVE = 32;

function truncateToTokens(text, maxTokens) {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd();
}

/** A real user message: no embedded prior checkpoint, no request-time scaffolding. */
function retainedUserText(text) {
  let value = String(text ?? "");
  if (value.startsWith(CHECKPOINT_PREFIX)) return "";
  const cut = value.search(SCAFFOLDING_CUT);
  if (cut >= 0) value = value.slice(0, cut);
  value = value.trim();
  if (value.length === 0 || SCAFFOLDING_PREFIX.test(value)) return "";
  return value;
}

function renderRetentionEntry(entry) {
  const detail = entry.truncated ? `truncated from ${entry.originalTokens} tokens` : `${entry.originalTokens} tokens`;
  return `### u${entry.unitIndex} (${entry.role}, ${detail})\n${entry.text}`;
}

function renderRetentionSection(title, entries) {
  if (entries.length === 0) return "";
  return [`## ${title}`, ...entries.map(renderRetentionEntry)].join("\n\n");
}

function emptyRetention() {
  return {
    enabled: false,
    budgetTokens: 0,
    tokens: 0,
    text: "",
    userMessages: 0,
    recentUnits: 0,
    droppedUserMessages: 0,
    truncatedUserMessages: 0,
    truncatedUnits: 0,
  };
}

/**
 * Build the verbatim retention block.
 *
 * @returns `{ enabled, budgetTokens, tokens, text, userMessages, recentUnits, droppedUserMessages, truncatedUserMessages, truncatedUnits }`
 */
function buildVerbatimRetention(units, budgetTokens) {
  const retention = emptyRetention();
  if (!(budgetTokens > 0)) return retention;
  retention.enabled = true;
  retention.budgetTokens = budgetTokens;
  let remaining = budgetTokens - RETENTION_SECTION_RESERVE;

  // Phase 1: real user requests, newest first, in full unless the budget forces
  // truncation. Intent is the least safe thing to paraphrase, so it goes first.
  const userUnits = [];
  for (const unit of units) {
    if (unit.role !== "user") continue;
    const text = retainedUserText(unit.text);
    if (text.length > 0) userUnits.push({ unit, text });
  }
  const retainedIndexes = new Set();
  const userEntries = [];
  for (let index = userUnits.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const { unit, text } = userUnits[index];
    const originalTokens = estimateTokens(text);
    const headerCost = estimateTokens(`### u${unit.index} (user, ${originalTokens} tokens)`) + 2;
    if (remaining <= headerCost + 8) {
      retention.droppedUserMessages += index + 1;
      break;
    }
    const allowed = remaining - headerCost;
    const truncated = originalTokens > allowed;
    const body = truncated ? truncateToTokens(text, allowed - 2) : text;
    if (body.length === 0) {
      retention.droppedUserMessages += index + 1;
      break;
    }
    const entry = { unitIndex: unit.index, role: "user", text: body, truncated, originalTokens };
    userEntries.push(entry);
    retainedIndexes.add(unit.index);
    remaining -= estimateTokens(renderRetentionEntry(entry));
    retention.userMessages += 1;
    if (truncated) {
      retention.truncatedUserMessages += 1;
      retention.droppedUserMessages += index;
      break;
    }
  }
  userEntries.reverse();

  // Phase 2: the most recent non-user units, so tools, files and the assistant's
  // last state remain inspectable verbatim.
  const recentEntries = [];
  for (let index = units.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const unit = units[index];
    if (retainedIndexes.has(unit.index) || unit.role === "user") continue;
    const text = String(unit.text ?? "").trim();
    if (text.length === 0 || text.startsWith(CHECKPOINT_PREFIX) || SCAFFOLDING_PREFIX.test(text)) continue;
    const originalTokens = estimateTokens(text);
    const headerCost = estimateTokens(`### u${unit.index} (${unit.role}, ${originalTokens} tokens)`) + 2;
    if (remaining <= headerCost + 8) break;
    const allowed = Math.min(RETENTION_PER_UNIT_TOKENS, remaining - headerCost);
    const truncated = originalTokens > allowed;
    const body = truncated ? truncateToTokens(text, allowed - 2) : text;
    if (body.length === 0) break;
    const entry = { unitIndex: unit.index, role: unit.role, text: body, truncated, originalTokens };
    recentEntries.push(entry);
    retainedIndexes.add(unit.index);
    remaining -= estimateTokens(renderRetentionEntry(entry));
    retention.recentUnits += 1;
    if (truncated) retention.truncatedUnits += 1;
  }
  recentEntries.reverse();

  const sections = [
    renderRetentionSection("Retained User Requests (verbatim)", userEntries),
    renderRetentionSection("Retained Recent Context (verbatim)", recentEntries),
  ].filter((section) => section.length > 0);
  retention.text = sections.join("\n\n");
  retention.tokens = estimateTokens(retention.text);
  return retention;
}

// ---------------------------------------------------------------------------
// Compilation entry point
// ---------------------------------------------------------------------------

/**
 * Compile one checkpoint.
 *
 * @param input - `{ messages, tools }` replayed prefix, as handed to `summarize`.
 * @param options - `{ callModel, queryText, extractorMaxTokens, checkpointMaxTokens, selectionThreshold, minKeep, mode, signal, verbatimTokens }`.
 * @returns `{ text, audit }`; throws when neither mode can produce a checkpoint.
 */
export async function compileCheckpoint(input, options) {
  const {
    callModel,
    queryText = "",
    extractorMaxTokens = 12000,
    checkpointMaxTokens = 8000,
    selectionThreshold = 0.35,
    minKeep = 8,
    mode = "extract",
    maxAtoms = 48,
    verbatimTokens = 20000,
    recallHint = false,
  } = options;
  const { head, units } = segmentMessages(input?.messages);
  const audit = {
    mode,
    headChars: head.join("\n").length,
    units: units.length,
    extracted: 0,
    rejectedAtoms: 0,
    uncoveredUnits: 0,
    kept: 0,
    candidates: 0,
    droppedGroups: 0,
    checkpointTokens: 0,
    nextStepSource: null,
    retention: null,
    carriedAnchors: 0,
    releasedAnchors: 0,
    certificate: null,
    extractionError: null,
  };
  if (units.length === 0) throw new Error("continuum: nothing to compile");

  let items = null;
  let call = null;
  if (mode === "extract") {
    try {
      const raw = await callModel(EXTRACTION_INSTRUCTION, extractorMaxTokens);
      // The host adapter returns `{ text, provider, model, maxTokens, usage }`
      // so the published audit can carry the request's real cache accounting;
      // a bare string keeps this pipeline usable from pure tests.
      const rawText = typeof raw === "string" ? raw : String(raw?.text ?? "");
      if (raw !== null && typeof raw === "object") {
        call = {
          ...(raw.provider === undefined ? {} : { provider: raw.provider }),
          ...(raw.model === undefined ? {} : { model: raw.model }),
          ...(raw.maxTokens === undefined ? {} : { maxTokens: raw.maxTokens }),
          ...(raw.usage === undefined ? {} : { usage: raw.usage }),
        };
      }
      const parsed = parseJsonObject(rawText);
      if (parsed !== null) {
        const validated = validateAtoms(parsed, units);
        audit.extracted = validated.accepted;
        audit.rejectedAtoms = validated.rejected;
        audit.uncoveredUnits = validated.uncovered.length;
        // The extractor must mostly cite real quotes and cover most units, or the
        // structural pass has nothing trustworthy to work with.
        if (validated.accepted >= 4 && validated.accepted / Math.max(1, validated.accepted + validated.rejected) >= 0.75) {
          items = validated.atoms.slice(0, maxAtoms);
        }
      }
    } catch (error) {
      audit.extractionError = String(error?.message ?? error);
    }
  }
  if (items === null) {
    // Deterministic fallback: the units themselves become the coordinates.
    audit.mode = "deterministic";
    items = units.map((unit, index) => ({
      id: `unit:${index}`,
      kind: unit.kind,
      text: unit.text.replace(/\s+/g, " ").trim().slice(0, 400),
      sourceUnit: unit.index,
      quote: undefined,
    }));
    items = items.filter((item) => item.text.length > 0);
  }
  if (items.length === 0) throw new Error("continuum: no candidates");

  // Release and carry: the previous checkpoint's fresh anchors are carried once;
  // anchors that were already carries are released, so a stale pin cannot live
  // forever across generations. The extractor additionally releases completed
  // work by instruction.
  const carried = priorCheckpointAnchors(units);
  audit.releasedAnchors = carried.released;
  if (carried.carry.length > 0) {
    const known = new Set(items.map((item) => normalize(item.quote ?? "")));
    for (const atom of carried.carry) {
      if (known.has(normalize(atom.quote))) continue;
      known.add(normalize(atom.quote));
      items.push({ id: `carried:${items.length}`, ...atom });
      audit.carriedAnchors += 1;
    }
  }

  // Supports: a next step is always pinned; carried anchors are pinned once;
  // exact anchors and open loops survive condensation as far as elimination allows.
  const supports = new Set();
  items.forEach((item, index) => {
    if (item.kind === "next_step" || item.carried === true) supports.add(index);
  });
  const softSupports = [];
  items.forEach((item, index) => {
    if ((item.kind === "anchor" || item.kind === "open_loop") && !supports.has(index)) softSupports.push(index);
  });
  if (supports.size + softSupports.length > Math.floor(items.length / 2)) {
    // Anchors dominate a short span: keep only a third as hard supports so the
    // structural pass still has something to eliminate. The next step is never
    // dropped by this limitation.
    for (const index of softSupports.slice(0, Math.max(1, Math.floor(items.length / 3)))) supports.add(index);
  } else {
    for (const index of softSupports) supports.add(index);
  }

  const selection = selectKeepers({
    items,
    queryText,
    supports,
    selectionThreshold,
    minKeep,
  });
  if (selection === null) throw new Error("continuum: structure is singular");

  // Budget: drop whole all-optional dependency groups, cheapest value first.
  const groupValue = new Map();
  for (const [groupIndex, group] of selection.groups.entries()) {
    groupValue.set(groupIndex, Math.max(...group.map((index) => selection.scores[index])));
  }
  const kept = new Set(selection.kept);
  // Continuation anchor: an extracted next_step atom, else a deterministic floor.
  const hasNextStepAtom = [...kept].some((index) => items[index].kind === "next_step");
  const floor = hasNextStepAtom ? null : continuationFloor(units);
  audit.nextStepSource = hasNextStepAtom ? "atom" : (floor?.source ?? null);
  const render = () => renderCheckpoint(items, kept, { maxTokens: checkpointMaxTokens, nextStep: floor });
  let rendered = render();
  const removable = [...groupValue.entries()]
    .filter(([groupIndex]) => !selection.protectedGroups.has(groupIndex))
    .sort((left, right) => left[1] - right[1]);
  for (const [groupIndex] of removable) {
    if (rendered.tokens <= checkpointMaxTokens) break;
    for (const index of selection.groups[groupIndex]) kept.delete(index);
    audit.droppedGroups += 1;
    rendered = render();
  }

  audit.candidates = items.length;
  audit.kept = kept.size;

  // Continuity retention: verbatim source units that the structural index cannot
  // replace. Budget is clamped so the published checkpoint still shrinks the span
  // it replaces, even for tiny test spans.
  const sourceTokens = units.reduce((sum, unit) => sum + estimateTokens(unit.text), 0);
  const recallSection = recallHint ? RECALL_HINT : "";
  const recallCost = recallSection.length > 0 ? estimateTokens(recallSection) + 2 : 0;
  const retentionBudget = Math.max(0, Math.min(verbatimTokens, sourceTokens - rendered.tokens - recallCost - 64));
  const retention = buildVerbatimRetention(units, retentionBudget);
  const parts = [rendered.text];
  if (retention.text.length > 0) parts.push(retention.text);
  if (recallSection.length > 0) parts.push(recallSection);
  const checkpointText = parts.join("\n\n");
  audit.retention = {
    enabled: retention.enabled,
    budgetTokens: retention.budgetTokens,
    tokens: retention.tokens,
    userMessages: retention.userMessages,
    recentUnits: retention.recentUnits,
    droppedUserMessages: retention.droppedUserMessages,
    truncatedUserMessages: retention.truncatedUserMessages,
    truncatedUnits: retention.truncatedUnits,
  };
  audit.checkpointTokens = rendered.tokens + retention.tokens + recallCost;

  // Certificates: supports preserved, closure complete, condensation numerically sound.
  const keptList = [...kept].sort((left, right) => left - right);
  const supportLost = [...selection.supports].some((index) => !kept.has(index));
  const condensation = condense(selection.stiffness, selection.load, keptList);
  const reconstruction =
    condensation === null ? null : certify(selection.stiffness, selection.load, selection.constraints, condensation);
  // The selection certificate: nothing more load-bearing may have been dropped
  // than the least load-bearing thing kept.
  const keptScores = keptList.map((index) => selection.scores[index]);
  const minKeptScore = keptScores.length > 0 ? Math.min(...keptScores) : 0;
  const maxDroppedScore = Math.max(
    0,
    ...items.map((_, index) => (kept.has(index) ? 0 : selection.scores[index])),
  );
  const selectionConsistent = maxDroppedScore <= minKeptScore + 1e-9;
  const nextStepAnchored = rendered.nextStep === true;
  const carriedAnchorsPreserved = items.every((item, index) => item.carried !== true || kept.has(index));
  // Near-lossless claim, scoped honestly: every real user message in the span is
  // present verbatim, fully, when retention is enabled and the budget allows it.
  const userMessagesVerbatim = retention.enabled
    ? retention.droppedUserMessages === 0 && retention.truncatedUserMessages === 0
    : null;
  audit.certificate = {
    supportsPreserved: !supportLost,
    selectionConsistent,
    condensationExact: reconstruction?.passed ?? false,
    reconstructionError: reconstruction?.reconstructionError ?? null,
    nextStepAnchored,
    userMessagesVerbatim,
    carriedAnchorsPreserved,
    minKeptScore,
    maxDroppedScore,
  };
  if (supportLost) throw new Error("continuum certificate: a support was eliminated");
  if (!selectionConsistent) throw new Error("continuum certificate: a load-bearing candidate was dropped");
  if (condensation !== null && reconstruction !== null && !reconstruction.passed) {
    throw new Error("continuum certificate: condensation did not reconstruct the full response");
  }
  if (!nextStepAnchored) throw new Error("continuum certificate: no next-step anchor for the successor");

  // A checkpoint that does not shrink its source is useless and would be rejected
  // by the shipped shrink validation anyway. Retention is budgeted against this.
  if (audit.checkpointTokens >= sourceTokens) throw new Error("continuum: checkpoint does not shrink its source");

  audit.sourceTokens = sourceTokens;
  if (call !== null) audit.extractor = call;
  return { text: checkpointText, audit, ...(call === null ? {} : { call }) };
}
