# 成本感知路由策略设计草案

- 状态：in-progress（阶段 0、A、B、C 第一批及 D 第一批已完成）
- 日期：2026-08-13
- 最近更新：2026-09-15（阶段 D 第一批：binding 账号范围、账号优先切换与账号亲和）
- 对应需求：[`../requirements/cost-aware-routing.md`](../requirements/cost-aware-routing.md)
- 已核实契约：[`../architecture/pi-native-passthrough.md`](../architecture/pi-native-passthrough.md)
- 当前实现参考：`src/router/router.ts`、`src/errors/classify.ts`、`src/provider/alias.ts`

## 1. 设计摘要

将当前一次请求内的“排序 + 布尔 failover”升级为四个协作层：

```text
初始线路选择 Selection Policy
  + 会话亲和 Affinity
  + 故障决策 Failure Decision
  + 尝试预算 Attempt Budget
```

策略只负责“从哪里开始”；亲和性负责“正常情况下继续用谁”；故障决策负责“出错后做什么”；预算负责“最多付出多少次重复请求成本”。

## 2. 当前行为与差距

当前实现：

- `priority` 和 `failover` 总是从排序后的首个候选开始。
- `balance` 使用进程内 alias 计数器按请求轮询。
- `canFailoverFor()` 只返回布尔值。
- 账号被展开成扁平候选，难以显式表达“先换账号、再换线路”。
- 已有 `committed`、错误分类、`Retry-After`、Circuit Breaker 和 attempt 统计，可作为演进基础。

主要差距：

- 无 session 路由键与粘性状态；
- 无失败作用域、成本风险、请求阶段和尝试预算；
- `balance` 对长会话缓存不友好；
- 未知错误和高成本超时可能与低风险建连失败采用相同切换路径；
- 尚未用 pi 的上下文用量和真实 cache Usage 支撑成本评估与观测；
- ~~尚未以回归测试证明别名转发完整保留 `sessionId`、`cacheRetention` 和目标模型 `compat`~~（阶段 0 已闭环）；
- 常见中转站在默认 `cacheRetention: short` 且未声明 `compat` 时，上游收不到任何缓存键或亲和 Header——这是配置暴露问题，不是转发缺陷。

### 2.1 pi 原生能力复用原则

实现应优先复用以下宿主能力：

- `ctx.sessionManager.getSessionId()`：唯一会话亲和标识；
- `SimpleStreamOptions.sessionId/cacheRetention`：交给 pi-ai 原生 transport 生成缓存键、缓存控制或上游亲和信息；
- 目标模型 `compat`：声明 Provider 实际支持的缓存与 session-affinity 格式；
- `ctx.getContextUsage()`：估算跨线路重发上下文的成本风险；
- Assistant Message `usage.cacheRead/cacheWrite/cost`：观测实际缓存与费用；
- pi Custom Entry：未来持久化分支感知的亲和变化，且不进入模型上下文；
- pi overflow detection 与 compaction：处理上下文溢出，不由路由器跨线路重试。

pi-switch 只负责选路和故障动作，不自行实现缓存协议、会话 ID、Token 计算或 compaction。

## 3. 建议配置模型

以下仅是目标形态，不要求一次引入所有字段：

```json
{
  "strategy": "balance",
  "balanceScope": "session",
  "affinity": "session",
  "failback": "new-session",
  "failureCostPolicy": "balanced",
  "maxAttempts": 2,
  "maxHighCostFailovers": 1,
  "failoverOnUnknown": false
}
```

可选的 binding 配置：

```json
{
  "id": "openai-main",
  "provider": "openai",
  "model": "gpt-5",
  "cacheDomain": "openai-project-main"
}
```

### 3.1 默认值建议

| 字段 | 建议默认值 | 原因 |
|---|---|---|
| `balanceScope` | `session` | 长会话缓存友好 |
| `affinity` | `session` | 避免请求级抖动 |
| `failback` | `new-session` | 避免刚建立的备用缓存再次失效 |
| `failureCostPolicy` | `balanced` | 可用性与成本折中 |
| `maxAttempts` | `2` | 最多一次备用尝试 |
| `maxHighCostFailovers` | `1` | 限制长上下文重复计算 |
| `failoverOnUnknown` | `false` | 未知情况保守处理 |

