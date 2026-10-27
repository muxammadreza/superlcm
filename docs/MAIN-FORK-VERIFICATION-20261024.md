# 0.6.0 后台分支验证记录（2026-10-24）

## 已验证

| 范围 | 结果 | 实际边界 |
|---|---|---|
| 主仓库完整默认套件 | 525项，491通过、34失败 | 剩余失败用例均在改造前失败名单中，无新增失败用例；不能宣称全绿 |
| dsh 主仓库运行时 | 192/192通过 | 本机正式 DSH 0.2.1-rc.3，真实宿主 + 本地假供应商 |
| dsh 独立插件 | 232/232通过 | 0.2.1-alpha.1 与本机 rc.3 均验证，含主动、被动分支及高级 API |
| 统一分支专项 | 15/15 + 8/8通过 | 整树、迁移、两个原生协议、来源核验、取消、单生产者及配置变化 |
| Pi 真实 SDK | 正常、慢生成、生成失败、超大输入通过 | 本机 Pi 1.4.0 + 本地 HTTP 假供应商，无付费调用 |
| Pi 扩展默认回归 | 已包含在主仓库完整套件 | 来源映射、工具组、容量、配置事务、关闭及取消接入 |
| 语法与包内容 | 主仓库227文件；独立插件101文件 | 主包dry-run确认原生分支、Pi、dsh适配与持久化接口均包含 |
| 本地页面 | Chrome实际验证 | 三个主入口、四种工具卡片、dsh接入预览通过，确认按钮可用；未重新开启取消的接入 |

Pi 正常路径的回执确认：70%后台准备、3次连续主请求、80%原生边界提交、替换阶段新增摘要HTTP请求为0，新增用户请求、工具结果和完整原始会话保留。慢生成仍继续主工具链；失败和超大输入验证不安全供应商请求为0。

主仓库 dsh 同时验证旧类式和新版生命周期式 JSONL 持久化接口。rc.3 的回归夹具补齐正式用户来源字段；真实历史导入不再使用不存在的默认构造器。压力测试保留总截止时间断言，将测试时间尺度由90/55ms放大为400/250ms，避免两个仓库压力套件并行争用CPU时在首个健康批次前就耗尽预算；生产超时配置未变。

## 原生协议与缓存限制

Codex 实际本地 app-server 已验证持久会话临时分支及模型继承，没有发起模型生成。Claude Code 本机未安装，只做隔离进程协议、工具拒绝、截断、超时和取消验证，未宣称真实 Claude 宿主测试通过。

供应商缓存用量字段的保存与传递已验证；假供应商的缓存数不能当作实际缓存命中证据。没有本轮真实供应商缓存命中率或费用基准。分支模式也不保证所有请求命中缓存。

本轮由主会话实施和验证，未启动额外模型作独立审查。独立插件实现：[961a4a8](https://github.com/yu381792/dsh-superlcm/commit/961a4a8)。两个包版本为0.6.0；本轮只提交和推送GitHub，未发布npm或打发布标签。

## 重现命令

```sh
npm run check
npm test
npm run test:main-fork
# 若默认宿主不是实际使用的版本，设置为该宿主的 package.json：
SUPERLCM_DSH_RUNTIME=/path/to/installed/dsh/package.json npm run test:dsh-runtime
node scripts/verify-pi-compaction.mjs --main-fork
node scripts/verify-pi-compaction.mjs --main-fork --slow-luna
node scripts/verify-pi-compaction.mjs --main-fork --fail-luna
node scripts/verify-pi-compaction.mjs --main-fork --oversized-input
# 独立仓库中：
SUPERLCM_DSH_RUNTIME=/path/to/installed/dsh/package.json npm test
```

`--slow-luna` 和 `--fail-luna` 为历史测试参数名；加 `--main-fork` 时实际针对本地主模型分支注入慢响应或失败，不调用 Luna。

## 尚未清理的历史失败用例

改造前记录为466项、424通过、42失败。本次剩余34个失败用例均出现在原失败记录中。此比较针对用例名单，不替代逐项根因审查：

- Claude cached host module cannot submit after cancellation or a settings change
- Claude final rescue reuses natural prefix, preserves exact request and complete tool suffix
- a changed live tool result payload cannot authorize compression of older archive content
- a changed live tool use payload cannot authorize compression of older archive content
- a real summary-check renews the lease and rejects stale setting revisions
- a transient durable host publication failure reopens with the same generated output
- actual Claude SDK tool/text fields verify archive source: changed-result
- actual Claude SDK tool/text fields verify archive source: changed-tool
- actual Claude SDK tool/text fields verify archive source: unchanged
- cancelled final draft refuses direct late save and takeover-off or subagents never invoke rescue
- durable final ready output survives a save failure and a new hook instance
- final empty failure buys once, preserves archive and defers to native
- final quality failure buys once, preserves archive and defers to native
- final quota failure buys once, preserves archive and defers to native
- final rescue before save retries storage without a second model call
- final rescue lost receipt retries storage without a second model call
- final truncated failure buys once, preserves archive and defers to native
- final unanswered failure buys once, preserves archive and defers to native
- host background output survives transient save boundary, including a lost receipt
- ignored final timeout is bounded and late completion cannot publish
- ignored model cancellation cannot write late output
- in-flight main-model change rejects obsolete rescue output
- in-flight off change rejects obsolete rescue output
- in-flight summary-setting change rejects obsolete rescue output
- mixed checkpoint outline exposes exact direct originals alongside its unchanged old children
- natural source advance rejects an obsolete final result without altering the previous archive
- real CLI precompute flushes an open tail and returns host retry without a model call
- real SQLite write-lock wait observes session end before root publication
- real SQLite write-lock wait observes user cancellation before root publication
- real native checkpoint and post-native source are verified without reviving pre-native raw history
- repeated short human prompts cannot borrow a different task authorization
- session end during final usage discovery cancels before any main-model call or root
- session ending aborts an in-flight final summary even without a caller signal
- unrecorded content or ambiguous repeated complete timeline cannot supply rescue source
