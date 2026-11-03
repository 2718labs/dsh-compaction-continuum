/**
 * Offline pipeline test: no Host, no provider. A fake `callModel` stands in for
 * the one extraction call, so the structural solve, certification and rendering
 * can be verified independently.
 */
import { compileCheckpoint, segmentMessages, validateAtoms } from "../lib/pipeline.js";

let failures = 0;
function checkTrue(name, value, detail = "") {
  console.log(`${value ? "PASS" : "FAIL"}  ${name}${value ? "" : `  ${detail}`}`);
  if (!value) failures += 1;
}
function checkLine(name, text, needle) {
  checkTrue(`${name} contains ${JSON.stringify(needle)}`, text.includes(needle));
}
function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const rest = text.indexOf("\n## ", start + 1);
  return text.slice(start, rest < 0 ? undefined : rest);
}

const messages = [
  { role: "system", content: [{ type: "text", text: "You are a coding agent. Tools: read, edit, bash." }] },
  {
    role: "user",
    content: [{ type: "text", text: "请把 G:/proj/src/router.ts 里的 route table 改成惰性注册，并且保留 /api/health。" }],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "我先看 router.ts 的现状：它用了即时注册，受 tools/registry.ts 的 order 约束。决定：改成分阶段惰性注册，避免改动 /api/health。",
      },
      { type: "tool-call", name: "read", arguments: '{"path":"G:/proj/src/router.ts"}' },
    ],
  },
  {
    role: "tool",
    content: [{ type: "text", text: "export const routes = [\n  { path: '/api/health', handler: health },\n  { path: '/api/user', handler: user },\n]" }],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "已确认：router.ts 的 routes 是静态数组，/api/health 在第一位。下一步是把数组转成 registerLazy() 并保持顺序。错误码 E_ROUTE_DUP 出现在 registry.ts:88。",
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: "改吧，注意别破坏缓存率。" }] },
  { role: "assistant", content: [{ type: "text", text: "正在改 router.ts，等待结构测试结果。" }] },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: Array.from(
          { length: 20 },
          (_, index) => `步骤 ${index}: 检查 G:/proj/src/router.ts 的静态路由表，记录 /api/health 的顺序约束，确认 registry.ts 的注册时机。`,
        ).join("\n"),
      },
    ],
  },
  { role: "user", content: [{ type: "text", text: "继续。" }] },
];

const { head, units } = segmentMessages(messages);
checkTrue("system head is separated", head.length === 1);
checkTrue("units segmented", units.length === 8, `got ${units.length}`);

// --- quote validation is mechanical -----------------------------------------
const good = validateAtoms(
  {
    atoms: [
      { kind: "anchor", text: "router.ts 路径", quote: "G:/proj/src/router.ts" },
      { kind: "anchor", text: "health 路由必须保留", quote: "/api/health" },
      { kind: "decision", text: "改为惰性注册", quote: "改成分阶段惰性注册" },
      { kind: "error_fix", text: "重复路由错误码", quote: "E_ROUTE_DUP" },
    ],
  },
  units,
);
checkTrue("exact quotes are accepted", good.accepted === 4, JSON.stringify(good));
const bad = validateAtoms(
  { atoms: [{ kind: "anchor", text: "编造的路径", quote: "G:/proj/src/does-not-exist.ts" }] },
  units,
);
checkTrue("a paraphrased or invented quote is rejected", bad.accepted === 0 && bad.rejected === 1);

// --- extract mode -----------------------------------------------------------
const extraction = JSON.stringify({
  atoms: [
    { kind: "goal", text: "把 router.ts 的 route table 改成惰性注册", quote: "route table 改成惰性注册" },
    { kind: "anchor", text: "目标文件", quote: "G:/proj/src/router.ts" },
    { kind: "constraint", text: "必须保留 /api/health", quote: "保留 /api/health" },
    { kind: "decision", text: "分阶段惰性注册，避免改动 health", quote: "改成分阶段惰性注册" },
    { kind: "file", text: "routes 是静态数组，health 在第一位", quote: "export const routes" },
    { kind: "error_fix", text: "E_ROUTE_DUP 在 registry.ts:88", quote: "E_ROUTE_DUP" },
    { kind: "progress", text: "正在改 router.ts", quote: "正在改 router.ts" },
    { kind: "open_loop", text: "等待结构测试结果", quote: "等待结构测试结果" },
    { kind: "preference", text: "不要破坏缓存率", quote: "别破坏缓存率" },
  ],
});