默认值仍需通过需求评审确认。

## 4. 初始线路选择

### 4.1 `priority`

选择最高优先级且健康的候选，不允许故障切换。保留当前语义。

### 4.2 `failover`

新 session + alias 始终从最高优先级健康 binding 开始。若已有有效亲和映射，则优先亲和线路；该线路不可用时进入故障决策。

### 4.3 `balance`

新 session + alias 在健康 binding 间进行会话级分配，随后写入亲和映射。推荐使用 rendezvous hashing：

```text
score = hash(piSessionId, alias, binding.lineId)
选择分数最高的健康 binding
```

优点：

- 不依赖全局递增计数器；
- 同一键结果稳定；
- 线路增删时只迁移部分会话；
- 多进程即使不共享内存，只要配置和哈希一致也能得到稳定初选结果。

若需要严格均匀的并发会话计数，应另行引入共享状态；首版不建议。

## 5. 会话亲和状态

`piSessionId` 必须来自 `ctx.sessionManager.getSessionId()`。不得使用自生成 UUID 或 session 文件路径替代。

建议键和值：

```ts
type AffinityKey = `${piSessionId}:${alias}`;

interface AffinityEntry {
  lineId: string;
  accountName?: string;
  assignedAt: number;
  switchedAt?: number;
  configGeneration: number;
}
```

### 5.1 生命周期

- 首次成功选路时建立。
- 成功 failover 后更新为新线路。
- 当前线路仍存在且健康时持续复用。
- session 结束时清理内存状态。
- 配置重载时删除目标已不存在或身份不兼容的映射。
- 首版只做进程内状态；跨重启或 `/tree` 分支恢复优先升级为 pi Custom Entry，不建立独立亲和状态文件。

### 5.2 binding 与账号亲和

建议首版至少粘住 binding。是否同时粘住账号取决于账号轮转目标：

- 为最大化潜在缓存命中，可粘住账号；
- 为均摊账号额度，可 binding 固定、账号另设策略。

不要隐式假设同 endpoint 不同 API Key 一定共享缓存。

### 5.3 pi 生命周期集成

- `session_start`：读取 pi Session ID，初始化内存亲和上下文；未来可从当前 `getBranch()` 的最新 Custom Entry 恢复。
- `session_shutdown`：清理运行时引用并 flush 统计；若使用 Custom Entry，持久化记录仍留在 session 中。
- `/resume`：相同 Session ID 应恢复稳定选路。
- `/new`、`/fork`、`/clone`：新 Session ID 重新初选。
- 配置重载：仅保留仍指向有效 `lineId` 的映射，具体失效规则待确认。

## 6. pi-ai 缓存与上游亲和透传

> 状态：已完成（阶段 0）。契约事实以 [`../architecture/pi-native-passthrough.md`](../architecture/pi-native-passthrough.md) 为权威来源，下文保留作为设计背景。

当前 AliasProvider 已通过 `{ ...options, apiKey, headers }` 调用目标 transport，但需要协议级测试固定以下契约：

```ts
streamWithTransport(targetModel, context, {
  ...options, // 必须保留 sessionId、cacheRetention 等宿主选项
  apiKey,
  headers,
});
```

目标模型必须继续携带 binding/注册模型的 `compat`。缓存字段由 pi-ai 原生 transport 根据 API 和 compat 生成，例如：

- OpenAI 的 `prompt_cache_key` / `prompt_cache_retention`；
- Anthropic 风格的 `cache_control`；
- 支持服务的 `x-session-affinity`、`x-session-id` 等上游亲和 Header。

不得由 pi-switch 统一硬编码这些字段。它们只优化同一上游支持范围内的缓存或副本亲和，不构成跨线路缓存共享保证。

## 7. 故障决策模型

建议将 `canFailoverFor()` 保留为兼容包装，核心改为：

