# ADR 0007：延期缓存域声明与宿主级 E2E

- 状态：accepted
- 日期：2026-09-18

## 背景

成本感知路由的核心选路、会话亲和、上下文成本、故障决策、账号分层和诊断已经完成。剩余候选工作需要更强的外部契约：上游缓存域是否真的共享、供应商账号剩余额度如何获得、pi TUI 是否应覆盖原生 `cacheRetention`，以及独立进程重启时如何构造可控的 Session branch。

## 决策

1. ~~暂不开放用户声明 `cacheDomain`。~~ 已由 [ADR 0009](0009-cache-domain-declaration-and-ordering.md) 替代：`cacheDomain` 作为用户声明的缓存共享组开放，仅用于故障候选排序，并配套误配告警。
2. 暂不实现账号配额自动策略。`accounts.json` 没有统一的剩余额度或成本 API；当前只使用账号优先级、启用状态、错误分类和 Circuit Breaker。
3. 暂不在 TUI 复制 `cacheRetention` 或 session-affinity 配置。pi/pi-ai 已经负责原生选项和 compat；扩展只保证完整透传，避免按协议错误暴露不可用开关。
4. ~~真实进程重启 E2E 延后到具备隔离的 pi Session fixture 后执行。~~ 已由 [ADR 0010](0010-host-level-extension-e2e-harness.md) 关闭：`tests/host-session-affinity.integration.test.ts` 用真实 `DefaultResourceLoader` + `bindExtensions` + `SessionManager.open` 覆盖“新扩展实例 + 重开 session”恢复；真实 OS 进程重启仍可作为后续加强项。

## 后续进入条件

- ~~`cacheDomain`：明确 provider/transport 的共享缓存证明、误配检测和候选排序测试。~~（已满足，见 ADR 0009）
- 账号配额：有稳定、可脱敏、可缓存的供应商额度接口或宿主契约。
- TUI 入口：完成 transport 能力矩阵和兼容字段的用户体验评审。
- ~~重启 E2E：pi 测试 API 能创建临时 session、写入 Custom Entry、关闭进程并在新进程恢复同一 branch。~~（已满足，见 ADR 0010）

## 后果

- 账号配额和 TUI 原生缓存开关仍按本 ADR 延期，不会因无法证明的额度假设改变路由结果。
- `cacheDomain` 已按 ADR 0009 以用户声明 + 误配告警的方式开放。
- 宿主级会话亲和 E2E 已按 ADR 0010 用真实 pi 机制覆盖。
- 其余项目不是隐藏遗漏，而是有明确前置条件的后续批次；需求验收将它们标记为 deferred，而不是 implemented。
