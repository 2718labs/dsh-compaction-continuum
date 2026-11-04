# 设计说明

本文解释压缩器背后的模型、塑造它的缓存约束，以及它为什么以这种方式挂到宿主上。

## 1. 前提：压缩是一个结构问题

让模型写摘要，等于让它"判断什么重要"。那是判断题：它会改写、转述、丢细节，而且无法审计。本项目把问题换成力学问题：

- 待压缩的段落是一个**结构**；
- 每个候选块是一个**自由度（DOF）**；
- 块与块之间的证据耦合是**刚度**；
- 当前提问是**载荷**；
- 永不可丢的事实——精确锚点、未关闭事项、显式约束——是**支座**（固定自由度）；
- 压缩是一次**静力凝聚**：保留承载响应的自由度、消去其余，并证明被消去部分不改变响应。

于是模型的职责被压缩为抽取：它只能提出 atom（带逐字 quote 与来源 unit）。每条 quote 都会被校验是否为重放原文的子串；校验不过的 atom 直接丢弃。checkpoint 正文从不出现模型自由撰写的句子，所以发布出去的每个字都可溯源。

### 模型映射

| 力学 | 上下文含义 |
| --- | --- |
| 坐标 / 自由度 | 候选块（抽取得到的 atom；deterministic 模式下是消息 unit） |
| 单元 `w·(e_a − e_b)(e_a − e_b)ᵀ` | 两个块之间权重为 `w` 的证据关联 |
| 刚度 `K` | 由证据权重装配（同源 `1.0`、同 capsule `0.75`、相邻 `0.5`、同类 `0.25`、同 slot `0.125`；当前流水线实现为：同来源 unit `1.0`、相邻 `0.5`、同类 `0.25`） |
| 载荷 `f` | 每个块被当前请求文本激活的程度（词面 Jaccard） |
| 支座 / 约束 `C u = d` | 用 `fix_one` 钉住的 anchors 与 open loops |
| 响应 `u` | 每个块承载该请求的程度 |
| 静力凝聚 | 保留承载自由度、消去其余，并导出重构算子 |
| 证书 | 支座保留、选择一致、凝聚可重构完整响应 |

### 求解

支座钉住后，平衡方程是 KKT 系统

```
[ K  Cᵀ ] [ u ]   [ f ]
[ C   0 ] [ λ ] = [ d ]
```

实现把 `K` 装配成加权拉普拉斯矩阵（**不做对角正则化**：没有接地的连通分量本来就是奇异的，会被如实报告），对没有支座的连通分量在其最活跃成员处接地，再用 LU 部分主元求解。

对保留集 `R` 与消去集 `E` 做 Guyan 凝聚：

```
K_RR' = K_RR − K_RE K_EE⁻¹ K_ER
f_R'  = f_R  − K_RE K_EE⁻¹ f_E
重构算子 = −K_EE⁻¹ K_ER
重构偏移 =  K_EE⁻¹ f_E
```

证书会重新求解完整结构，并与由凝聚结构重构出的响应比较；`reconstructionError` 必须在 `1e-8` 内为 0。选择证书还要求：保留集中承载最小的坐标，承载不低于被丢弃集中承载最大的那个。

证书**不**证明信息论完备。完备性由另外两个机制保证：逐字引文契约（不能作为原文子串出现的内容进不了 checkpoint），以及官方引擎的保留尾部（最近历史逐字保留，不压缩）。

## 2. 缓存约束

provider 会缓存 prompt 前缀。一次请求只为"与近期请求的最长公共前缀"付缓存价，从第一个分歧点之后全部按未命中计费。压缩后端会实质影响这一点：

- 任何一次发布都会替换表层的一部分，下一次请求在发布点处分歧，要把新前缀整读一次。
- 摘要调用若自带 system prompt，或换模型跑，就从第 0 个 token 开始分歧，整段 prompt 全价。
- 逐轮改写历史会把成本乘起来；模拟实测逐轮改写会让稳态命中率跌到约 13%、输入成本约翻倍。

官方引擎的形状本来就是对的：重放对话前缀，把指令作为最后一条 user 消息追加。本插件保留这个形状，只把"摘要什么"换成"抽取什么"，并坚持严格策略：