```ts
type FailureAction =
  | "stop"
  | "retry-same-route"
  | "switch-account"
  | "switch-route";

type FailureScope = "request" | "account" | "route" | "provider" | "unknown";
type CostRisk = "low" | "medium" | "high" | "unknown";
type AttemptPhase =
  | "resolving-auth"
  | "connecting"
  | "awaiting-response"
  | "streaming";

interface FailureContext {
  category: ErrorCategory;
  contextTokens?: number;
  contextRatio?: number;
  contextUsageReliable: boolean;
  status?: number;
  retryAfterMs?: number;
  phase: AttemptPhase;
  contentCommitted: boolean;
  aborted: boolean;
  hasAlternativeAccount: boolean;
  hasAlternativeRoute: boolean;
  attemptsUsed: number;
  highCostFailoversUsed: number;
  policy: "availability" | "balanced" | "economy";
}

interface FailureDecision {
  action: FailureAction;
  scope: FailureScope;
  costRisk: CostRisk;
  cooldownMs?: number;
  openCircuit?: boolean;
  reason: string;
}
```

`reason` 使用稳定、可测试的内部代码加用户可读文本更合适，例如：

```ts
{ reasonCode: "abort-requested", reason: "用户已取消请求" }
```

## 8. 决策顺序

必须先应用硬约束，再应用成本偏好：

```text
1. aborted?                     → stop
2. contentCommitted?            → stop
3. context-overflow?            → stop
4. invalid-request?             → stop
5. 尝试预算耗尽?                → stop
6. 读取请求阶段与 pi context usage
7. 识别 failure scope/cost risk
8. account 错误且有备用账号?    → switch-account
9. 根据成本偏好判断能否换线路
10. 无可用替代                 → stop
```

成本偏好不得覆盖前四项。

## 9. 候选层级

不要只依靠扁平数组的下一项。建议逻辑分组：

```text
Alias
├── Binding A
│   ├── Account A1
│   └── Account A2
├── Binding B（同 cacheDomain，可选）
└── Binding C
```

失败后候选顺序：

1. 同 binding 的其他健康账号；
2. 同显式 `cacheDomain` 的健康 binding；
3. 按策略排序的其他健康 binding；
4. 已熔断或冷却线路不参与，除非未来设计 half-open 探测。

对 `balance`，故障候选可按 rendezvous 分数的次序排列；对 `failover`，按 priority 和声明顺序排列。

## 10. 成本策略

### `availability`

- 低、中、高风险均可在总预算内切换。
- 未知风险是否切换仍受 `failoverOnUnknown` 控制。

### `balanced`

- 低、中风险自动切换。
- 高风险最多一次，并受 `maxHighCostFailovers` 限制。
- 未知风险默认停止。

### `economy`

- 仅低风险自动切换。
- 中、高、未知风险停止并返回错误。

成本风险的判断应基于请求阶段、结构化错误和 pi 的上下文用量，而不是声称知道真实账单。

### 10.1 使用 `ctx.getContextUsage()`

在 `agent_start` 或等价的请求边界读取：

```ts
const usage = ctx.getContextUsage();
const contextTokens = usage?.tokens ?? undefined;
const contextRatio = usage?.percent ?? undefined;
aliasProvider.beginRequest({
  sessionId: ctx.sessionManager.getSessionId(),
  contextTokens,
  contextRatio,
  contextUsageReliable: contextTokens !== undefined,
});
```

当前 pi 的 `ContextUsage.tokens` 和 `percent` 在未知时为 `null`；实现必须同时处理 `ctx.getContextUsage()` 返回 `undefined` 和字段为 `null`。不要在 AliasProvider 内重新 Tokenize `Context`。

建议风险修正：

- 明确建连失败仍为低风险，不因上下文长而升级；
- 503 等中等不确定错误在超长上下文时可升级；
- 首 Token 超时/504 在长上下文时视为高风险；
- 用量未知时按 `unknown` 保守处理。

compaction 后、尚无成功 assistant usage 时，pi 可能无法给出可靠值；实现必须接受 `undefined`。

## 11. 请求阶段采集

当前 transport 层不一定能精确区分 DNS、连接、HTTP response 和首 Token 等阶段。建议渐进实现：

1. `resolving-auth`：认证或 Secret 解析期间；
2. `connecting`：请求已发起、尚未收到 HTTP response；
3. `awaiting-response`：收到 response 或确认上游接受、尚未出现内容；
4. `streaming`：出现内容事件后。

