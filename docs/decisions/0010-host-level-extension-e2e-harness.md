# ADR 0010：宿主级扩展 E2E 挂载方式

- 状态：accepted
- 日期：2026-09-22
- 关联：[ADR 0007](0007-deferred-cache-domain-and-host-e2e.md)（本决策关闭其第 4 条延期项）

## 背景

ADR 0007 曾以「pi 测试 API 不能创建临时 session、写入 Custom Entry 并在新进程恢复同一 branch」为由延期宿主级 E2E。对 pi `0.84.1` 实际核实后，这组能力已经存在，只是入口不是 `createAgentSession`：

- `DefaultResourceLoader` 可以通过 `additionalExtensionPaths` 加载真实扩展；
- `SessionManager.create/open/getBranch/appendCustomEntry` 均为公开 API；
- `AgentSession.bindExtensions()` 是各运行模式（print / interactive / RPC）绑定扩展并触发 `session_start` 的地方；
- `createAgentSession()` **不会**触发 `session_start`，只创建 session 和扩展 runner。

## 决策

1. 宿主级 E2E 统一使用 `DefaultResourceLoader({ additionalExtensionPaths: [<绝对路径>] })`，并在创建 session 前显式 `await loader.reload()`，否则扩展 provider 不会注册。
2. 使用隔离的 `ModelRuntime`（`modelsPath: null`、临时 `authPath`、`allowModelNetwork: false`）、临时 `cwd` / `agentDir` / session 目录和 `SettingsManager`，不读取开发者 `~/.pi`。
3. 触发 `session_start` 必须显式调用 `await session.bindExtensions({ mode: "print" })`；不能依赖 `createAgentSession()`。这是本 harness 最关键、最不直观的一步。
4. "进程重启"用**新扩展实例 + `SessionManager.open(sameFile)`** 模拟：新的 `DefaultResourceLoader` 会产生新的 `AliasProvider`/`Router`，从而证明恢复来自持久化 Custom Entry，而不是进程内状态。真实 OS 进程重启仍可作为后续加强项，不是当前验收阻塞。
5. 上游用本地 HTTP mock：主线路在产生内容前返回 `503`，备用线路返回流式成功，以制造一次真实 failover。
6. 断言范围：failover 后写入的 `pi-switch-affinity` 条目、`lineId`、以及只存储 Session ID 哈希；`/resume` 通过重开 session 命中备用线路；新 session（新 Session ID）重新从主线路开始。
7. `SessionManager` 没有公开 `flush()`，且只在出现 assistant 消息后才落盘。Custom Entry 因此必须在一次成功 turn 之后写入，测试中的真实 prompt 天然满足。

实现见 `tests/host-session-affinity.integration.test.ts`。

## 后果

- 会话亲和的生命周期（failover 记录 → 落盘 → 重开恢复 → 新 session 隔离）现在有真实 pi 机制覆盖，而不再只依赖单元/集成测试。
- 这套挂载方式可复用于其它需要验证扩展 `session_start` / Custom Entry 行为的 E2E。
- 仍不覆盖真实操作系统进程重启；若将来引入多进程 fixture，可在此基础上扩展。
