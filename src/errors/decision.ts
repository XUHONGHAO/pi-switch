import type { ErrorCategory } from "./classify";
import type { FailureCostPolicy } from "../config/loader";

export type FailureAction = "stop" | "retry-same-route" | "switch-account" | "switch-route";
export type FailureScope = "request" | "account" | "route" | "provider" | "unknown";
export type CostRisk = "low" | "medium" | "high" | "unknown";
export type AttemptPhase = "resolving-auth" | "connecting" | "awaiting-response" | "streaming";
export const DEFAULT_FAILURE_COST_POLICY: FailureCostPolicy = "balanced";
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_MAX_HIGH_COST_FAILOVERS = 1;
export const DEFAULT_FAILOVER_ON_UNKNOWN = false;

export interface FailureContext {
  category: ErrorCategory;
  contextTokens?: number;
  contextRatio?: number;
  contextUsageReliable: boolean;
  status?: number;
  retryAfterMs?: number;
  phase: AttemptPhase;
  contentCommitted: boolean;
  aborted: boolean;
  canFailover: boolean;
  hasAlternativeAccount: boolean;
  hasAlternativeRoute: boolean;
  attemptsUsed: number;
  maxAttempts: number;
  highCostFailoversUsed: number;
  maxHighCostFailovers: number;
  policy: FailureCostPolicy;
  failoverOnUnknown: boolean;
}

export interface FailureDecision {
  action: FailureAction;
  scope: FailureScope;
  costRisk: CostRisk;
  cooldownMs?: number;
  openCircuit?: boolean;
  reasonCode: string;
  reason: string;
}

function isLongContext(context: FailureContext): boolean {
  if (!context.contextUsageReliable) return false;
  return (context.contextRatio ?? 0) >= 80 || (context.contextTokens ?? 0) >= 100_000;
}

function riskFor(context: FailureContext): CostRisk {
  switch (context.category) {
    case "network": return "low";
    case "auth":
    case "rate-limit": return "medium";
    case "server": return isLongContext(context) ? "high" : "medium";
    case "timeout": return context.contextUsageReliable ? (isLongContext(context) ? "high" : "medium") : "unknown";
    case "unknown": return "unknown";
    case "aborted":
    case "context-overflow":
    case "invalid-request": return "high";
  }
}

function stop(scope: FailureScope, costRisk: CostRisk, reasonCode: string, reason: string): FailureDecision {
  return { action: "stop", scope, costRisk, reasonCode, reason };
}

/** Make an explainable failover decision after hard response-safety constraints. */
export function decideFailure(context: FailureContext): FailureDecision {
  if (context.aborted || context.category === "aborted") return stop("request", "low", "abort-requested", "用户已取消请求");
  if (context.contentCommitted) return stop("request", "high", "content-already-committed", "响应已提交内容，不能切换线路");
  if (context.category === "context-overflow") return stop("request", "high", "context-overflow", "上下文超出模型窗口，交由 pi 处理");
  if (context.category === "invalid-request") return stop("request", "high", "invalid-request", "请求参数无效，切换线路不会修复该请求");
  const costRisk = riskFor(context);
  if (!context.canFailover) return stop("route", costRisk, "strategy-disallows-failover", "当前路由策略不允许故障切换");
  if (context.attemptsUsed >= context.maxAttempts) return stop("request", costRisk, "attempt-budget-exhausted", "已达到本次请求的最大尝试次数");
  if (!context.hasAlternativeAccount && !context.hasAlternativeRoute) return stop("route", costRisk, "no-alternative", "没有可用的备用线路");
  if (costRisk === "unknown" && !context.failoverOnUnknown) return stop("unknown", costRisk, "unknown-risk-conservative", "无法确认失败成本风险，按保守策略停止");
  if (context.policy === "economy" && costRisk !== "low") return stop("route", costRisk, "economy-policy-limit", "economy 成本策略不允许该风险级别的自动切换");
  if (costRisk === "high" && context.policy === "balanced" && context.highCostFailoversUsed >= context.maxHighCostFailovers) {
    return stop("route", costRisk, "high-cost-budget-exhausted", "已达到高成本故障切换预算");
  }
  const accountFailure = context.category === "auth" || context.category === "rate-limit";
  const action: FailureAction = accountFailure && context.hasAlternativeAccount ? "switch-account" : "switch-route";
  return {
    action,
    scope: action === "switch-account" ? "account" : "route",
    costRisk,
    ...(context.category === "rate-limit" && context.retryAfterMs !== undefined ? { cooldownMs: context.retryAfterMs } : {}),
    openCircuit: context.category === "network" || context.category === "server",
    reasonCode: action === "switch-account" ? "account-failover-allowed" : "route-failover-allowed",
    reason: action === "switch-account" ? "账号级错误，优先切换同线路备用账号" : `允许切换备用线路（成本风险: ${costRisk}）`,
  };
}

/** Backwards-compatible boolean view for callers that only need a category gate. */
export function canFailoverForDecision(category: ErrorCategory): boolean {
  return category !== "aborted" && category !== "context-overflow" && category !== "invalid-request";
}
