# dsh-compaction-continuum

[English](./README.md) | 简体中文

[![Version](https://img.shields.io/badge/version-v0.3.0-A44742)](./CHANGELOG.md)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5-1F6B5B)](https://github.com/deepseek-ai)
[![License](https://img.shields.io/badge/license-MIT-263238)](./LICENSE)
[![CI](https://github.com/2718labs/dsh-compaction-continuum/actions/workflows/ci.yml/badge.svg)](https://github.com/2718labs/dsh-compaction-continuum/actions/workflows/ci.yml)

**结构性压缩 · Structural Compression** —— DeepSeek Harness 的上下文压缩后端。

> 像结构一样压缩，而不是像摘要一样压缩。
>
> 模型只允许引用；承载与否由算术决定。

它不请模型写自由摘要，而是把对话当成一栋结构：候选块是自由度，证据耦合是刚度，当前提问是载荷，精确锚点与未关闭事项是支座，压缩就是一次**静力凝聚**——保留承载自由度、消去其余，并且在发布前给出重构证书。checkpoint 由"已核验为原文子串"的引文确定性拼装，从不出现模型自由撰写的正文。

官方引擎仍然拥有全部持久化语义：事务、锁、溢出恢复、保留尾部、warm-prefix 重放。本插件只替换"checkpoint 内容怎么产生"。

## 状态

- `0.3.0`，首个公开版本，已在 DeepSeek Harness `0.2.1-rc.5`（打包桌面版，Windows）上验证。
- 它是普通 Host bundle，不修改 Harness 本体。
- 压缩器安装在官方后端唯一被文档化的定制钩子上，卸载时还原。该 seam 若在未来版本变形，插件 fail-open 回官方摘要，而不是弄坏会话。

## 它做什么

一次模型调用 + 纯本地算术：

```
被遮蔽段
 └─ 1 次模型调用：抽取"带引文的原子" {kind, text, unit, 逐字 quote}
       └ 机械校验：quote 必须逐字出现在重放原文里，找不到就丢弃该 atom
 └─ 建结构：atom=自由度；共享来源/相邻/同类=刚度；当前提问=载荷；锚点/未关闭事项=支座
 └─ 求解  [K Cᵀ; C 0][u;λ] = [f;d]（KKT）
 └─ 静力凝聚：保留承载自由度、消去其余，并导出重构算子
 └─ 证书：支座未消去、选出的一致、凝聚可重构完整响应——否则不发布
 └─ 确定性渲染：按预算打包保留的 atom → checkpoint
```

**fail-open 阶梯**：结构编译 → 确定性渲染（零模型调用）→ 官方 LLM 摘要。会话永远有 checkpoint。

抽取调用复用会话自己的前缀：同一 system prompt、同一工具目录、同一历史，只在尾部追加指令；它不引入专门的摘要 system prompt，也不换模型，因此只要压缩紧挨着一次请求发生，provider 前缀缓存就是热的。

## 它挂在哪（重要）

桌面版把压缩后端放进 **agent preset 平面**：每个 preset 在隔离的 `compaction` 服务组里自带一个官方 `@deepseek-ai/dsh-compaction-basic`，Host 平面的 provider 对它不可见。两个平面共享的唯一 seam 是官方引擎唯一被文档化的子类钩子：

```
BasicCompactionEngine.prototype.summarize
  └─ regionDependencies() 每次压缩都动态走 this.summarize(...)
       └─ 已换成：抽取 → 结构 → 凝聚 → 确定性渲染
```

由此：

- 官方引擎的事务、空闲准入、溢出恢复、保留尾部策略、warm-prefix 重放全部按原样保留；
- 插件加载时安装替换，卸载时还原；
- 插件同时挂一个 Host 平面的 `compaction` provider，让没有 preset 平面的组合也能正常工作。

用自检确认当前生效的是哪个后端：

```json
"hook": {
  "installedOnShippedClass": true,
  "backendIsShippedClass": true,
  "backendUsesHookedSummarize": true
}
```

## 安装

要求：组合里暴露 `BasicCompactionEngine` seam 的 DeepSeek Harness 桌面版（已在 `0.2.1-rc.5` 验证），以及 profile 的写权限。

### 用插件管理器

像其它 profile bundle 一样，从 GitHub spec 安装：

```
target: github:2718labs/dsh-compaction-continuum#v0.3.0
```

建议锁 tag 或 commit。管理器会添加依赖、追加到 `dsh.profile.bundles`，并热应用补丁。

### 手动

在 `~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-compaction-continuum": "github:2718labs/dsh-compaction-continuum#v0.3.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-compaction-continuum"]
    }
  }
}
```

bundle 必须排在 `@deepseek-ai/dsh-web-app` **之后**，让补丁在 web 层关闭出厂后端行之后再应用。

### 验证

```powershell
# 存活 + 策略 + 钩子（回环、无需登录）
Invoke-WebRequest http://127.0.0.1:48483/compaction-continuum/ping -UseBasicParsing | Select-Object -Expand Content

# 完整无内容诊断
Invoke-RestMethod http://127.0.0.1:48483/compaction-continuum/selftest | ConvertTo-Json -Depth 8

# 端到端抽取契约：一次很小的合成模型调用，不读会话、不发布
Invoke-RestMethod 'http://127.0.0.1:48483/compaction-continuum/selftest?test=extract' |
  Select-Object -Expand probes | Where-Object name -eq 'extraction contract' | Select-Object -Expand value
```

把 `48483` 换成 `dsh web` 打印的端口。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/compact` | 立刻压缩当前会话。桌面端 preset 自带的同名命令会走到已挂钩的后端；本插件也注册了同名回退。 |
| `/context_status` | 压力、触发阈值、保留量、生效引擎、最近审计、抽取调用的缓存账、真实缓存命中率。无内容。 |
| `/context_inspect` | 无内容账本：切点 seq、发布代价、结构审计与证书结果。 |

`/context_status` 样例：

```
hook               : installed on @deepseek-ai/dsh-compaction-basic; active engine shipped BasicCompactionEngine (preset plane, hooked)
trigger threshold  : 727040 tokens (ratio 0.8)
retained verbatim  : 126812 tokens on automatic compaction; manual /compact cuts deeper
current context    : 273740 tokens (26.1% of window, 453300 below trigger)
last audit         : compiled mode=extract units=318 candidates=41 kept=27 checkpoint≈5837 tokens certificate={...}
extractor call     : 312480 cached / 640 uncached input tokens
cache accounting   : 123 requests, hit 99.24% (384347520 cached / 2935624 uncached)
```

## 配置

插件行配置的是**压缩器**；压缩策略（阈值、保留尾部）属于运行它的后端引擎：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `mode` | `extract` | `extract`（一次抽取调用 + 结构）/ `deterministic`（零模型调用）/ `off`（完全交还原官方摘要） |
| `extractorMaxTokens` | `12000` | 抽取调用输出上限 |
| `checkpointMaxTokens` | `6000` | checkpoint 预算 |
| `selectionThreshold` | `0.35` | 承载判定阈值（相对最大位移） |
| `minKeep` | `8` | 最少保留候选数 |
| `statusCommands` | `true` | 是否注册命令与回环诊断 |
| `maxRecordedCompactions` | `32` | 每会话保留的账本条目 |
| `logDecisions` | `true` | 是否记录编译决策 |

仅当本插件自己就是 `compaction` provider（非桌面组合）时生效的键，与官方后端一致：`thresholdRatio`、`headroomTokens`、`retainTokens`、`retainRatio`、`maxTokens`、`summarizationProvider/Model`、`compactionRetries`、`maxOverflowRetries`、`modelPolicies`、`auto`。桌面端实际运行的是 preset 引擎自己的策略，`/context_status` 会报告解析后的真实值。

## 缓存账

真实会话实测（27 个会话、4400+ 次请求，桌面版）：

| 观察 | 数值 |
| --- | --- |
| 稳态前缀缓存命中率 | 99.1% – 99.7% |
| 压缩后的一次性重读 | 新前缀读满一次，任何"改写历史"的压缩都躲不掉 |
| 空闲 49 分钟后的手动 `/compact` | 抽取调用付了 331,799 未命中 token（缓存已过期，任何设计都躲不掉） |
| 压缩重放 vs agent 自己的请求投影 | 完全一致：`live=399 replayed=399 identical=true` |
| 工具结果剪枝（`tool-result-pruner`） | 净缓存亏损：三轮共 ≈1.1M miss-equivalent——本压缩器自己不做剪枝（桌面端 preset 仍挂着出厂的剪枝器，不归本插件控制） |

实现遵守的硬规则：一个 epoch 只发布一次；绝不中途改写历史；宁可深切割不要频繁浅切割；由窗口压力而非轮数驱动；绝不故意对冷前缀做摘要。

## 已知限制

- 桌面端的阈值与保留尾部策略来自 preset 自带的官方引擎；手动 `/compact` 比自动压缩切得更深（官方引擎给它的保留量是 0）。
- 抽取若拿不出可核验的引文，checkpoint 退化为确定性结构渲染；若连缩小源都做不到，则走官方摘要。所以质量受抽取器引用纪律约束，证书证明的是结构自洽，不是信息论完备。
- 抽取调用要便宜，前缀缓存必须还热着；距上次请求过了几分钟到几小时再手动压缩，就要付一整次读。
- 钩子针对一个具体的官方 seam。它 fail-open，但未来 Harness 若重命名/挪走 `summarize`，行为会静默退回官方摘要——升级后用 `hook.backendUsesHookedSummarize` 确认。
- 桌面端 preset 的隔离子组里仍挂着出厂的 tool-result-pruner。真实会话实测它是净缓存亏损（三轮 ≈1.1M miss-equivalent）。要关掉它需要覆盖 preset 声明（即 `docs/DESIGN.zh-CN.md` §3 否决的方案二）；本 bundle 有意不做这件事。

## 开发

```bash
npm run check   # 语法
npm test        # 离线结构内核 + 流水线（30+ 断言，不需要 Harness）
```

目录：

```
lib/index.js            宿主半边：引擎钩子、命令、缓存记账、诊断
lib/pipeline.js         抽取 → 结构 → 渲染流水线（纯函数，可离线测试）
lib/structure/core.js   刚度装配 / KKT 求解 / 静力凝聚 / 证书
test/                   离线测试套件
docs/DESIGN.zh-CN.md    设计说明：结构模型、缓存账、钩子取舍
```

PR 必须保持的不变量见 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)。

## 安全与隐私

无埋点、不自行联网、不写磁盘状态。回环诊断无鉴权但不含会话内容；`statusCommands: false` 可关闭。详见 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)。

## 许可证

[MIT](./LICENSE) © 2026 2718Labs。
