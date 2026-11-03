/**
 * dsh-compaction-continuum — Host half.
 *
 * Structural Compression: the context is treated as a structure and compressed
 * by static condensation, not by asking a model to write a summary.
 *
 *   one model call   extract cited atoms (kind, text, unit, exact quote)
 *   structural core  evidence-coupled stiffness + request activation, KKT solve,
 *                    load-bearing selection, dependency closure, static
 *                    condensation with a reconstruction certificate
 *   renderer         deterministic checkpoint text: only verified quotes appear,
 *                    and always quoted
 *
 * The shipped `BasicCompactionEngine` still owns the durable transaction, the
 * busy signal, the overflow recovery and the retained tail. This plugin replaces
 * its documented sole subclass hook `summarize()` — on the prototype, so the
 * preset-plane instances the desktop app actually uses are covered too — and
 * anything unexpected falls back to the shipped summarizer, so a bug here
 * degrades to the previous behaviour instead of publishing an unverified
 * checkpoint.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { compileCheckpoint, estimateTokens } from "./pipeline.js";

const PLUGIN = "dsh-compaction-continuum";

/** Single source of truth: the package manifest next to this file. */
const VERSION = (() => {
  try {
    const manifest = createRequire(import.meta.url)("../package.json");
    return typeof manifest?.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// ---------------------------------------------------------------------------
// Host module resolution
//
// A Loader-loaded plugin cannot resolve `@deepseek-ai/*` by bare specifier: the
// profile's node_modules has no such directory. Resolving through the dsh
// package inside app.asar yields the *same* module instances the Host holds,
// which matters for `LlmError` classification and for deriving the subclass.
// ---------------------------------------------------------------------------

function dshPackageDirectory() {
  const resources = process.resourcesPath;
  if (typeof resources === "string" && resources.length > 0) {
    return join(resources, "app.asar", "dsh");
  }
  throw new Error(
    `${PLUGIN}: cannot locate the dsh package directory (process.resourcesPath is unavailable); this plugin expects the DeepSeek Harness desktop host`,
  );
}

const DSH_DIRECTORY = dshPackageDirectory();
const requireFromHost = createRequire(pathToFileURL(join(DSH_DIRECTORY, "package.json")));

async function importHostPackage(specifier) {
  return import(pathToFileURL(requireFromHost.resolve(specifier)).href);
}

const [compactionBasic, llm, utilValues] = await Promise.all([
  importHostPackage("@deepseek-ai/dsh-compaction-basic"),
  importHostPackage("@deepseek-ai/dsh-llm"),
  importHostPackage("@deepseek-ai/dsh-util-values"),
]);

const schemasteryModule = requireFromHost("@deepseek-ai/schemastery");
const z = schemasteryModule.default ?? schemasteryModule;

const { BasicCompactionEngine } = compactionBasic;
const { BlockAssembler, LlmError, contentHasImage } = llm;
const { deepFreeze } = utilValues;

/** Config keys the shipped engine validates; anything else must not reach it. */
const BASE_CONFIG_KEYS = [
  "thresholdRatio",
  "headroomTokens",
  "retainRatio",
  "retainTokens",
  "summarizationProvider",
  "summarizationModel",
  "maxTokens",
  "compactionRetries",
  "maxOverflowRetries",
  "modelPolicies",
  "auto",
];

/** Retained verbatim tail when the operator configures neither retention form. */
const DEFAULT_RETAIN_TOKENS = 20000;

/** Two retention forms are mutually exclusive in the shipped resolver. */
function baseOnly(raw) {
  const config = {};
  for (const key of BASE_CONFIG_KEYS) if (raw?.[key] !== undefined) config[key] = raw[key];
  if (config.retainTokens !== undefined) delete config.retainRatio;
  else if (config.retainRatio === undefined) config.retainTokens = DEFAULT_RETAIN_TOKENS;
  return config;
}

function resolveContinuumConfig(raw = {}) {
  const mode = raw.mode ?? "extract";
  if (!["extract", "deterministic", "off"].includes(mode)) {
    throw new Error(`${PLUGIN}: mode must be "extract", "deterministic" or "off"`);
  }
  const positive = (value, name, fallback) => {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${PLUGIN}: ${name} must be a positive integer`);
    return resolved;
  };
  const nonNegative = (value, name, fallback) => {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 0) throw new Error(`${PLUGIN}: ${name} must be a non-negative integer`);
    return resolved;
  };
  const ratio = (value, name, fallback) => {
    const resolved = value ?? fallback;
    if (typeof resolved !== "number" || resolved < 0 || resolved > 1) throw new Error(`${PLUGIN}: ${name} must be within [0, 1]`);
    return resolved;
  };
  return deepFreeze({
    mode,
    extractorMaxTokens: positive(raw.extractorMaxTokens, "extractorMaxTokens", 12000),
    checkpointMaxTokens: positive(raw.checkpointMaxTokens, "checkpointMaxTokens", 8000),
    verbatimTokens: nonNegative(raw.verbatimTokens, "verbatimTokens", 20000),
    selectionThreshold: ratio(raw.selectionThreshold, "selectionThreshold", 0.35),
    minKeep: positive(raw.minKeep, "minKeep", 8),
    statusCommands: raw.statusCommands ?? true,
    maxRecordedCompactions: positive(raw.maxRecordedCompactions, "maxRecordedCompactions", 32),
    logDecisions: raw.logDecisions ?? true,
  });
}

// ---------------------------------------------------------------------------
// Content-free accounting
// ---------------------------------------------------------------------------

function emptyRecord() {
  return {
    requests: 0,
    missTokens: 0,
    hitTokens: 0,
    outputTokens: 0,
    compactions: [],
    pendingSummary: null,
    pendingPublication: false,
    compiled: 0,
    fallback: 0,
    lastAudit: null,
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export default class ContinuumCompactionEngine extends BasicCompactionEngine {
  /** The shipped backend's own dependencies plus the command registry, the probe route and the two registries that reveal the preset-plane backend. */
  static inject = [
    ...new Set([...(BasicCompactionEngine.inject ?? []), "commands", "webServer", "agents", "agentPresets"]),
  ];

  /** Shipped policy keys plus this plugin's keys; validated by the Loader. */
  static Config = z.object({
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(z.any()),
    auto: z.boolean(),
    mode: z.string(),
    extractorMaxTokens: z.number().step(1).min(1),
    checkpointMaxTokens: z.number().step(1).min(1),
    verbatimTokens: z.number().step(1).min(0),
    selectionThreshold: z.number(),
    minKeep: z.number().step(1).min(1),
    statusCommands: z.boolean(),
    maxRecordedCompactions: z.number().step(1).min(1),
    logDecisions: z.boolean(),
  });

  /** This plugin's validated options. */
  continuum;

  /** Original shipped `summarize` this compressor falls back to. */
  __baseSummarize = undefined;

  /** Lifecycle of the shipped-engine hook: none | installed | already-installed | uninstalled. */
  __hookState = "none";

  /** Per-session content-free records. */
  #records = new Map();

  /** Non-zero while a synthetic self-test runs, so it never lands in the ledger. */
  #syntheticDepth = 0;

  constructor(ctx, config = {}) {
    super(ctx, baseOnly(config));
    /** Brand used by the health route: Cordis serves services through derived
     *  instances, so identity comparison against `this` is not reliable. */
    this.__continuum = PLUGIN;
    this.continuum = resolveContinuumConfig(config);
    this.#registerAccounting();
    if (this.continuum.statusCommands) this.#registerCommands();
    this.#registerHealthRoute();
    this.#registerDiagnosticRoute();
    this.#installEngineHook();
    ctx.logger.info(
      `${PLUGIN} ${VERSION}: mode=${this.continuum.mode} retain=${this.config.retainTokens ?? `ratio:${this.config.retainRatio}`} thresholdRatio=${this.config.thresholdRatio}`,
    );
  }

  /**
   * Unauthenticated loopback probe: proves the backend is mounted in the running
   * Host without a GUI session token. Exposes policy and counters only — never
   * conversation content.
   */
  #registerHealthRoute() {
    const { ctx } = this;
    const engine = this;
    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: "exact",
        path: "/compaction-continuum/ping",
        handler(req, res) {
          const body = JSON.stringify(
            {
              ok: true,
              plugin: PLUGIN,
              version: VERSION,
              pid: process.pid,
              mode: engine.continuum.mode,
              retainTokens: engine.config.retainTokens ?? null,
              thresholdRatio: engine.config.thresholdRatio,
              headroomTokens: engine.config.headroomTokens ?? null,
              checkpointMaxTokens: engine.continuum.checkpointMaxTokens,
              verbatimTokens: engine.continuum.verbatimTokens,
              extractorMaxTokens: engine.continuum.extractorMaxTokens,
              selectionThreshold: engine.continuum.selectionThreshold,
              // Definitive liveness proof: the resolved `ctx.compaction` provider
              // carries this plugin's brand and implements the seam methods.
              compactionService: (() => {
                try {
                  const service = engine.ctx?.get?.("compaction");
                  return {
                    present: Boolean(service),
                    branded: service?.__continuum === PLUGIN,
                    methods: ["compactIfNeeded", "compactNow", "compactRegion"].filter(
                      (name) => typeof service?.[name] === "function",
                    ),
                  };
                } catch (error) {
                  return { present: false, error: String(error?.message ?? error) };
                }
              })(),
              autoCompaction: engine.config.auto ?? null,
              // The preset plane owns the active backend; this proves every
              // shipped engine instance resolves `summarize` through this plugin.
              hook: {
                state: engine.__hookState,
                installedOnShippedClass: BasicCompactionEngine.prototype.summarize?.__continuumHook === true,
              },
            },
            null,
            2,
          );
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "content-length": Buffer.byteLength(body),
          });
          if (req.method === "HEAD") res.end();
          else res.end(body);
        },
      });
      return dispose;
    }, `${PLUGIN}: /compaction-continuum/ping`);
  }

  /**
   * Operational diagnostic: replays the exact steps the status commands take
   * against one live session and reports each step's own stack on failure.
   *
   * This exists because a command handler that throws reaches the GUI as a bare
   * one-line toast with no stack, which turns a one-line bug into a guess.
   * The response carries counts, policy and failure stacks only — never
   * conversation content.
   *
   * GET /compaction-continuum/selftest?session=<id prefix>&test=extract|replay
   *
   * `test=extract` additionally runs one real `summarize` call through the live
   * backend with a synthetic fixture prompt (a few hundred tokens, no session
   * history, no durable publication) to prove the extraction contract end to
   * end. `test=replay` rebuilds the most recent recorded compaction span from
   * the live session and runs one real `summarize` call on it, reporting the
   * measured input/output usage and the resulting checkpoint. Neither mode
   * publishes anything. Omit `test` for the free read-only diagnosis.
   */
  #registerDiagnosticRoute() {
    const { ctx } = this;
    const engine = this;
    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: "exact",
        path: "/compaction-continuum/selftest",
        handler(req, res) {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          const sessionPrefix = url.searchParams.get("session") ?? "";
          const testKind = url.searchParams.get("test") ?? "";
          engine.#diagnose(sessionPrefix, testKind).then(
            (report) => {
              const body = JSON.stringify(report, null, 2);
              res.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                "content-length": Buffer.byteLength(body),
              });
              res.end(body);
            },
            (error) => {
              const body = JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2);
              res.writeHead(500, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                "content-length": Buffer.byteLength(body),
              });
              res.end(body);
            },
          );
        },
      });
      return dispose;
    }, `${PLUGIN}: /compaction-continuum/selftest`);
  }

  /** Content-free shape summary for one probe value. Never touches opaque services. */
  #describe(value) {
    try {
      if (value === null) return null;
      if (value === undefined) return "(undefined)";
      const type = typeof value;
      if (type === "function") return "(function)";
      if (type !== "object") return value;
      if (Array.isArray(value)) return { array: value.length };
      const pick = (keys) => {
        const out = {};
        for (const key of keys) {
          try {
            if (value[key] !== undefined) out[key] = value[key];
          } catch {
            /* an opaque proxy: skip the field rather than fail the probe */
          }
        }
        return out;
      };
      let picked = {};
      try {
        if (value.totalTokens !== undefined) picked = pick(["totalTokens", "surfaceTokens", "baseline", "surfaceDeltaTokens"]);
        else if (value.kind !== undefined) picked = pick(["kind", "text"]);
        else if (value.context !== undefined) picked = pick(["provider", "id", "context", "defaultMaxTokens"]);
        else if (value.config !== undefined || value.provider !== undefined) picked = pick(["provider", "model", "maxTokens", "contextWindow"]);
      } catch {
        /* opaque value: fall through to the class name */
      }
      if (Object.keys(picked).length > 0) return picked;
      try {
        return `(${Object.prototype.toString.call(value)})`;
      } catch {
        return "(opaque object)";
      }
    } catch (error) {
      return `(unreadable: ${String(error?.message ?? error)})`;
    }
  }

  /** Run the status pipeline step by step, isolating each failure with its stack. */
  async #diagnose(sessionPrefix, testKind = "") {
    const extraction = testKind === "extract";
    const replay = testKind === "replay";
    const report = { ok: true, plugin: PLUGIN, version: VERSION, pid: process.pid, probes: [] };
    const probe = async (name, fn) => {
      try {
        const value = await fn();
        report.probes.push({ name, ok: true, value: this.#describe(value) });
        return value;
      } catch (error) {
        report.probes.push({
          name,
          ok: false,
          error: String(error?.message ?? error),
          stack: String(error?.stack ?? "").split("\n").slice(0, 12),
        });
        return undefined;
      }
    };

    // The live Agent owns the real Session (the store's copy is a detached
    // replay object for cold presentation), so prefer it for every probe.
    const agents = await probe("agents service", () => this.ctx.get("agents"));
    let agent;
    let session;
    try {
      const list = typeof agents?.list === "function" ? agents.list() : [];
      report.agents = {
        count: list.length,
        sessions: list.slice(0, 10).map((candidate) => candidate?.session?.id ?? null),
      };
      agent = sessionPrefix.length > 0
        ? list.find((candidate) => String(candidate?.session?.id ?? "").includes(sessionPrefix))
        : list[list.length - 1];
      session = agent?.session;
    } catch (error) {
      report.agents = { error: String(error?.message ?? error) };
    }
    if (session === undefined) {
      // Fall back to the store so the route still works between sessions.
      const sessions = await probe("sessions service", () => this.ctx.get("sessions"));
      const store = sessions?.store;
      report.sessionIds =
        store instanceof Map ? [...store.keys()].slice(0, 20) : `store unavailable (${typeof store})`;
      if (store instanceof Map) {
        const ids = [...store.keys()];
        const id = sessionPrefix.length > 0
          ? ids.find((candidate) => String(candidate).includes(sessionPrefix))
          : ids[ids.length - 1];
        if (id !== undefined) session = store.get(id);
      }
    }
    if (session === undefined) {
      report.ok = false;
      report.error = `no live session matched "${sessionPrefix}"`;
      return report;
    }
    report.sessionId = session.id;

    await probe("tokenMeter.measure", () => this.ctx.tokenMeter.measure(session));
    const header = await probe("session.requestHeader", () => session.requestHeader?.());
    const routed = header?.config;
    if (routed !== undefined) {
      await probe("llm.resolveModelInfo", () =>
        this.ctx.llm.resolveModelInfo(routed.provider, routed.model, new AbortController().signal),
      );
    }
    const probeAgent = agent ?? { session };
    await probe("context_status", () =>
      this.#statusReport({ agent: probeAgent, signal: new AbortController().signal }),
    );
    await probe("context_inspect", () =>
      this.#inspectReport({ agent: probeAgent, signal: new AbortController().signal }),
    );

    // Which backend actually compacts this session? The desktop moves the
    // backend into the agent-preset plane, behind an isolated `compaction`
    // service, so the Host-plane engine is not the one doing the work.
    const registry = this.ctx.get("agentPresets");
    let isolatedEngine;
    await probe("preset backend service", () => {
      isolatedEngine = registry?.serviceFor?.(agent, "compaction");
      return `${isolatedEngine === undefined ? "absent" : "present"} (composed preset: ${registry?.composedPreset?.(agent?.ctx) ?? "?"})`;
    });
    const backend = isolatedEngine ?? agent?.ctx?.get?.("compaction");
    report.hook = {
      installedOnShippedClass: BasicCompactionEngine.prototype.summarize?.__continuumHook === true,
      state: this.__hookState,
      backendFound: backend !== undefined,
      backendIsThisPlugin: backend?.__continuum === PLUGIN,
      backendIsShippedClass:
        backend === undefined ? null : Object.getPrototypeOf(backend) === BasicCompactionEngine.prototype,
      backendUsesHookedSummarize:
        backend === undefined
          ? null
          : typeof backend.summarize === "function" && backend.summarize.__continuumHook === true,
      backendPolicy:
        backend?.config === undefined
          ? null
          : {
              thresholdRatio: backend.config.thresholdRatio,
              retainTokens: backend.config.retainTokens,
              retainRatio: backend.config.retainRatio,
              maxTokens: backend.config.maxTokens,
            },
    };

    // Warm-prefix contract: the compaction replay and the agent's own request
    // projection must agree, or no replay-based summary can hit the cache.
    await probe("projection alignment", () => {
      const live = session.deriveMessages?.() ?? [];
      const surface = session.surface;
      const nodes = Array.isArray(surface?.nodes) ? surface.nodes : [];
      const replayed = nodes
        .map((seq) => (typeof seq === "number" ? session.deriveEventMessage?.(session.eventAt(seq)) : undefined))
        .filter((message) => message !== null && message !== undefined);
      const liveJson = JSON.stringify(live);
      const replayJson = JSON.stringify(replayed);
      let firstDifference = -1;
      const limit = Math.min(live.length, replayed.length);
      for (let index = 0; index < limit; index += 1) {
        if (JSON.stringify(live[index]) !== JSON.stringify(replayed[index])) {
          firstDifference = index;
          break;
        }
      }
      return `live=${live.length} replayed=${replayed.length} identical=${liveJson === replayJson} firstDifference=${firstDifference} liveChars=${liveJson.length} replayChars=${replayJson.length}`;
    });

    if (extraction) {
      await probe("extraction contract", () => this.#runSyntheticExtraction(backend, agent));
    }
    if (replay) {
      await probe("replayed span", () => this.#runReplayTest(backend, agent, session));
    }

    const record = this.#records.get(session.id);
    report.record =
      record === undefined
        ? "(no accounting record for this session)"
        : {
            requests: record.requests,
            hitTokens: record.hitTokens,
            missTokens: record.missTokens,
            compiled: record.compiled,
            fallback: record.fallback,
            compactions: record.compactions.length,
            lastAudit: record.lastAudit,
          };
    return report;
  }

  /**
   * Prove the extraction contract through the live backend with a synthetic
   * fixture: the hooked `summarize` is reached, the extractor returns cited
   * JSON, the structural solve certifies, and the rendered checkpoint is real.
   * No session history is read and nothing is published.
   */
  async #runSyntheticExtraction(backend, agent) {
    if (backend === undefined) throw new Error("no compaction backend to test");
    if (typeof backend.summarize !== "function") throw new Error("backend exposes no summarize()");
    const text = (value) => [{ type: "text", text: value }];
    // Assistant messages must carry a `source`: the llm service's request
    // projection reads `message.source.replayState` for every assistant role.
    const assistant = (value) => ({
      role: "assistant",
      content: text(value),
      source: { provider: "deepseek-account", model: "deepseek-flash" },
    });
    const fixture = [
      { role: "system", content: text("Continuum extraction fixture. This is not a real conversation.") },
      { role: "user", content: text("Please make the route table in G:/proj/src/router.ts lazy, but keep /api/health working.") },
      assistant("Decision: convert the static routes array into registerLazy() in stages. The routes array is static and /api/health is first, so preserve ordering."),
      { role: "user", content: text("Note the constraint: error code E_ROUTE_DUP comes from registry.ts:88 and must not reappear.") },
      assistant("Progress: added registerLazy() draft; next step is to migrate the user routes and re-run the structure tests. Open issue: order of middleware registration is still unverified."),
      { role: "user", content: text("Do not break the cache hit rate; keep the tool catalog identical across modes.") },
      assistant("Confirmed: the tool catalog stays unchanged. File list: G:/proj/src/router.ts, G:/proj/src/registry.ts, G:/proj/test/routes.test.ts."),
    ];
    // Enough depth that the source span is clearly larger than the checkpoint.
    for (let index = 0; index < 12; index += 1) {
      fixture.push({
        role: "user",
        content: text(
          `Detail ${index}: inspect section ${index} of G:/proj/src/router.ts, record the ordering constraint, the middleware registration timing and the fallback behaviour for unknown routes.`,
        ),
      });
      fixture.push(
        assistant(
          `Progress ${index}: section ${index} migrated to registerLazy(); remaining work is verifying error codes, preserving /api/health order and re-running routes.test.ts.`,
        ),
      );
    }
    const started = Date.now();
    this.#syntheticDepth += 1;
    let result;
    try {
      result = await backend.summarize({ messages: fixture }, agent, new AbortController().signal);
    } finally {
      this.#syntheticDepth -= 1;
    }
    return this.#formatSummarizeResult(result, started);
  }

  /**
   * Replay the most recent recorded compaction span through the live backend and
   * report the measured cost of the compressor itself. Nothing is published and
   * no ledger entry is written; this is a measurement, not a compaction.
   */
  async #runReplayTest(backend, agent, session) {
    if (backend === undefined) throw new Error("no compaction backend to test");
    if (session === undefined) throw new Error("no live session");
    let summaryEvent;
    const total = typeof session.seq === "number" ? session.seq : 0;
    for (let seq = 0; seq < total; seq += 1) {
      const event = session.eventAt(seq);
      if (event?.type === "compaction/summary") summaryEvent = event;
    }
    if (summaryEvent === undefined) throw new Error("this session has no recorded compaction to replay");
    const shadowedSeqs = Array.isArray(summaryEvent.data?.shadowedSeqs) ? summaryEvent.data.shadowedSeqs : [];
    if (shadowedSeqs.length === 0) throw new Error("the recorded compaction carries no shadowed seqs");

    // Rebuild the replay input the same way the shipped engine does: committed
    // system message first, then the shadowed region in surface order, plus the
    // tools from the latest request header.
    const messages = [];
    const surfaceNodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
    for (const seq of surfaceNodes) {
      const event = session.eventAt(seq);
      if (event?.type !== "system/message") continue;
      const message = session.deriveEventMessage(event);
      if (message !== null && message !== undefined) messages.push(message);
      break;
    }
    for (const seq of shadowedSeqs) {
      const message = session.deriveEventMessage(session.eventAt(seq));
      if (message !== null && message !== undefined) messages.push(message);
    }
    if (messages.length === 0) throw new Error("the recorded span produced no messages");
    const tools = session.requestHeader?.()?.tools;
    const header =
      `spanMessages=${messages.length} shadowedSeqs=${shadowedSeqs.length} tools=${tools === undefined ? 0 : tools.length} ` +
      `recordedSummaryChars=${(summaryEvent.data?.summary ?? []).reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0)}`;
    const started = Date.now();
    this.#syntheticDepth += 1;
    let result;
    try {
      result = await backend.summarize(
        { messages, ...(tools === undefined ? {} : { tools }) },
        agent,
        new AbortController().signal,
      );
    } finally {
      this.#syntheticDepth -= 1;
    }
    return `${header} ${this.#formatSummarizeResult(result, started)}`;
  }

  /** Content-free one-line summary of one `summarize()` result. */
  #formatSummarizeResult(result, started) {
    const summaryText = (result?.summary ?? [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    let audit = null;
    for (const block of result?.rawOutput ?? []) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      const trimmed = block.text.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null && ("mode" in parsed || "certificate" in parsed || "units" in parsed)) {
          audit = parsed;
        }
      } catch {
        /* the shipped summarizer's raw output is not JSON */
      }
    }
    const usage = result?.usage;
    return [
      `ms=${Date.now() - started}`,
      `checkpointChars=${summaryText.length}`,
      `checkpointTokensEstimate=${estimateTokens(summaryText)}`,
      `outcome=${audit === null ? "(shipped summarizer)" : "continuum"}`,
      `mode=${audit?.mode ?? "?"}`,
      `units=${audit?.units ?? "?"}`,
      `candidates=${audit?.candidates ?? "?"}`,
      `kept=${audit?.kept ?? "?"}`,
      `auditCheckpointTokens=${audit?.checkpointTokens ?? "?"}`,
      `nextStepSource=${audit?.nextStepSource ?? "?"}`,
      `retention=${audit?.retention === null || audit?.retention === undefined ? "none" : `${audit.retention.userMessages}u/${audit.retention.recentUnits}r ${audit.retention.tokens}tok`}`,
      `certificate=${JSON.stringify(audit?.certificate ?? null)}`,
      `extractionError=${audit?.extractionError === null || audit?.extractionError === undefined ? "none" : audit.extractionError}`,
      `extractorUsage=${usage === undefined ? "none" : `cached:${usage.cacheReadTokens ?? 0} uncached:${usage.inputTokens ?? 0} output:${usage.outputTokens ?? 0}`}`,
      `fallbackReason=${result?.__continuumFallbackReason ?? "none"}`,
    ].join(" ");
  }

  // -- accounting ----------------------------------------------------------
  #record(session) {
    const id = session?.id;
    if (typeof id !== "string") return null;
    let record = this.#records.get(id);
    if (record === undefined) {
      record = emptyRecord();
      this.#records.set(id, record);
    }
    return record;
  }

  #registerAccounting() {
    const { ctx } = this;
    ctx.on("session/event", (session, event) => {
      const record = this.#record(session);
      if (record === null) return;
      switch (event?.type) {
        case "assistant/message": {
          const usage = event.data?.usage;
          if (usage === undefined) return;
          record.requests += 1;
          record.missTokens += usage.inputTokens ?? 0;
          record.hitTokens += usage.cacheReadTokens ?? 0;
          record.outputTokens += usage.outputTokens ?? 0;
          if (record.pendingPublication) {
            record.pendingPublication = false;
            const last = record.compactions[record.compactions.length - 1];
            if (last !== undefined && last.publicationMissTokens === null) {
              last.publicationMissTokens = usage.inputTokens ?? 0;
              if (this.continuum.logDecisions) {
                this.ctx.logger.info(
                  `${PLUGIN}: checkpoint publication cost ${last.publicationMissTokens} uncached input tokens (session ${session.id})`,
                );
              }
            }
          }
          return;
        }
        case "compaction/summary":
          record.pendingSummary = event.data ?? null;
          return;
        case "compaction/end": {
          if (event.data?.error !== undefined) {
            record.pendingSummary = null;
            return;
          }
          const summary = record.pendingSummary;
          record.pendingSummary = null;
          record.compactions.push({
            seq: event.seq,
            at: Date.now(),
            shadowedNodes: Array.isArray(summary?.sourceEventSeqs) ? summary.sourceEventSeqs.length : null,
            publicationMissTokens: null,
          });
          if (record.compactions.length > this.continuum.maxRecordedCompactions) record.compactions.shift();
          record.pendingPublication = true;
          return;
        }
        default:
          return;
      }
    });
  }

  #note(session, outcome, audit) {
    if (this.#syntheticDepth > 0) return;
    const record = this.#record(session);
    if (record === null) return;
    if (outcome === "compiled") record.compiled += 1;
    else record.fallback += 1;
    record.lastAudit = { outcome, ...audit, at: Date.now() };
    if (!this.continuum.logDecisions) return;
    if (outcome === "compiled") {
      this.ctx.logger.info(
        `${PLUGIN}: compiled checkpoint ${audit.kept}/${audit.candidates} candidates from ${audit.units} units (~${audit.checkpointTokens} tokens, mode=${audit.mode})`,
      );
    } else {
      this.ctx.logger.warn(`${PLUGIN}: structural compile failed (${audit.reason}); using the shipped summarizer`);
    }
  }

  // -- the sole customization hook -----------------------------------------

  /**
   * Replace the shipped free-form summary with a structurally reduced, fully
   * cited checkpoint. Any failure degrades to the shipped summarizer.
   */
  async summarize(input, agent, signal) {
    const fallback = () =>
      (this.__baseSummarize ?? BasicCompactionEngine.prototype.summarize).call(this, input, agent, signal);
    return this.#runSummarize(this, input, agent, signal, fallback);
  }

  /**
   * Install this compressor on the shipped backend's single documented
   * customization hook.
   *
   * The desktop app moves the compaction backend into the agent-preset plane,
   * where each preset mounts its own `@deepseek-ai/dsh-compaction-basic`
   * instance behind an isolated `compaction` service. A Host-plane provider is
   * therefore invisible to the engine that actually compacts a session, and
   * there is no composition seam from this bundle into a preset declaration.
   * The documented seam that both planes share is `BasicCompactionEngine`'s
   * sole subclass hook: `regionDependencies()` dispatches through
   * `this.summarize(...)`, so replacing that one prototype method makes every
   * shipped instance — Host or preset — run this compressor while keeping the
   * durable bracket, the lock, the overflow recovery and the warm-prefix replay
   * exactly as shipped. Unloading restores the original method.
   */
  #installEngineHook() {
    const proto = BasicCompactionEngine.prototype;
    const current = proto.summarize;
    if (current?.__continuumHook === true) {
      this.__baseSummarize = current.__continuumOriginal;
      this.__hookState = "already-installed";
      return;
    }
    const owner = this;
    const original = current;
    const patched = async function summarize(input, agent, signal) {
      return owner.#runSummarize(this, input, agent, signal, () => original.call(this, input, agent, signal));
    };
    patched.__continuumHook = true;
    patched.__continuumOriginal = original;
    proto.summarize = patched;
    this.__baseSummarize = original;
    this.__hookState = "installed";
    this.ctx.effect(
      () => () => {
        if (proto.summarize === patched) {
          proto.summarize = original;
          owner.__hookState = "uninstalled";
        }
      },
      `${PLUGIN}: basic-engine summarize hook`,
    );
  }

  /** One compile attempt plus the shipped fallback, shared by both entry paths. */
  async #runSummarize(target, input, agent, signal, fallback) {
    if (this.continuum.mode === "off") return fallback();
    try {
      const call = async (instruction, maxTokens) =>
        this.#callExtractor(target, input, agent, instruction, maxTokens, signal);
      const compiled = await compileCheckpoint(input, {
        mode: this.continuum.mode,
        queryText: this.#currentQueryText(agent),
        extractorMaxTokens: this.continuum.extractorMaxTokens,
        checkpointMaxTokens: this.continuum.checkpointMaxTokens,
        verbatimTokens: this.continuum.verbatimTokens,
        selectionThreshold: this.continuum.selectionThreshold,
        minKeep: this.continuum.minKeep,
        callModel: call,
      });
      this.#note(agent?.session, "compiled", compiled.audit);
      return {
        summary: [{ type: "text", text: compiled.text }],
        rawOutput: [{ type: "text", text: JSON.stringify(compiled.audit) }],
        ...(compiled.call === undefined
          ? {}
          : {
              provider: compiled.call.provider,
              model: compiled.call.model,
              maxTokens: compiled.call.maxTokens,
              ...(compiled.call.usage === undefined ? {} : { usage: compiled.call.usage }),
            }),
      };
    } catch (error) {
      const reason = String(error?.message ?? error);
      this.#note(agent?.session, "fallback", { reason });
      const result = await fallback();
      if (this.#syntheticDepth > 0 && result !== null && typeof result === "object") {
        // Diagnostic-only: let the self-test report why the compressor declined.
        try {
          result.__continuumFallbackReason = reason;
        } catch {
          /* a frozen result simply keeps quiet */
        }
      }
      return result;
    }
  }

  /** Resolve the auxiliary call route with the shipped precedence. */
  #summarizeTarget(target, agent) {
    const configured =
      (target.config?.summarizationProvider ?? "").length > 0
        ? { provider: target.config.summarizationProvider, model: target.config.summarizationModel }
        : undefined;
    const latest = agent?.session?.requestHeader?.()?.config;
    const options = agent?.options ?? {};
    const fromAgent =
      typeof options.provider === "string" && typeof options.model === "string"
        ? { provider: options.provider, model: options.model }
        : undefined;
    const resolved = configured ?? latest ?? fromAgent;
    if (resolved?.provider === undefined || resolved?.model === undefined) {
      throw new Error(`${PLUGIN}: no provider/model available for extraction; route one request first`);
    }
    return resolved;
  }

  /** The request that triggered this compaction: its text is the structural load. */
  #currentQueryText(agent) {
    try {
      const messages = agent?.session?.deriveMessages?.() ?? [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "user") continue;
        const content = Array.isArray(message.content) ? message.content : [];
        const text = content
          .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
          .join(" ")
          .trim();
        if (text.length > 0) return text.slice(0, 4000);
      }
    } catch {
      /* load is optional; an empty query just makes the activation uniform */
    }
    return "";
  }

  /**
   * Replay the conversation's own prefix so the extraction call reuses the
   * provider's warm cache: same system prompt, same tools, same shadowed
   * messages, only the trailing instruction differs.
   */
  async #callExtractor(target, input, agent, instruction, maxTokens, signal) {
    const route = this.#summarizeTarget(target, agent);
    const assembler = new BlockAssembler();
    const messages = [
      ...input.messages,
      deepFreeze({ role: "user", content: [{ type: "text", text: instruction }] }),
    ];
    const options = {
      provider: route.provider,
      model: route.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens,
      sessionId: agent.session.id,
      purpose: "compaction",
      ...(signal === undefined ? {} : { signal }),
    };
    for await (const chunk of target.ctx.llm.stream(options)) assembler.push(chunk);
    const finish = assembler.finish;
    if (finish?.kind === "error" || finish?.kind === "aborted") {
      throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
    }
    if (finish?.kind === "max-tokens") {
      const error = new Error("extraction truncated at the token cap");
      error.code = "MAX_TOKENS";
      throw error;
    }
    const rawOutput = assembler.blocks();
    if (contentHasImage(rawOutput)) throw new LlmError("checkpoint compilation cannot contain image output", "UNSUPPORTED_CONTENT");
    const text = rawOutput
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length === 0) throw new Error("extraction produced no text content");
    return {
      text,
      provider: route.provider,
      model: route.model,
      maxTokens,
      usage: assembler.usage,
    };
  }

  // -- operator surface ----------------------------------------------------

  #registerCommands() {
    const { ctx } = this;
    const engine = this;
    ctx.effect(
      () =>
        ctx.commands.register({
          definitionId: `${PLUGIN}:status`,
          name: "context_status",
          description:
            "Show context pressure, compaction policy, structural compile statistics and real provider cache accounting. Reports no conversation content.",
          handler: (invocation) => this.#guarded("/context_status", () => this.#statusReport(invocation)),
        }),
      `${PLUGIN}: /context_status`,
    );
    ctx.effect(
      () =>
        ctx.commands.register({
          definitionId: `${PLUGIN}:inspect`,
          name: "context_inspect",
          description:
            "Show the content-free compaction ledger: cut seqs, publication cost, structural audit and certificate results.",
          handler: (invocation) => this.#guarded("/context_inspect", () => this.#inspectReport(invocation)),
        }),
      `${PLUGIN}: /context_inspect`,
    );
    // Self-contained on-demand condensation: do not depend on the shipped
    // command-compact row, whose bundle layer disables it for the desktop app.
    ctx.effect(() => {
      try {
        return ctx.commands.register({
          definitionId: `${PLUGIN}:compact`,
          name: "compact",
          description: "Condense this conversation now with the structural compressor.",
          handler: async (invocation) => {
            try {
              const result = await engine.compactNow(invocation.agent, invocation.signal);
              if (result === null) return { kind: "success", text: "nothing could be condensed safely" };
              return {
                kind: "success",
                text: `condensed ${result.shadowedSeqs.length} surface nodes (seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`,
              };
            } catch (error) {
              return { kind: "error", text: String(error?.message ?? error) };
            }
          },
        });
      } catch (error) {
        ctx.logger.warn(`${PLUGIN}: /compact is already registered (${String(error?.message ?? error)}); keeping the existing command`);
        return () => {};
      }
    }, `${PLUGIN}: /compact`);
  }

  /**
   * Keep one report failure from taking down the command channel: report the
   * failure text (and the stack head) as an ordinary error result instead of
   * letting the handler reject into a bare GUI toast.
   */
  async #guarded(label, fn) {
    try {
      return await fn();
    } catch (error) {
      const stack = String(error?.stack ?? "").split("\n").slice(1, 6).join("\n");
      return {
        kind: "error",
        text: `${label} failed: ${String(error?.message ?? error)}${stack.length > 0 ? `\n${stack}` : ""}`,
      };
    }
  }

  /**
   * The engine that actually compacts the agent's session.
   *
   * The desktop app isolates compaction inside the agent-preset plane, so the
   * Host-plane provider is not the one doing the work. The registry is the only
   * public way to read that service.
   */
  #backendFor(agent) {
    try {
      const isolated = this.ctx.get("agentPresets")?.serviceFor?.(agent, "compaction");
      if (isolated !== undefined) return isolated;
    } catch {
      /* registry absent (non-desktop composition): fall through */
    }
    try {
      return agent?.ctx?.get?.("compaction");
    } catch {
      return undefined;
    }
  }

  async #statusReport(invocation) {
    const agent = invocation?.agent;
    const session = agent?.session;
    if (session === undefined) return { kind: "error", text: "no active session" };
    const record = this.#records.get(session.id) ?? emptyRecord();
    const measurement = this.ctx.tokenMeter.measure(session);
    const backend = this.#backendFor(agent);
    // Report the policy of the engine that actually compacts, not this plugin's
    // Host-plane row (which the preset plane does not read).
    const policy = backend?.config ?? this.config;
    const routed = session.requestHeader?.()?.config;
    let window = 0;
    let reserved = 0;
    let route = "(not routed yet)";
    if (routed !== undefined) {
      route = `${routed.provider}/${routed.model}`;
      try {
        const info = await this.ctx.llm.resolveModelInfo(routed.provider, routed.model, invocation.signal);
        window = info?.context?.contextWindow ?? 0;
        reserved = routed.maxTokens ?? info?.defaultMaxTokens ?? 0;
      } catch (error) {
        return { kind: "error", text: `cannot resolve route ${route}: ${String(error?.message ?? error)}` };
      }
    }
    const headroom = policy.headroomTokens ?? 0;
    const threshold = window > 0 ? Math.floor(Math.min(window * policy.thresholdRatio, window - reserved - headroom)) : 0;
    const retain = policy.retainTokens ?? (window > 0 ? Math.floor((window - reserved) * policy.retainRatio) : 0);
    const pressure = window > 0 ? (measurement.totalTokens / window) * 100 : 0;
    const prompt = record.hitTokens + record.missTokens;
    const hit = prompt > 0 ? (record.hitTokens / prompt) * 100 : 0;
    const missEquivalent = Math.round(record.missTokens + record.hitTokens * 0.1);
    const last = record.compactions[record.compactions.length - 1];
    const audit = record.lastAudit;
    const lines = [
      `backend            : ${PLUGIN} ${VERSION} (mode=${this.continuum.mode}, extractor-msgs≤${this.continuum.extractorMaxTokens}, checkpoint≤${this.continuum.checkpointMaxTokens} tokens, verbatim-retention≤${this.continuum.verbatimTokens})`,
      `hook               : ${this.__hookState} on @deepseek-ai/dsh-compaction-basic; active engine ${backend === undefined ? "unknown" : backend.__continuum === PLUGIN ? "this plugin (Host plane)" : "shipped BasicCompactionEngine (preset plane, hooked)"}`,
      `route              : ${route}`,
      `context window     : ${window > 0 ? window : "unknown"} (reserved output ${reserved}, headroom ${headroom})`,
      `trigger threshold  : ${threshold > 0 ? threshold : "unknown"} tokens (ratio ${policy.thresholdRatio})`,
      `retained verbatim  : ${retain} tokens on automatic compaction; manual /compact cuts deeper`,
      `current context    : ${measurement.totalTokens} tokens (${window > 0 ? pressure.toFixed(1) : "?"}% of window, ${threshold > 0 ? Math.max(0, threshold - measurement.totalTokens) : "?"} below trigger)`,
      `compactions        : ${record.compactions.length}; last ${last === undefined ? "none" : `at seq ${last.seq}, ${last.shadowedNodes ?? "?"} shadowed nodes, one-time re-read ${last.publicationMissTokens ?? "pending"} tokens`}`,
      `structural compile : ${record.compiled} compiled / ${record.fallback} fell back`,
      `last audit         : ${audit == null ? "none" : `${audit.outcome} mode=${audit.mode ?? "?"} units=${audit.units ?? "?"} candidates=${audit.candidates ?? "?"} kept=${audit.kept ?? "?"} checkpoint≈${audit.checkpointTokens ?? "?"} tokens nextStep=${audit.nextStepSource ?? "?"} retained=${audit.retention?.userMessages ?? "?"}u/${audit.retention?.recentUnits ?? "?"}r (${audit.retention?.tokens ?? "?"} tokens) certificate=${JSON.stringify(audit.certificate ?? null)}`}`,
      `extractor call     : ${audit?.extractor?.usage === undefined ? "none" : `${audit.extractor.usage.cacheReadTokens ?? 0} cached / ${audit.extractor.usage.inputTokens ?? 0} uncached input tokens`}`,
      `cache accounting   : ${record.requests} requests, hit ${hit.toFixed(2)}% (${record.hitTokens} cached / ${record.missTokens} uncached), miss-equivalent ${missEquivalent} tokens`,
      `cache note         : one publication rewrites everything after the stable prefix, so exactly one request pays a full re-read; keep publications rare and deep`,
    ];
    return { kind: "success", text: lines.join("\n") };
  }

  async #inspectReport(invocation) {
    const session = invocation?.agent?.session;
    if (session === undefined) return { kind: "error", text: "no active session" };
    const record = this.#records.get(session.id) ?? emptyRecord();
    const measurement = this.ctx.tokenMeter.measure(session);
    const backend = this.#backendFor(invocation?.agent);
    const lines = [
      `session            : ${session.id}`,
      `context            : ${measurement.totalTokens} tokens`,
      `active engine      : ${backend === undefined ? "unknown" : backend.__continuum === PLUGIN ? "this plugin (Host plane)" : "shipped BasicCompactionEngine (preset plane, hooked)"}`,
      `checkpoint budget  : ≤${this.continuum.checkpointMaxTokens} structural tokens + ≤${this.continuum.verbatimTokens} verbatim-retention tokens; extractor budget ≤${this.continuum.extractorMaxTokens} tokens`,
      `selection policy   : threshold=${this.continuum.selectionThreshold}·max response, minKeep=${this.continuum.minKeep}`,
      `last audit         : ${record.lastAudit == null ? "none" : JSON.stringify(record.lastAudit)}`,
      `publication ledger :`,
    ];
    if (record.compactions.length === 0) lines.push("  (no checkpoint published in this session)");
    else {
      for (const entry of record.compactions.slice(-8)) {
        lines.push(`  seq ${entry.seq}  shadowed ${entry.shadowedNodes ?? "?"} nodes  one-time re-read ${entry.publicationMissTokens ?? "pending"} tokens`);
      }
    }
    lines.push("certificates: supports preserved, dependency closure complete, condensation reconstructs the full response");
    return { kind: "success", text: lines.join("\n") };
  }
}