let calls = 0;
const extractResult = await compileCheckpoint(
  { messages },
  {
    mode: "extract",
    checkpointMaxTokens: 200,
    queryText: "继续改 router.ts，注意缓存率",
    callModel: async () => {
      calls += 1;
      return extraction;
    },
  },
);
checkTrue("exactly one model call in extract mode", calls === 1, `calls=${calls}`);
checkTrue("checkpoint is produced", extractResult.text.length > 0);
checkLine("checkpoint", extractResult.text, "## Primary Request and Intent");
checkLine("checkpoint", extractResult.text, "## Verbatim Anchors");
checkLine("checkpoint", extractResult.text, "G:/proj/src/router.ts");
checkLine("checkpoint", extractResult.text, "E_ROUTE_DUP");
checkTrue("audit records extraction", extractResult.audit.mode === "extract" && extractResult.audit.kept > 0, JSON.stringify(extractResult.audit));
checkTrue("certificate passes", extractResult.audit.certificate.condensationExact === true);
checkTrue("checkpoint shrinks the source", extractResult.audit.checkpointTokens < extractResult.audit.sourceTokens, JSON.stringify(extractResult.audit));

// --- deterministic mode (no model call at all) -------------------------------
let deterministicCalls = 0;
const deterministic = await compileCheckpoint(
  { messages },
  {
    mode: "deterministic",
    queryText: "继续改 router.ts",
    callModel: async () => {
      deterministicCalls += 1;
      return "{}";
    },
  },
);
checkTrue("deterministic mode never calls the model", deterministicCalls === 0, `calls=${deterministicCalls}`);
checkTrue("deterministic mode still produces a checkpoint", deterministic.text.length > 0);
checkTrue(
  "deterministic mode anchors a next step",
  deterministic.audit.certificate.nextStepAnchored === true && section(deterministic.text, "Next Step").includes("Continue the latest request"),
  JSON.stringify(section(deterministic.text, "Next Step")),
);

// --- garbage extraction degrades to deterministic ----------------------------
const degraded = await compileCheckpoint(
  { messages },
  { mode: "extract", queryText: "继续", checkpointMaxTokens: 200, callModel: async () => "not json at all" },
);
checkTrue("garbage extraction degrades to deterministic", degraded.audit.mode === "deterministic");

// --- a throwing extractor degrades too ---------------------------------------
const thrown = await compileCheckpoint(
  { messages },
  {
    mode: "extract",
    checkpointMaxTokens: 200,
    queryText: "继续",
    callModel: async () => {
      throw new Error("provider down");
    },
  },
);
checkTrue("extractor failure degrades to deterministic", thrown.audit.mode === "deterministic" && thrown.audit.extractionError !== null);

// --- idempotence: same input, same checkpoint -------------------------------
const again = await compileCheckpoint(
  { messages },
  { mode: "extract", checkpointMaxTokens: 200, queryText: "继续改 router.ts，注意缓存率", callModel: async () => extraction },
);
checkTrue("deterministic render is byte-identical for the same atoms", again.text === extractResult.text);

// --- the extraction call's envelope is carried into the audit ---------------
const callUsage = { inputTokens: 11, cacheReadTokens: 900, outputTokens: 40 };
const withCall = await compileCheckpoint(
  { messages },
  {
    mode: "extract",
    checkpointMaxTokens: 200,
    queryText: "继续改 router.ts",
    callModel: async () => ({ text: extraction, provider: "p", model: "m", maxTokens: 1234, usage: callUsage }),
  },
);
checkTrue(
  "extraction envelope is reported back",
  withCall.call?.provider === "p" && withCall.call?.model === "m" && withCall.call?.maxTokens === 1234,
  JSON.stringify(withCall.call),
);
checkTrue(
  "extraction usage reaches the audit",
  withCall.audit.extractor?.usage?.cacheReadTokens === 900,
  JSON.stringify(withCall.audit.extractor),
);

// --- continuation: the Next Step section is never empty ----------------------
checkTrue(
  "extracted checkpoints quote the latest request when no next-step atom exists",
  section(extractResult.text, "Next Step").includes('"继续。"'),
  JSON.stringify(section(extractResult.text, "Next Step")),
);
checkTrue("audit reports the deterministic floor source", extractResult.audit.nextStepSource === "latest-request", String(extractResult.audit.nextStepSource));
checkTrue("certificate records the next-step anchor", extractResult.audit.certificate.nextStepAnchored === true);