如果底层 transport 无法提供足够信号，阶段标记为最保守值，并提升 `costRisk`，不得伪造精确性。

## 12. Circuit Breaker 与亲和性的关系

- 打开的线路不能作为新请求初选。
- 亲和线路进入 open/cooldown 时，应为当前请求重新决策，而不是盲目坚持。
- 成功切换后更新亲和线路。
- 原线路恢复后，`failback: new-session` 不修改已有会话映射。
- 新会话可重新选择恢复后的线路。

## 13. 真实缓存 Usage 与诊断

扩展 AttemptStats，建议增加：

```ts
interface RoutingDecisionStats {
  sessionIdHash?: string;
  contextTokens?: number;
  contextUsageReliable: boolean;
  strategy: RoutingStrategy;
  affinityHit: boolean;
  phase: AttemptPhase;
  failureScope?: FailureScope;
  action?: FailureAction;
  costRisk?: CostRisk;
  reasonCode?: string;
  attemptNumber: number;
  maxAttempts: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCost?: number;
}
```

从最终 Assistant Message Usage 读取 `input`、`output`、`cacheRead`、`cacheWrite` 和 cost。首版仅用于统计、状态与诊断，不参与自动路由评分。不同 Provider 的 Usage 口径可能不同，UI 不应暗示它们严格可比。

仅记录 Session ID 的不可逆短哈希或不记录，避免泄露原始会话标识。`/switch status` 可显示：

```text
sticky: session · route: proxy-b · switched from proxy-a (503, medium risk)
```

## 14. 分阶段实施建议

前三项最高优先级与需求保持一致：原生透传契约 → pi 会话亲和 → 上下文成本与真实 Usage。故障决策和候选分层可并行设计，但不应绕过这些宿主能力另建重复机制。

### 阶段 0：固定 pi 原生透传契约（已完成）

- [x] 验证 AliasProvider 收到稳定的 pi `sessionId`（`tests/pi-host-passthrough.integration.test.ts`）。
- [x] 为 `sessionId`、`cacheRetention` 和目标模型 `compat` 透传增加协议级回归测试（`tests/alias-native-passthrough.integration.test.ts`）。
- [x] 验证 OpenAI Completions / Responses / Anthropic Messages 在启用对应 compat 时生成预期缓存键、`cache_control` 与亲和 Header。
- [x] 未新增自定义缓存协议。
- 核实结论与各 transport 差异记录在 [`../architecture/pi-native-passthrough.md`](../architecture/pi-native-passthrough.md)。

### 阶段 A：pi 会话亲和与会话级 balance（已完成）

- [x] 使用 `ctx.sessionManager.getSessionId()` 建立进程内 affinity map（`Router` 的 `Map<sessionId:alias, bindingIdentity>`）。
- [x] `failover` 切换后粘住新线路（`setAffinity()` 在首个内容事件后记录）。
- [x] 使用 rendezvous hashing 为 `balance` 分配新会话（确定性 session→binding 映射，无碰撞风险）。
- [x] 增加 session shutdown/config reload 清理（`session_shutdown` 调用 `router.clearSession()`，`reset()` 清空全部）。
- [x] 提供 `balanceScope: "request"` 兼容旧行为（默认 `"session"`，request 模式仍用轮询计数器）。
- [x] 更新用户文档与 CHANGELOG（BREAKING 标记 + 迁移说明）。
- 回归测试：`tests/router-affinity.test.ts`（8 项单元测试覆盖 Router 亲和逻辑）。

### 阶段 B：上下文成本与真实缓存观测（最高优先级）

- [x] 通过 `ctx.getContextUsage()` 将上下文长度纳入成本风险，未知值采用保守语义。
- [x] 从 Assistant Usage 记录 `cacheRead`、`cacheWrite` 和实际 cost。
- [x] 增加亲和命中和缓存表现统计，但暂不使用历史缓存率自动选路。

### 阶段 C：决策层与预算

- [x] 引入 `FailureDecision`、作用域和成本风险。
- [x] 增加 `maxAttempts`、高成本预算、未知错误开关。
- [x] 将阶段 B 的当前上下文成本作为决策输入。
- [x] 替换布尔 failover 判断并补齐错误矩阵单元测试。

