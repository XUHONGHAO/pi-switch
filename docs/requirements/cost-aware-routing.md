# 成本感知的自动路由与会话亲和性

- 状态：implemented
- 讨论日期：2026-08-13
- 最近更新：2026-09-22（cacheDomain 落地、宿主级会话亲和 E2E 完成；需求整体收口）
- 适用范围：pi-switch 自动选路、`failover` 与 `balance`
- 关联策略（已归档）：[`../plans/archive/cost-aware-routing-strategy.md`](../plans/archive/cost-aware-routing-strategy.md)

> 收口说明：第 9 节 17 项验收标准已全部闭环，第 11 项新增宿主级会话亲和 E2E（`tests/host-session-affinity.integration.test.ts`），方法见 [ADR 0010](../decisions/0010-host-level-extension-e2e-harness.md)。
> 仍有 2 项按 [ADR 0007](../decisions/0007-deferred-cache-domain-and-host-e2e.md) 明确延期：账号配额自动策略、TUI 原生 `cacheRetention`/session-affinity 开关。它们依赖外部契约或产品评审，不计入本次实现状态。

## 1. 背景

pi-switch 通过多线路自动切换提高可用性，但跨 Provider、endpoint、账号或协议切换时，上游 Prompt Cache/KV Cache 通常不能共享。新线路可能重新处理完整会话上下文，增加输入费用和首 Token 延迟；若原线路已完成预填充但在首个内容返回前失败，还可能产生重复计费。

本地会话不会因切换而丢失，模型仍能收到上下文。本需求关注的是上游缓存命中和重复计算成本，而不是会话记忆丢失。

历史版本的 `balance` 按请求轮询；当前实现默认使用会话级稳定分配，只有显式设置 `balanceScope: "request"` 才恢复逐请求轮询。错误决策、账号优先、成本风险和请求阶段已由结构化决策层表达。

## 2. 目标

1. 保留自动故障切换带来的可用性。
2. 保留多线路负载均衡能力，但减少长会话中的缓存冷启动。
3. 根据错误类别、失败作用域、请求阶段和响应提交状态决定是否切换。
4. 优先在更可能共享缓存和协议环境的候选中切换。
5. 限制一次请求的重复尝试次数和高成本切换次数。
6. 让自动决策可解释、可观测，并允许用户选择可用性或成本偏好。
7. 优先复用 pi 的稳定 Session ID、pi-ai 原生缓存参数、上下文用量和真实 Usage，不重复实现会话、缓存协议或 Token 统计。

## 3. 非目标

- 不保证不同上游之间共享 Prompt Cache 或 KV Cache。
- 不保证 failover 不会重复计费；客户端无法确认所有上游的实际计费时点。
- 不迁移 Provider 内部推理状态。
- 不在本需求中实现跨进程共享的会话亲和状态。
- 不默认声称相同模型、相同 Provider 或不同 API Key 一定属于同一缓存域。
- 不在第一阶段实现自动上下文摘要或压缩迁移。

## 4. 术语

- **线路（route/binding）**：Provider、endpoint、协议和模型 ID 等组成的可请求目标。
- **账号（account）**：线路下的具体认证凭据候选。
- **会话亲和性（session affinity）**：同一 pi session 和 alias 的正常请求优先复用已选线路。
- **响应已提交（content committed）**：已向下游发送文本、思考或工具调用等实际内容。
- **缓存域（cache domain）**：用户明确声明可视为共享 Prompt Cache 的线路集合；未声明时不得推断。
- **失败作用域（failure scope）**：错误主要影响当前请求、账号、线路或 Provider。
- **成本风险（cost risk）**：切换后发生重复输入计算或重复计费的估计风险，分为 `low`、`medium`、`high`、`unknown`。

## 5. 核心行为要求

### 5.1 选择、亲和与故障动作必须分离

路由模型应区分三个正交概念：

1. **初始选择**：新会话首先使用哪条线路。
2. **亲和范围**：后续请求是否继续使用该线路。
3. **失败动作**：线路出错后停止、换账号还是换线路。

`failover` 与会话级 `balance` 可以复用相同的故障处理机制，但初始选路不同：

| 策略 | 新会话初始线路 | 会话内正常请求 | 故障后 |
|---|---|---|---|
| `failover` | 固定最高优先级健康线路 | 保持当前线路 | 按决策切换并粘住新线路 |
| `balance` | 在健康线路间分配不同会话 | 保持分配线路 | 按决策切换并粘住新线路 |

### 5.2 使用 pi Session ID 作为亲和基础

