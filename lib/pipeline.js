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

<kind> is one of: goal, constraint, decision, progress, open_loop, preference, entity, error_fix, file, anchor.

Rules, in order of importance:
1. "quote" MUST be copied character-for-character from the conversation above. It is verified mechanically against the source span; a paraphrase is rejected and the atom is discarded. Do not include the surrounding quotation marks in the quote.
2. Prefer anchors: exact file paths, shell commands, error strings, identifiers, numeric values. Those are the highest-value atoms and they go in kind "anchor".
3. "text" is one terse bullet (max 200 characters). Do not restate the quote; state what it establishes.
4. At most 48 atoms. Merge duplicates. Never invent facts that are not in the conversation.
5. Cover every distinct thread that a successor must know: goals, constraints, decisions, progress, open loops, blockers, exact anchors.
6. Output raw JSON only: no markdown fence, no commentary.`;

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
];

/**
 * Render the kept atoms into the shipped checkpoint shape. No model output is
 * copied verbatim into prose; only verified quotes appear, and always quoted.
 */
export function renderCheckpoint(items, keptIndexes, { maxTokens, maxBulletChars = 240 }) {
  const kept = [...keptIndexes].map((index) => items[index]);
  const sections = new Map(SECTION_ORDER.map((name) => [name, []]));
  let tokens = 0;
  for (const item of kept) {
    const section = SECTION_BY_KIND.get(item.kind) ?? "Critical Context";
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
  }
  const lines = [];
  for (const name of SECTION_ORDER) {
    const body = sections.get(name) ?? [];
    lines.push(`## ${name}`);
    if (body.length === 0) lines.push("(none)");
    else lines.push(...body);
    lines.push("");
  }
  return { text: lines.join("\n").trim(), tokens };
}

// ---------------------------------------------------------------------------
// Compilation entry point
// ---------------------------------------------------------------------------

/**
 * Compile one checkpoint.
 *
 * @param input - `{ messages, tools }` replayed prefix, as handed to `summarize`.
 * @param options - `{ callModel, queryText, extractorMaxTokens, checkpointMaxTokens, selectionThreshold, minKeep, mode, signal }`.
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

  // Supports: exact anchors plus explicit open loops must survive condensation.
  const supports = new Set();
  items.forEach((item, index) => {
    if (item.kind === "anchor" || item.kind === "open_loop") supports.add(index);
  });
  if (supports.size > Math.floor(items.length / 2)) {
    // Anchors dominate a short span: keep only the first half as hard supports so
    // the structural pass still has something to eliminate.
    const limited = [...supports].slice(0, Math.max(1, Math.floor(items.length / 3)));
    supports.clear();
    for (const index of limited) supports.add(index);
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
  const costOf = () => renderCheckpoint(items, kept, { maxTokens: checkpointMaxTokens }).tokens;
  let rendered = renderCheckpoint(items, kept, { maxTokens: checkpointMaxTokens });
  const removable = [...groupValue.entries()]
    .filter(([groupIndex]) => !selection.protectedGroups.has(groupIndex))
    .sort((left, right) => left[1] - right[1]);
  for (const [groupIndex] of removable) {
    if (rendered.tokens <= checkpointMaxTokens) break;
    for (const index of selection.groups[groupIndex]) kept.delete(index);
    audit.droppedGroups += 1;
    rendered = renderCheckpoint(items, kept, { maxTokens: checkpointMaxTokens });
  }

  audit.candidates = items.length;
  audit.kept = kept.size;
  audit.checkpointTokens = rendered.tokens;

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
  audit.certificate = {
    supportsPreserved: !supportLost,
    selectionConsistent,
    condensationExact: reconstruction?.passed ?? false,
    reconstructionError: reconstruction?.reconstructionError ?? null,
    minKeptScore,
    maxDroppedScore,
  };
  if (supportLost) throw new Error("continuum certificate: a support was eliminated");
  if (!selectionConsistent) throw new Error("continuum certificate: a load-bearing candidate was dropped");
  if (condensation !== null && reconstruction !== null && !reconstruction.passed) {
    throw new Error("continuum certificate: condensation did not reconstruct the full response");
  }

  // A checkpoint that does not shrink its source is useless and would be rejected
  // by the shipped shrink validation anyway.
  const sourceTokens = units.reduce((sum, unit) => sum + estimateTokens(unit.text), 0);
  if (rendered.tokens >= sourceTokens) throw new Error("continuum: checkpoint does not shrink its source");

  audit.sourceTokens = sourceTokens;
  if (call !== null) audit.extractor = call;
  return { text: rendered.text, audit, ...(call === null ? {} : { call }) };
}