const withNextStep = JSON.stringify({
  atoms: [
    ...JSON.parse(extraction).atoms,
    { kind: "next_step", text: "把静态数组改为 registerLazy() 并保留 health 顺序", quote: "下一步是把数组转成 registerLazy()" },
  ],
});
const stepped = await compileCheckpoint(
  { messages },
  { mode: "extract", checkpointMaxTokens: 400, queryText: "继续改 router.ts", callModel: async () => withNextStep },
);
checkTrue("a next-step atom is reported as the anchor source", stepped.audit.nextStepSource === "atom", String(stepped.audit.nextStepSource));
checkLine("next-step checkpoint", section(stepped.text, "Next Step"), "registerLazy()");

// --- the floor strips request-time scaffolding --------------------------------
const scaffolded = [
  ...messages,
  {
    role: "user",
    content: [{
      type: "text",
      text: "继续完成迁移。\n\nCurrent runtime context. This request-time snapshot must not become the next step.\n<system-reminder>tool catalog changed</system-reminder>",
    }],
  },
];
const scaffoldResult = await compileCheckpoint(
  { messages: scaffolded },
  { mode: "deterministic", checkpointMaxTokens: 1200, queryText: "继续" },
);
const scaffoldStep = section(scaffoldResult.text, "Next Step");
checkTrue(
  "the floor quotes the request, not its scaffolding",
  scaffoldStep.includes("继续完成迁移。") && !scaffoldStep.includes("Current runtime context"),
  JSON.stringify(scaffoldStep),
);

// --- span without a user message anchors the latest state --------------------
const assistantOnly = [
  { role: "system", content: [{ type: "text", text: "You are a coding agent." }] },
  {
    role: "assistant",
    content: [{
      type: "text",
      text: Array.from(
        { length: 12 },
        (_, index) => `第 ${index} 步：检查 G:/proj/src/router.ts 的静态路由表并记录 /api/health 的顺序约束。`,
      ).join("\n"),
    }],
  },
  { role: "tool", content: [{ type: "text", text: "test output: 3 passed, 0 failed" }] },
];
const stateResult = await compileCheckpoint({ messages: assistantOnly }, { mode: "deterministic", checkpointMaxTokens: 1200, queryText: "" });
checkTrue(
  "no-user spans anchor the latest recorded state",
  section(stateResult.text, "Next Step").includes("Continue from the latest recorded state"),
  JSON.stringify(section(stateResult.text, "Next Step")),
);
checkTrue("audit reports the latest-state source", stateResult.audit.nextStepSource === "latest-state", String(stateResult.audit.nextStepSource));

// --- long task: the next step survives repeated generations ------------------
let generationMessages = [...messages];
for (let generation = 1; generation <= 3; generation += 1) {
  const request = `继续第 ${generation} 阶段：保持 /api/health 顺序。`;
  const progress = `进度：第 ${generation} 阶段完成，G:/proj/src/router.ts 已改到第 ${generation} 步。`;
  const span = [
    ...generationMessages,
    { role: "assistant", content: [{ type: "text", text: progress }] },
    { role: "user", content: [{ type: "text", text: request }] },
  ];
  const atoms = JSON.stringify({
    atoms: [
      { kind: "progress", text: `第 ${generation} 阶段完成`, quote: `第 ${generation} 阶段完成` },
      { kind: "anchor", text: "目标文件", quote: "G:/proj/src/router.ts" },
      { kind: "constraint", text: "保留 /api/health 顺序", quote: "保持 /api/health 顺序" },
      { kind: "goal", text: `继续第 ${generation} 阶段`, quote: `继续第 ${generation} 阶段` },
    ],
  });
  const result = await compileCheckpoint(
    { messages: span },
    { mode: "extract", checkpointMaxTokens: 600, queryText: request, callModel: async () => atoms },
  );
  const step = section(result.text, "Next Step");
  checkTrue(`generation ${generation} keeps the next step`, step.includes(`继续第 ${generation} 阶段`), JSON.stringify(step));
  checkTrue(`generation ${generation} certificates the continuation`, result.audit.certificate.nextStepAnchored === true);
  generationMessages = [
    { role: "system", content: messages[0].content },
    {
      role: "user",
      content: [{
        type: "text",
        text: `This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n<compacted-summary>\n${result.text}\n</compacted-summary>`,
      }],
    },
  ];
}

console.log(failures === 0 ? "\nALL PIPELINE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
