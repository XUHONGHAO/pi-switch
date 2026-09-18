# ADR 0005：按请求阶段评估 timeout 成本风险

- 状态：accepted
- 日期：2026-09-16

## 背景

pi-ai transport 可以可靠地告诉扩展请求是否已收到 HTTP response，以及是否已经开始产生内容。此前所有 timeout 都只按上下文长度判断，无法区分连接尚未建立和上游已经收到请求但迟迟没有首个响应的情况。

## 决策

1. 收到任何 HTTP response（包括 4xx/5xx）后，将 attempt 阶段推进为 `awaiting-response`；连接异常或 response 之前抛出的 timeout 保持 `connecting`。
2. `resolving-auth`/`connecting` 阶段的 timeout 视为低成本风险；`awaiting-response`/`streaming` 阶段继续结合 `ctx.getContextUsage()`，长上下文提升为高风险，未知用量保持未知风险。
3. 不伪造 DNS、TLS、首 Token 等底层细节；无法从 transport 得到更细信号时只使用上述保守阶段。

## 后果

- 长上下文请求在上游已收到 HTTP 请求后不会被误判为低成本重试。
- 连接阶段的可恢复 timeout 仍可在预算内切换线路。
- timeout 阶段判定依赖 pi-ai 当前 response/stream 信号；后续 transport 提供更细事件时再扩展，不改变现有字段含义。