| 规则 | 原因 |
| --- | --- |
| 一个 epoch 只发布一次 | 第二次发布就要再付一次整读 |
| 绝不中途改写历史 | 分歧点会向更靠前的位置移动 |
| 宁可深切割 | 一次大读比多次小读便宜 |
| 由压力驱动，不由轮数驱动 | 轮数计数会在热前缀上反复重写 |
| 绝不故意对冷前缀摘要 | 空闲太久缓存本来就没了，先看时间间隔 |
| 本压缩器不做剪枝 | 实测工具结果剪枝省下数万 token，却造成三轮 ≈1.1M miss-equivalent；桌面端 preset 仍自带剪枝器，不归本插件控制 |

真实会话实测（27 个会话、4400+ 次请求）：稳态命中率 99.1%–99.7%；一次发布 = 新前缀整读一次；空闲 49 分钟后手动压缩付了 331,799 未命中 token，因为 provider 缓存已过期——任何设计都躲不掉。

重放契约是可运行时验证的：自检里的 `projection alignment` 把压缩重放与持久表层投影逐字节比较，结果一致（`live=399 replayed=399 identical=true`）。

**但与持久投影一致，不等于与线上请求一致。** 在一个长会话的三次自动压缩上实测：压缩前那一次请求命中 99.07%–99.93%（距压缩 0.1–12.8 秒），而摘要调用在 ~550k 的 prompt 上只命中 0–9,856 token——命中部分止于 system/tools 头部，之后分歧，因为线上请求携带了持久日志无法还原的请求期材料。由此：

- 任何"重放式摘要"每次压缩都要付一次接近整读的 prompt（实测 549k–563k 未命中，另加 ~162k–181k 发布重读）。
- 因此本后端把模型调用变成**可选**：`deterministic` 模式完全去掉它（实测事件上整体约 4× 便宜）；`extract` 模式主张成本持平，但把这次调用花在可核验、带证书的 checkpoint 上，而不是散文。
- 让重放与线上请求逐字节一致，就能让抽取调用接近免费；这需要捕获请求期 envelope，而它目前不可持久化，列为路线图项。

表格与方法见 [`EVIDENCE.zh-CN.md`](./EVIDENCE.zh-CN.md)。

## 3. 为什么是原型钩子

桌面版把压缩后端组合在 **agent-preset 平面**：每个 preset 声明

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
```

内部挂官方 `@deepseek-ai/dsh-compaction-basic`。隔离意味着 Host 平面的 `compaction` provider 对真正压缩会话的引擎不可见，而 Host 平面插件也无法进入 preset 声明。

考虑过三种方案：

1. **在 Host 平面再挂一个 `compaction` provider。** 只对没有 preset 的组合有效；桌面端等于空转。本插件**额外**保留它，用于非桌面组合。
2. **覆盖每个出厂 preset 声明**，把整个 plugin 列表重述一遍并替换后端。bundle patch 方言支持，但等于复制四个 preset（standard、ptc、minimal、cordis）、把它们的插件列表钉死在本仓库上，且 App 升级后会静默过期。否决：维护债。
3. **替换官方引擎唯一被文档化的钩子** `BasicCompactionEngine.prototype.summarize`——`regionDependencies()` 每次压缩都动态走它。一个方法、覆盖两个平面的所有实例、卸载可还原，而事务、锁、溢出恢复、保留尾部与重放仍归官方。

插件采用方案 3，并保留方案 1 以支持非桌面组合。若官方类未来失去该方法，本压缩器不会被调用，官方摘要照常运行，自检会报 `backendUsesHookedSummarize: false`。

## 4. 流水线形状

```
lib/pipeline.js
  segmentMessages(input.messages)      head（system）+ units
  callModel(EXTRACTION_INSTRUCTION)    一次调用；返回 {text, provider, model, maxTokens, usage}
  validateAtoms(json, units)           quote 必须是子串；最近 unit 优先
  selectKeepers({items, queryText, supports, ...})
    关系 → 装配刚度 → 载荷 → 约束求解 → 打分
    保留 supports + score ≥ 阈值·maxScore，补足 minKeep，依赖组整体进出
  renderCheckpoint(items, kept, budget)  确定性分节渲染；Next Step 优先排版
  buildVerbatimRetention(units, budget)  逐字用户请求 → 最近单元
  召回提示（可选）                      ## Recall (exact original)
  证书检查 + 收缩检查
  （lib/index.js，Host 半边）
  collectRetainedImages(input.messages)  图像块拼入 checkpoint 消息