会话标识必须使用 `ctx.sessionManager.getSessionId()`，不得由 pi-switch 自行生成，也不得使用可能变化的 session 文件路径。亲和键至少包含：

```text
pi session ID + alias
```

这应自然匹配 pi 生命周期（pi `0.84.1` 实际行为：`Agent` 构造时读取 Session ID 并随每次请求作为 `options.sessionId` 下发，`/clone` 内部走 fork 路径）：

- `/resume` 恢复同一 Session ID，从而恢复同一 alias 的选路；
- `/new`、`/fork` 和 `/clone` 获得新 Session ID，重新参与初始选路；
- TUI、RPC、print 和内存会话使用统一语义；
- `session_start` 初始化或恢复状态，`session_shutdown` 清理运行时状态并 flush 统计。

当前使用 pi Custom Entry 持久化亲和记录；`/resume` 和 `/tree` 分支按 Session ID 哈希恢复，Custom Entry 不进入模型上下文，也不另建独立 `affinity.json`。独立进程重启的宿主级 E2E 仍 deferred，见 [`../decisions/0007-deferred-cache-domain-and-host-e2e.md`](../decisions/0007-deferred-cache-domain-and-host-e2e.md)。

### 5.3 `balance` 默认采用会话级均衡

目标行为：

```text
会话 1：A → A → A
会话 2：B → B → B
会话 3：C → C → C
会话 1 的 A 故障：A → B → B
```

而不是：

```text
同一会话：A → B → C → A
```

若保留逐请求轮询，必须作为显式兼容选项，并提示其可能降低缓存命中率。

### 5.4 `failover` 保持主线路语义

所有新会话默认从最高优先级健康线路开始。只有故障决策允许时才切换；切换后当前会话默认继续使用新线路，不因原线路恢复而立即切回。

### 5.5 切换后避免线路抖动

默认 failback 行为应为 `new-session`：

- 当前会话切换到备用线路后继续粘住备用线路。
- 新会话重新参与正常初始选路。
- 不在当前会话内因旧线路恢复而自动立即切回。

### 5.6 保留 pi-ai 原生缓存与上游亲和参数

别名转发必须将 pi 传入 `SimpleStreamOptions` 的以下字段原样传给目标 pi-ai transport：

- `sessionId`；
- `cacheRetention`；
- 其他与原生 Provider 请求兼容的 stream options。

目标模型的 `compat` 也必须保留（包括回退到 pi 注册模型的 `compat`），使 pi-ai 能按上游能力使用：

- OpenAI `prompt_cache_key` 和缓存保留期；
- Anthropic 风格 `cache_control`；
- 支持服务的 session-affinity Header；
- Provider 自身支持的缓存或副本亲和机制。

pi-switch 不自行拼装各协议的缓存字段。未明确支持相关参数的 Provider 不得被假定具备缓存或副本亲和能力。该要求只能提高同一线路内的缓存命中概率，不代表不同中转站共享缓存。

本节已在 pi `0.84.1` 上通过协议级回归测试核实；各 transport 的实际字段、前提条件与默认值见 [`../architecture/pi-native-passthrough.md`](../architecture/pi-native-passthrough.md)。需注意：`cacheRetention` 默认为 `short`，且多数亲和/长缓存行为需要显式 `compat`，因此“透传正确”并不等于中转站一定收到缓存键。

### 5.7 响应一致性是硬约束

- `contentCommitted === true` 时不得自动切换。
- 用户取消时不得切换。
- 上下文溢出应交给 pi 的 compact/retry 流程，不得通过换线路掩盖。
- 明确的无效请求或参数错误默认不得切换。

“尚未提交内容”只表示响应可以安全替换，不表示原线路没有产生费用。

### 5.8 错误感知决策

扩展必须先提取结构化 HTTP 状态、Header、Abort 状态和可用的 SDK 错误信息，再进行错误分类。决策结果至少应表达：

- 动作：停止、重试同线路、切换账号、切换线路；
- 失败作用域；
- 成本风险；
- 冷却时间或是否打开熔断器；
- 面向日志和诊断的原因。

不得仅以“无内容输出且存在下一候选”为条件切换。

### 5.9 账号优先于跨线路切换

当错误被判断为账号级，候选顺序应优先：

```text
同一 binding 的其他账号
→ 同一显式 cacheDomain 的其他线路
→ 其他线路
```

未声明 `cacheDomain` 时，只能依赖账号/线路层级和配置优先级，不得宣称缓存可共享。

### 5.10 使用 pi 上下文用量评估切换风险

