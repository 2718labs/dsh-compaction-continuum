# dsh-compaction-continuum

[English](./README.md) | 简体中文

[![Version](https://img.shields.io/badge/version-v0.3.0-A44742)](./CHANGELOG.md)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5-1F6B5B)](https://github.com/deepseek-ai)
[![License](https://img.shields.io/badge/license-MIT-263238)](./LICENSE)
[![CI](https://github.com/2718labs/dsh-compaction-continuum/actions/workflows/ci.yml/badge.svg)](https://github.com/2718labs/dsh-compaction-continuum/actions/workflows/ci.yml)

DeepSeek Harness 的上下文压缩后端。中文名结构性压缩，英文 Structural Compression。

Harness 自带的压缩是让模型把历史读一遍、写一段摘要，然后把摘要塞回上下文。这个插件换了个做法：从原文里抽带逐字引文的句子，算一遍它们之间的"承重关系"，只把承重的、并且能对回原文的内容留下来。压缩量差不多，但发出去的东西你能查证。

## 我为什么写这个

动手之前我先算了笔账。长会话里压缩很少发生，但每次都很贵，我想弄清楚贵在哪。拿自己机器上 25 个会话的日志统计（3,515 次请求、9.97 亿 prompt token）：

- 平时缓存命中率 99.20%，这部分很便宜。
- 但官方每压一次，模型要按新内容的价格重读约 55 万 token 的历史。
- 怎么确认是重读而不是缓存过期：压缩前那一次请求命中 99.85%，只隔 0.1 秒；摘要请求却只命中开头 9,856 个 token。

55 万 token 大概是一本 400 页的书。每压一次，等于让它把这本书重读一遍。

我本来想让抽取调用也吃到缓存，试了，做不到：压缩时重放出来的请求和当时真实发出去的请求对不上，线上请求里有些日志没记的东西。所以现在给两条路：

- **`deterministic`**：压缩时完全不调模型，只做结构筛选。省掉那 55 万，代价是压出来的东西比较糙。
- **`extract`**：还是调一次模型，成本跟官方基本一样；但压缩结果里每一条都能追溯到原文，关键约束丢了会拒绝发布。

我自用开的是 `extract`，因为压缩后的内容我敢信。如果你更在意账单，`deterministic` 每次能省掉大约四分之三的输入。

## 压出来长什么样

用测试夹具的主题示意一下渲染结果（不是真实会话，格式是渲染器真实输出）：

```
## Primary Request and Intent
- 把 router.ts 的静态路由表改成惰性注册，保留 /api/health
- 用户提示：别破坏缓存率

## Critical Context
- 必须保留 /api/health
- 决定：分阶段惰性注册，避免改动 /api/health

## Verbatim Anchors
- 目标文件 — "G:/proj/src/router.ts"
- E_ROUTE_DUP 在 registry.ts:88 — "E_ROUTE_DUP"
```

带引号的那部分是原文的逐字引用。引文如果在原文里找不到，这条就进不了 checkpoint。模型只负责"挑句子并抄下来"，收尾的排版、预算控制、丢掉哪些，都是本地算的。

## 它怎么工作

一次压缩大概是这样：

1. 把要压的历史（连同 system prompt 和工具列表）原样重放给模型，末尾加一句指令，让它输出 JSON：每条一个 kind、一句摘要、以及一句必须在原文里逐字出现的 quote。
2. 本地校验每个 quote。找不到的丢弃，编造的丢弃。
3. 把留下的条目当自由度，来源相同的、相邻的、同类的连成刚度；当前提问当载荷；精确锚点和未关闭事项钉成支座。
4. 解一次 KKT，做静力凝聚，选出承重的那些。
5. 出证书：支座有没有被消掉、选的有没有自相矛盾、凝聚回去还是不是原来那个响应。任何一项不过就不发布。
6. 按预算渲染成 checkpoint。

任何一步出错都会往下退：结构算失败就纯本地渲染（不调模型），本地渲染也不行就交回官方摘要。会话不会因为压缩失败而没有 checkpoint。

## 它挂在 Harness 的哪里

这块要知道一下，因为它跟"正常插件"的挂法不一样。

桌面版把压缩后端放进了每个 agent preset 自己的隔离域里，Host 平面挂的 `compaction` 服务它看不见。所以插件没有去注册第二个 `compaction` 提供者，而是替换了官方引擎唯一对外承认的扩展点：`BasicCompactionEngine.prototype.summarize`。这个方法是官方压缩流程每次都会动态调的，换掉它，preset 平面的引擎也会走本插件的压缩器；官方的事务、锁、溢出恢复、保留尾部、重放都原样保留。插件卸载时会把原型方法还回去。

另外插件也在 Host 平面挂了一个 `compaction`，这样没有 preset 平面的组合也能正常用。

装完后跑自检，能看到实际生效的是哪个后端：

```json
"hook": {
  "installedOnShippedClass": true,
  "backendIsShippedClass": true,
  "backendUsesHookedSummarize": true
}
```

## 安装

需要桌面版 Harness，且组合里能拿到 `BasicCompactionEngine` 这个类（`0.2.1-rc.5` 上验证过）。

用插件管理器，把 GitHub 地址当 bundle 装：

```
target: github:2718labs/dsh-compaction-continuum#v0.3.0
```

手动的话，在 `~/.dsh/profiles/<profile>/package.json` 里加依赖和 bundle，bundle 要排在 `@deepseek-ai/dsh-web-app` 后面：

```json
{
  "dependencies": {
    "dsh-compaction-continuum": "github:2718labs/dsh-compaction-continuum#v0.3.0"
  },
  "dsh": { "profile": { "bundles": ["...", "dsh-compaction-continuum"] } }
}
```

装完在会话里发 `/context_status`，或者直接访问 `http://127.0.0.1:<端口>/compaction-continuum/ping`。

端口就是 `dsh web` 给你的那个，我这里是 48483。

## 命令

| 命令 | 干什么 |
| --- | --- |
| `/compact` | 立刻压一次。桌面端 preset 自带的同名命令会走到本插件的压缩器；插件自己也注册了一个同名回退。 |
| `/context_status` | 当前上下文多大、什么时候触发压缩、上次压缩的账、真实的缓存命中率。不输出对话内容。 |
| `/context_inspect` | 压缩账本：切了哪些段、发布花了多少、结构审计和证书结果。 |

`/context_status` 大概长这样：

```
hook               : installed on @deepseek-ai/dsh-compaction-basic; active engine shipped BasicCompactionEngine (preset plane, hooked)
trigger threshold  : 727040 tokens (ratio 0.8)
current context    : 273740 tokens (26.1% of window, 453300 below trigger)
last audit         : compiled mode=extract units=318 candidates=41 kept=27 checkpoint≈5837 tokens certificate={...}
extractor call     : 312480 cached / 640 uncached input tokens
cache accounting   : 123 requests, hit 99.24% (384347520 cached / 2935624 uncached)
```

## 配置

插件这行的配置只管压缩器；压缩阈值和保留多少原文，归实际运行它的那个官方引擎。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `mode` | `extract` | `extract` 调一次模型；`deterministic` 完全本地；`off` 交回官方摘要 |
| `extractorMaxTokens` | `12000` | 抽取调用的输出上限 |
| `checkpointMaxTokens` | `6000` | checkpoint 预算 |
| `selectionThreshold` | `0.35` | 承重判定阈值，相对于最大位移 |
| `minKeep` | `8` | 至少保留几条 |
| `statusCommands` | `true` | 注册命令和回环诊断 |
| `maxRecordedCompactions` | `32` | 每个会话记多少次压缩账 |
| `logDecisions` | `true` | 是否打编译日志 |

`thresholdRatio`、`retainTokens`、`maxTokens` 这些跟官方后端一样的键，只在本插件自己就是 `compaction` 提供者（没有 preset 平面的组合）时生效。桌面端实际用的是 preset 引擎自己的策略，`/context_status` 会显示真实值。

## 缓存账

具体方法和逐事件表格在 [证据文档](./docs/EVIDENCE.zh-CN.md) 里。这里只放结论：

| 观察 | 数值 |
| --- | --- |
| 稳态缓存命中率（25 个会话 / 3,515 次请求） | 99.20% |
| 官方自动压缩一次 | 额外输入约 72 万 token。其中约 55 万是重读历史，约 17 万是压完之后必然的那次重读 |
| 上述事件里的摘要调用 | 55 万 prompt 里只命中 0 到 9,856 个 token，而 0.1 到 12.8 秒前那次请求命中 99%+ |
| 空闲很久之后手动 `/compact` | 摘要调用 331,799 token 全未命中，缓存确实过期了，这个躲不掉 |
| 工具结果剪枝 | 三剪枝轮次省下 141,041 token，导致后面多读 1,675,192 token，约 12 倍。所以本插件不做剪枝 |

自己跑一遍看本机数字：

```bash
node bench/report.mjs
```

## 已知问题

- 桌面端的阈值和保留量来自 preset 自带的官方引擎。手动 `/compact` 比自动压缩切得深（官方给手动的保留量是 0）。
- 抽取如果拿不出可核验的引文，会退化成确定性渲染；确定性渲染如果连"比原文小"都做不到，就走官方摘要。所以质量受模型引用纪律的约束。证书证明的是结构自洽，不是信息论意义上的"信息没丢"。
- 抽取调用目前吃不到线上请求的缓存，所以 `extract` 跟官方成本持平。`deterministic` 绕开这次调用。真要让它便宜，得让重放跟线上请求逐字节一致，这需要日志里没有的请求期信息，列在路线图里，现在做不到。
- 钩子针对一个具体的官方方法。方法被改名或挪走的话，插件会静默退回官方摘要，不会弄坏会话——升级后用 `hook.backendUsesHookedSummarize` 确认一下。
- 桌面端 preset 里还挂着官方的工具结果剪枝器，实测是亏的，但这个插件不管它。要关得覆盖 preset 声明，那个方案在 `docs/DESIGN.zh-CN.md` 里写了为什么没做。

## 开发和测试

```bash
npm run check   # 语法检查
npm test        # 80 条离线断言，不需要装 Harness
node bench/report.mjs   # 用本机会话日志算缓存账
```

目录：

```
lib/index.js            宿主侧：引擎钩子、命令、缓存记账、诊断
lib/pipeline.js         抽取 → 结构 → 渲染
lib/structure/core.js   刚度装配、KKT、静力凝聚、证书
bench/                  读会话日志算账
test/                   离线测试
docs/DESIGN.zh-CN.md    设计说明
docs/EVIDENCE.zh-CN.md  实测证据
```

PR 需要保持的约束写在 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md) 里。

## 隐私

插件没有埋点，不自己联网，不写磁盘状态。回环上的两个诊断端点是给本地排查用的，不含对话内容；不想要就在配置里关掉 `statusCommands`。细节在 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)。

## 许可证

[MIT](./LICENSE) © 2026 2718Labs。