```

deterministic 模式完全跳抽取：消息 unit 直接作为坐标，kind 由角色与内容推断。它零模型调用，适合隐私或成本受限的 profile；因为没有语义 atom，质量较低。

### 连续性分层

checkpoint 必须能让后继继续，同时不能永远堆积已完成的工作。五层机制界定这个生命周期：

- **Next Step。** 抽取提供 `next_step` 条目并钉为支座；缺失时确定性兜底逐字引用最近真实请求（或最近助手状态）。证书：`nextStepAnchored`。
- **逐字保留。** 真实用户请求不压缩、最新优先，随后是最近的非用户单元，预算 `verbatimTokens`；该块夹紧到 checkpoint 仍小于源区间。证书：`userMessagesVerbatim`。
- **锚点结转。** 上一代 checkpoint 的新鲜锚点只结转一次，进入 `## Carried Anchors (older)` 并钉为支座；下一代若没有新的抽取证据就释放，因此过期锚点约存活两代。证书：`carriedAnchorsPreserved`。
- **释放。** 抽取指令要求丢弃已完成步骤、已修复错误、已解决任务与已完成请求；保留块在压力下先丢最旧；保留图像按最新优先、数量封顶。被释放内容仍在持久日志中。
- **召回与图像。** `context_recall` 按需检索或读取调用 agent 的持久事件，checkpoint 带提示；未离载的图像块直接拼入 checkpoint 消息（受 `maxRetainedImages` 约束），不再退化为占位符。

## 5. 失败模式

| 失败 | 行为 |
| --- | --- |
| 抽取器不可用 / 截断 / 非 JSON | 确定性渲染，`audit.extractionError` 记录原因 |
| 可核验 atom 太少（< 4）或接受率 < 0.75 | 确定性渲染 |
| 结构奇异（无接地） | 在最活跃成员处接地；仍奇异则失败 |
| 证书不通过 | 拒绝发布，向下回落 |
| checkpoint 无法缩小源 | 向下回落 |
| 其它任何异常 | 官方摘要 |

`mode: off` 直接跳过全部逻辑，调用官方摘要。卸载时还原原型方法。

## 6. 成本

- 抽取：一次模型调用，输出 ≤ `extractorMaxTokens`。输入是重放的持久前缀；实测它只与线上请求匹配到 system/tools 头部，所以在能复现线上 envelope 之前，应按"冷调用"计入成本（见 §2）。
- 调度层面的检查：`deterministic` 模式零模型调用；在实测的自动压缩事件上，这就是每次 ~721k–734k 与 ~165k–185k miss-equivalent 的差别。
- 算术：对 ≤48 个候选做 O(n³) LU——亚毫秒、无网络、确定性。
- 记账：每会话内存计数，不落盘，重启即丢。
- checkpoint 体积：结构索引受 `checkpointMaxTokens` 约束，逐字保留再叠加最多 `verbatimTokens`，因此近无损发布体积比 v0.3 的测量大约多 2 万 token，一次性发布重读随之增长。设 `verbatimTokens: 0` 可回到压缩率优先的体积。

## 7. 路线图

- 捕获完整的线上请求 envelope，让抽取请求真正命中 provider 缓存，而不是付冷读。
- 让插件能对 preset 拥有的引擎表达自己的保留量偏好，而不是继承官方默认。
- 关系权重从观测到的发布代价学习，替代固定常数。
- 依据实测重读成本自适应 checkpoint 预算。
- 更丰富的抽取 kind，以及更严格的引文解析（拒绝"仅归一化后才匹配"的引文）。
- 用再证据打分替代结转锚点的单代过期规则。
- 为落在保留集之外的图像提供附件解析。
