# 贡献指南

本文说明如何参与本项目。插件定位为 DeepSeek Harness 的压缩后端，范围有限。优先接受保持范围小、可测量的改动。

## 开发环境

需要 Node.js >= 20（无需安装依赖：插件与测试都没有运行时/开发依赖）。

```bash
npm test    # 离线：结构内核 + 流水线 + 基准工具，122 条断言
npm run check
node bench/report.mjs   # 在本机已记录会话上做成本核算（也可传入目录）
```

离线套件就是契约：抽取提示词形状、引文溯源、刚度/KKT/凝聚算术、证书、确定性渲染、fail-open 阶梯。宿主行为需要在真实 Harness 上验证（见下）。

## 插件是怎么挂上去的

两个 seam：

1. **Host 平面** —— bundle patch 把本包挂成 `compaction` 服务（适用于没有 preset 平面的组合）。
2. **Preset 平面** —— 桌面版为每个 agent preset 隔离一个官方 `@deepseek-ai/dsh-compaction-basic` 实例。插件把压缩器装在它唯一被文档化的定制钩子（`BasicCompactionEngine.prototype.summarize`）上，卸载时还原。不要新增第二个 `compaction` provider：组合会拒绝，而且 preset 平面根本看不见它。

为什么 desktop 只有这个 seam 可用，见 `docs/DESIGN.zh-CN.md`。

## 缓存不变量

项目存在的意义就是"压缩而不摧毁 provider 前缀缓存"。任何改动必须保持：

- 一个 epoch 只发布一次；绝不中途改写历史；
- 不做逐轮、会话中段的重复摘要；
- 抽取调用重放会话自己的前缀（`input.messages` + `input.tools`），只在尾部追加指令——没有独立的摘要 system prompt，不换模型；
- fail-open 顺序：结构编译 → 确定性渲染（零模型调用）→ 官方摘要。

涉及压缩频率或保留量的改动，请在 PR 里给出实测缓存数字（`compaction/summary.usage` 与被影响请求的 cached/uncached input tokens）。

## Pull request

- 一个 PR 只做一件事，提交信息用 Conventional Commits。
- 同步更新 `README.md`、`README.zh-CN.md` 与 `CHANGELOG.md` 的 `Unreleased`。
- 绝不提交会话内容、提示词、会话日志、凭据或本机绝对路径。
- 新行为需要离线断言；只能是宿主侧的行为，请在 PR 中写明测试过的 DSH 版本并附上无内容诊断输出。

## 实机验证

把工作副本作为本地 bundle 装进一个 profile，然后：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/compaction-continuum/selftest | ConvertTo-Json -Depth 8
Invoke-RestMethod 'http://127.0.0.1:<port>/compaction-continuum/selftest?test=extract' |
  Select-Object -Expand probes | Where-Object name -eq 'extraction contract' | Select-Object -Expand value
```

会话里跑 `/context_status`、`/context_inspect`，需要真实发布时跑 `/compact`。`hook` 块必须显示后端引擎是官方类且 `backendUsesHookedSummarize: true`。

## 报告问题

见 `.github/ISSUE_TEMPLATE/bug_report.yml`，附上插件版本（`/compaction-continuum/ping`）与 Harness 版本。