故障决策应优先使用 `ctx.getContextUsage()` 提供的当前上下文 Token 数量或占比，作为“把完整上下文重新发送到新线路”的成本风险输入，而不是自行重新 Tokenize 会话。

- 上下文较长时，首 Token 超时、504 等不确定错误应提高成本风险；
- 明确发生在建连前的错误不应仅因上下文较长而禁止切换；
- pi 无法可靠给出上下文用量时，必须标记为 `unknown` 并采用保守策略；
- context overflow 仍交给 pi 原生 compact/retry，不得被成本策略改写为跨线路切换。

### 5.11 尝试预算

必须支持限制：

- 单次请求最大 attempt 数；
- 单次请求最大高成本 failover 数；
- 是否允许未知错误自动切换。

耗尽预算后应返回最后一个有意义的错误，不再继续请求其他上游。

### 5.12 首批交付优先级

首批实现按以下顺序推进，后项不得阻塞前项落地：

1. **固定原生透传契约**：确认并测试 `sessionId`、`cacheRetention`、目标模型 `compat` 在别名转发中完整保留，优先获得 pi-ai 已有缓存能力。
2. **接入 pi 会话亲和**：使用 `ctx.sessionManager.getSessionId()` 实现会话级 `balance` 和 failover 后粘性，避免自行构造会话系统。
3. **接入成本与缓存观测**：使用 `ctx.getContextUsage()` 评估迁移风险，并记录实际 `cacheRead`、`cacheWrite` 和 cost；首版仅用于决策输入、统计和解释，不使用历史缓存率自适应选路。

结构化故障决策、账号/线路分层和尝试预算仍是完整需求的一部分，但实施时应建立在上述 pi 原生能力契约之上。

## 6. 默认故障动作矩阵

下表定义期望默认语义，最终实现允许根据更可靠的结构化信息细化：

| 错误/状态 | 默认动作 | 优先层级 | 作用域 | 成本风险 |
|---|---|---|---|---|
| 用户 Abort/取消 | 立即停止 | 不切换 | request | low |
| Context overflow | 停止并交给 pi | 不切换 | request | high |
| 明确 400/参数错误 | 停止 | 不切换 | request | high |
| 401/无效 Key | 切换账号；无账号后可切线路 | account 优先 | account | medium |
| 403/权限不足 | 保留 HTTP 状态；有同 binding 账号时优先账号恢复，否则按未知风险保守停止 | account/route | unknown |
| 429 | 按 `Retry-After` 冷却并切换 | account 优先 | account/route | medium |
| DNS/拒绝连接/TLS 建连失败 | 自动切换并短期熔断 | route | route | low |
| 502/503 | 自动切换并冷却线路 | route | route | medium |
| 408/504/首 Token 超时 | 依据成本策略有条件切换 | route | route | high |
| 已提交内容后的任意错误 | 停止 | 不切换 | request | high |
| 未知错误 | 默认停止或至多一次受限切换 | 可配置 | unknown | unknown |

## 7. 成本偏好

应提供至少三种用户可理解的偏好：

- `availability`：优先完成请求，允许预算内的高风险切换。
- `balanced`：默认；低/中风险自动切换，高风险最多一次。
- `economy`：高风险和未知风险不自动切换。

无论偏好为何，均不得突破响应已提交、用户取消、上下文溢出等硬约束。

## 8. 可观测性要求

每次 attempt 应记录或可诊断（HTTP 状态、Retry-After、完整 FailureDecision 和 timeout 阶段已在阶段 E 接入 `stats.json` 与 `/switch status`）：

- alias、binding/line、账号；
- pi 上下文 Token 估计及其是否可靠；
- 错误类别、HTTP 状态和失败作用域；
- 请求阶段与是否已提交内容；
- 决策动作、成本风险和决策原因；
- 冷却时间、attempt 序号和预算剩余；
- 线路切换前后的目标；
- 上游返回的实际 `input`、`output`、`cacheRead`、`cacheWrite` 和 cost（存在时）。

缓存效果应以 Assistant Message Usage 的实际 `cacheRead` / `cacheWrite` 为主要观测依据；首阶段只用于统计、状态和诊断，不直接驱动自动选路。不得在日志或 UI 中暴露 API Key、认证 Header、Secret 命令输出或原始 Session ID。

## 9. 验收标准

