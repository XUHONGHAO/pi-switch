# ADR 0009：cacheDomain 声明与故障候选排序

- 状态：accepted
- 日期：2026-09-22
- 关联：[ADR 0007](0007-deferred-cache-domain-and-host-e2e.md)（本决策替代其第 1 条延期项）

## 背景

需求 5.9 和策略计划第 9 节要求：账号级故障后，候选顺序为「同 binding 的其他账号 → 同一显式 `cacheDomain` 的其他线路 → 其他线路」。ADR 0007 曾以「缺少可验证的共享缓存契约、误配检测和候选排序测试」为由延期该字段。

pi-switch 无法证明任意两个上游真的共享 Prompt Cache。因此需要一种保守、可解释、由用户显式承担声明的语义，而不是让扩展推断缓存共享。

## 决策

1. `models.json` 的 binding 增加可选字段 `cacheDomain?: string`。它是**用户声明**：声明这些 binding 预期共享缓存域，而不是上游保证。
2. `cacheDomain` 只影响**故障候选排序**，不改变新会话的初始选路，也不改写 `priority` 主线路语义。
3. 候选顺序为三层，逐层保留原有相对顺序：
   1. 同一 binding 的其他账号（相同 `lineId`）；
   2. 与当前线路具有相同非空 `cacheDomain` 的其他线路；
   3. 其余线路，按 priority / 声明顺序。
4. 只有当当前线路声明了非空 `cacheDomain` 时才重排。重排让显式缓存域偏好优先于其他线路的 priority，因为这是用户主动选择的成本优化信号。
5. 会话亲和命中时同样按当前亲和线路的 `cacheDomain` 重排其后续候选。
6. 误配检测（只告警，不阻断）：
   - 空字符串或非字符串 `cacheDomain` 为配置错误；
   - 同一 `cacheDomain` 跨越多个 API 协议时告警；
   - 同一 `cacheDomain` 跨越多个上游主机时告警。
7. `cacheDomain` 不生成任何缓存或亲和字段。缓存键、`cache_control` 和 session-affinity Header 仍完全由 pi-ai 原生 transport 按 `compat` 产生，见 [`../architecture/pi-native-passthrough.md`](../architecture/pi-native-passthrough.md)。

## 后果

- 用户可以显式表达「这两条线路共享缓存」，故障切换时优先保留缓存命中，减少重复计费。
- 误配不会破坏请求，但会收到明确告警；扩展不承诺缓存一定命中。
- 候选排序可能在 alternatives 层面先于 priority，这是有意的：只有声明了 `cacheDomain` 的线路才会触发重排；未声明的配置行为与之前完全一致。
- 账号配额自动策略、TUI 原生缓存开关和独立进程重启 E2E 仍按 ADR 0007 延期。
