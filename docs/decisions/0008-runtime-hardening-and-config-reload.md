# ADR 0008：运行时加固与配置重载回滚

- 状态：accepted
- 日期：2026-09-18

## 背景

在补齐成本感知路由验收时发现三类容易造成隐性错误的边界：异常流没有 terminal event 时状态页仍显示上一请求、外部配置 reload 的非法内容会污染当前运行时、以及多个 binding 的隐式线路身份相同却可能携带不同认证或 header 语义。

## 决策

1. AliasProvider 对无 terminal event 的流按失败 attempt 记录 `lastRoute` 和诊断，不保留旧请求状态。
2. `ConfigStore.reload()` 先以 strict JSON 读取并完整校验；读取或校验失败时抛错并保留上一份有效配置。自动生成的 `stats.json` 仍采用容错读取。
3. 校验阶段拒绝重复的 resolved line identity；需要让相同 endpoint/model 承载不同 binding 语义时必须显式设置不同 `binding.id`。
4. pi-ai 的典型 `Connection error.` 文本归类为 network，使已有 failover/circuit breaker 语义生效。

## 后果

- 配置编辑错误不会在运行中悄悄生效，用户可以看到明确 reload 错误并修正文件。
- 健康、亲和和统计不会因隐式线路身份冲突而串线。
- 异常流结束也会有一致的状态和诊断；完整宿主生命周期 E2E 仍按 ADR 0007 deferred。