1. 亲和键使用 `ctx.sessionManager.getSessionId()` 与 alias；同一 session + alias 在健康状态下连续请求使用同一线路。（已完成：阶段 A）
2. `balance` 能把不同 session 分配到不同健康线路，而非在单个 session 内逐请求轮询。（已完成：阶段 A，rendezvous hashing）
3. `failover` 的不同新 session 均优先最高优先级健康线路。（已完成：阶段 A）
4. 粘性线路故障并成功切换后，当前 session 后续请求继续使用新线路。（已完成：阶段 A）
5. Abort、context overflow、明确 invalid request 和已提交内容后的错误不会触发新 attempt。（已完成：阶段 C）
6. 账号级 401/429 在有备用账号时优先切换同 binding 账号。（已完成：阶段 D 第一批）
7. 网络建连错误可在预算内自动切换线路。（已完成：阶段 E 网络 failover 集成验证）
8. 高成本错误根据成本偏好和预算产生不同决策。（已完成：阶段 C 第一批）
9. `maxAttempts` 和高成本切换预算能阻止无限或过多重试。（已完成：阶段 C 第一批）
10. Circuit Breaker 打开的线路不会被选为当前请求的初始线路。（已完成：阶段 E 集成验证）
11. 自动化测试覆盖上述行为以及配置重载、线路删除和 session 结束后的亲和状态清理。（已完成：核心路由、错误硬停止和 balance 分布由单元/集成测试覆盖；真实 pi 宿主生命周期由 `tests/host-session-affinity.integration.test.ts` 通过 `DefaultResourceLoader` + `AgentSession.bindExtensions` 验证持久化恢复与新 session 隔离，见 ADR 0010）
12. 用户文档明确说明跨线路缓存不可保证、自动切换可能重复计费。（已完成：README 与安装指南）
13. AliasProvider 转发不会丢失 `options.sessionId`、`cacheRetention` 和目标模型 `compat`，并有协议级回归测试。
14. 成本决策能接收 pi 的上下文用量；用量未知时采用明确的保守语义。（已完成：阶段 B/C 第一批）
15. 统计能记录上游实际 `cacheRead`、`cacheWrite` 和 cost；首版不以这些历史数据自动改变线路选择。
16. `/resume` 能恢复稳定亲和语义，`/new`、`/fork`、`/clone` 按新 Session ID 重新初选。（已完成：阶段 E Custom Entry 分支回归验证）
17. 声明了 `cacheDomain` 的线路在故障候选排序中优先于未声明线路的其他线路；同 binding 账号仍最优先；未声明时不改变现有顺序；跨协议/跨主机声明产生配置告警。（已完成：ADR 0009）

## 10. 兼容与迁移

- 现有 `priority` 语义保持不变。
- 现有 `failover` 的主线路优先语义保持不变，但增加会话粘性和结构化故障决策。
- 现有按请求轮询的 `balance` 属于用户可见行为；迁移为会话级均衡时必须更新 README、安装指南和 CHANGELOG。
- 如需兼容旧行为，可提供显式 `balanceScope: "request"`，但新配置默认应为 `session`。

## 11. 已决策与延期事项

1. 亲和键已确定以 pi Session ID + alias 为基础；是否还加入配置 generation 仅用于失效控制，不能替代 pi Session ID。
2. Custom Entry 已用于 `/resume` 和 `/tree` 分支亲和恢复；宿主级 E2E 已由 `tests/host-session-affinity.integration.test.ts` 覆盖（新扩展实例 + `SessionManager.open` 读取持久化条目），见 ADR 0010。真实操作系统进程重启仍可作为后续加强项。
3. `maxAttempts`、高成本预算和成本偏好的默认值。（已确定：`maxAttempts=2`、`maxHighCostFailovers=1`、`failureCostPolicy=balanced`、`failoverOnUnknown=false`）
4. 403 与 timeout 的当前 transport 阶段信息已确认；更细 DNS/TLS/首 Token 事件仍不伪造。
5. `cacheDomain` 已开放为用户声明的缓存共享组，仅参与故障候选排序并配套误配告警；实现见 [`../decisions/0009-cache-domain-declaration-and-ordering.md`](../decisions/0009-cache-domain-declaration-and-ordering.md)。
6. 配置重载会重建运行时并从当前 session branch 恢复当前会话的有效亲和；其他未恢复会话的内存映射会清空。
7. TUI 暂不复制 `cacheRetention` 和 session-affinity 开关；继续透传 pi 原生选项，待 transport 能力矩阵评审后再决定。
8. `cacheRead` / `cacheWrite` 仍按 provider Usage 口径展示，UI 不做跨线路严格可比承诺；后续若增加聚合视图再单独定义归一化。