阶段 C 第一批已完成；账号/线路分层第一批已在阶段 D 完成，显式 `cacheDomain` 和更细的 timeout 阶段识别仍属于阶段 E。

### 阶段 D：账号/线路分层

- [x] 保留 binding 与 account 的层级关系；binding 可用 `accounts` 限定账号范围，省略时兼容 Provider 级账号池。
- [x] 401/429 优先同 binding 换账号，并让成功切换后的账号参与会话亲和。
- [x] 补充账号范围校验、候选分组、账号亲和恢复和 401 集成测试。

阶段 D 第一批已完成。后续仍可在本阶段扩展 403 的更细作用域判定、账号配额策略和更丰富的账号诊断，但不改变当前 binding 优先级与账号优先级语义。

阶段 D 第二批：

- [x] 保留非 2xx fetch 的 HTTP 状态和 `Retry-After` 元数据，避免 pi-ai 错误事件丢失 403 作用域信息。
- [x] 403 + 同 binding 备用账号时按 `unknown` 成本风险执行账号级恢复；无账号恢复时按未知风险保守停止。
- [x] 增加 403 单元与端到端集成覆盖。

### 阶段 E：增强决策与显式缓存域

- 增加完整决策原因和成本风险诊断。
- 评审后再开放 `cacheDomain`。
- 根据实际 transport 能力细分 timeout 阶段。
- 评估使用 pi Custom Entry 恢复重启和 `/tree` 分支下的亲和状态。

## 15. 测试策略

至少覆盖：

- [x] `sessionId`、`cacheRetention` 和目标模型 `compat` 穿过 AliasProvider 到原生 transport；
- [x] 支持的 transport 按 compat 生成缓存键、缓存控制或上游亲和信息；
- [x] 同一 pi Session ID/alias 的亲和命中；
- 不同 session 的 balance 分配；
- failover 新会话仍从主线路开始；
- 切换后不立即 failback；
- Abort、overflow、400 和已提交内容硬停止；
- [x] 401、429 同 binding 账号优先；
- [x] binding `accounts` 范围校验、账号候选分组和账号级亲和恢复；
- 网络失败跨线路；
- 高成本 timeout 在三种成本策略下的差异；
- attempt 预算耗尽；
- open circuit 与 affinity 冲突；
- 配置重载移除粘性线路；
- context usage 已知与未知时的成本风险差异；
- Assistant Usage 的 cacheRead/cacheWrite/cost 被正确统计；
- 不输出 Secret 和原始 Session ID。

## 16. 风险与取舍

- 会话级 balance 分摊的是会话数，不保证 Token 或费用严格均衡。
- session 很少但大小差异很大时，负载可能倾斜；后续可考虑加权 rendezvous，但不应牺牲亲和性。
- 错误文本不可靠，必须优先使用结构化状态；无法判断时采用保守成本风险。
- `cacheDomain` 是用户声明，不是上游保证；错误配置可能无法获得预期缓存收益。
- 从请求级 balance 改为会话级 balance 是行为变更，需要明确迁移说明。
- Provider 对 `cacheRead`、`cacheWrite` 和 session-affinity 的实现口径不同；透传成功不等于缓存必然命中。
- `getContextUsage()` 可能暂时不可用，尤其在 compaction 后；不得把未知值当作零成本。

## 17. 进入实现前的决策门槛

开始编码前应确认：

1. 需求文档中的待确认事项已有结论；
2. ~~已通过测试确认 pi Session ID、`cacheRetention` 和目标模型 `compat` 的透传行为~~（阶段 0 已完成）；
3. ~~已确认 `ctx.getContextUsage()` 在当前 pi 版本中的实际字段与未知值语义~~（`{ tokens: number | null, contextWindow, percent: number | null }`，整体可能为 `undefined`）；
4. ~~已确认从哪一事件/消息读取最终 Assistant Usage~~（`done` 事件的 `message.usage`，或宿主 `message_end` 事件）；
5. 配置字段命名和默认值已评审；
6. 是否需要 ADR 记录 balance 语义变更；
7. 用户可见迁移和 CHANGELOG 方案已确定。
