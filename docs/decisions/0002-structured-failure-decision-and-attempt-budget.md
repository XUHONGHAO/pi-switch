# ADR 0002：采用结构化故障决策与请求尝试预算

- 状态：accepted
- 日期：2026-09-14

## 背景

仅用错误类别的布尔 `canFailover` 无法表达响应是否已提交、上下文重发成本、未知风险和账号优先级，也无法限制一次请求的重复尝试成本。

## 决策

阶段 C 第一批引入 `FailureDecision`，统一表达动作、失败作用域、成本风险、冷却提示和稳定原因码。决策先执行 Abort、已提交内容、上下文溢出和无效请求等硬停止，再根据上下文用量、请求阶段、成本偏好和候选情况决定是否切换。

路由配置默认使用 `failureCostPolicy: balanced`、`maxAttempts: 2`、`maxHighCostFailovers: 1` 和 `failoverOnUnknown: false`。历史缓存 Usage 只用于观测和诊断，不直接改变选路。

## 后果

故障动作可测试、可解释，并能防止无限重试或长上下文的过度切换。账号/线路层级的完整候选排序和显式 `cacheDomain` 保留到后续阶段 D/E；未知 transport 阶段仍采用保守标记。
