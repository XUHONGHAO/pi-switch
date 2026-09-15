# pi 原生透传契约（已验证）

- 状态：verified
- 核对版本：pi / pi-coding-agent / pi-ai `0.84.1`，pi-switch `0.3.2`
- 关联需求：[`../requirements/cost-aware-routing.md`](../requirements/cost-aware-routing.md) 第 5.2、5.6 节
- 回归测试：`tests/pi-host-passthrough.integration.test.ts`、`tests/alias-native-passthrough.integration.test.ts`

本文件是“pi 提供什么、pi-switch 必须原样转发什么、pi-ai 据此生成什么”的权威描述。缓存与会话亲和字段全部由 pi-ai 生成，pi-switch 不实现任何缓存协议。

## 1. pi 侧提供的输入

| 输入 | 来源 | 说明 |
|---|---|---|
| `options.sessionId` | `Agent` 构造时读取 `sessionManager.getSessionId()` | 每次请求都带上；`/new`、`/fork`、`/clone` 产生新 Session ID，`/resume` 恢复原值。`/clone` 内部走 fork 路径。 |
| `options.cacheRetention` | 通常 **不设置** | pi 只在 compaction/branch-summary 请求显式传 `"none"`（并另配一次性 `sessionId`）。普通回合由 pi-ai 自行取默认值。 |
| 模型 `compat` | pi 的 provider 组合层（provider 目录、`models.json`、扩展注册模型） | 决定上游是否真的收到缓存键与亲和 Header。 |
| `ctx.getContextUsage()` | `AgentSession` | 返回 `undefined`（无模型或 `contextWindow <= 0`），或 `{ tokens: number \| null, contextWindow, percent: number \| null }`；compaction 后若尚无新的 assistant usage，`tokens`/`percent` 为 `null`。 |
| Assistant `usage` | `done` 事件的 `message.usage` / `message_end` 事件 | 含 `input`、`output`、`cacheRead`、`cacheWrite`、可选 `cacheWrite1h`、`reasoning` 与 `cost`。 |

`Session ID` 为 uuidv7 字符串（36 字符），短于 OpenAI `prompt_cache_key` 的 64 字符上限，pi-ai 的截断逻辑不会生效。

## 2. pi-switch 必须保持的转发不变量

`AliasProvider.route()` 调用 `streamWithTransport(targetModel, context, { ...options, apiKey, headers, onResponse })`，因此：

1. `options.sessionId`、`options.cacheRetention` 及其他宿主 stream options 原样传递；只有 `apiKey`、`headers`、`onResponse` 被覆盖（`onResponse` 仍会回调宿主的原始实现）。
2. `targetModel.compat` 取自 binding/provider 配置，缺省时回退到 pi 注册模型的 `compat`，二者都不得丢弃。
3. pi-switch 不生成 `prompt_cache_key`、`cache_control` 或任何亲和 Header。

## 3. pi-ai 各 transport 的实际行为

同一组 `sessionId` + `cacheRetention` 在不同协议下产生不同字段，配置 UI 与文档不应假设行为一致。

| transport | 缓存字段 | 亲和 Header | 关键前提 |
|---|---|---|---|
| `openai-completions` | `prompt_cache_key`、`prompt_cache_retention: "24h"` | `session_id`（`sessionAffinityFormat: "openai"`）、`x-client-request-id`、`x-session-affinity`；`openrouter` 格式改为 `x-session-id` | 缓存键仅在 `baseUrl` 含 `api.openai.com`，或 `cacheRetention === "long"` 且 `supportsLongCacheRetention` 时出现；亲和 Header 需显式 `sendSessionAffinityHeaders: true`（默认 `false`） |
| `openai-responses` | `prompt_cache_key`（除 `cacheRetention === "none"`）、`prompt_cache_retention` 需 `long` | `session_id`、`x-client-request-id`（无 `sendSessionAffinityHeaders` 开关） | 与 `baseUrl` 无关，默认即发送缓存键 |
| `anthropic-messages` | 系统提示、最后一条会话消息与最后一个 tool 上的 `cache_control: { type: "ephemeral" }`，`long` 且 `supportsLongCacheRetention` 时附 `ttl: "1h"` | `x-session-affinity` | 亲和 Header 需 `sendSessionAffinityHeaders: true`（默认 `false`）；OAuth / GitHub Copilot 分支不发送该 Header |
| `google-generative-ai` | 不消费 `sessionId` / `cacheRetention`；仅在 usage 中回报 `cachedContentTokenCount` | 无 | 不得假定其具备会话亲和能力 |

补充事实：

- `cacheRetention` 默认值由 pi-ai 解析为 `"short"`，`PI_CACHE_RETENTION=long` 可将其提升为 `"long"`。
- 因此在“默认 short + 非官方 OpenAI endpoint + 未开启 compat”的常见中转站配置下，上游收不到任何缓存键或亲和 Header。要拿到 pi-ai 已有的缓存能力，必须由用户在 binding/provider 上声明对应 `compat`（未来可考虑同时开放 `cacheRetention`）。
- 透传成功不代表缓存命中；实际效果只能通过 assistant usage 的 `cacheRead` / `cacheWrite` 观测。
