# pi-switch 开发手册

> 本文档由早期阶段记录迁移而来，保留实现约定、配置结构与开发测试说明。当前产品范围与架构分别以 [`../requirements/product-scope.md`](../requirements/product-scope.md) 和 [`../architecture/overview.md`](../architecture/overview.md) 为准。

pi-switch 是 AI Agent Model Gateway & Provider Manager（pi agent Extension），通过统一接口管理多个 AI Provider、API Key、模型别名以及请求路由。

## 开发状态

- 当前版本：v0.3.2
- 当前阶段：v0.3.2 正确性修复已完成
- 发布记录：[`../../CHANGELOG.md`](../../CHANGELOG.md)
- 完整安装与配置参考：[`../guides/installation.md`](../guides/installation.md)

## Phase 8 能力

- **`/config` 命令**：TUI 向导式配置（Providers / 模型别名 / 账号 / 路由策略），无需手编 JSON
  - `/config providers` / `/config add-provider`：新增、编辑、删除 Provider（baseUrl / apiKey / 自动发现）
  - `/config models`：新增、编辑、删除别名及其线路（model / priority / strategy）
  - `/config accounts`：管理 Key 池账号
  - `/config strategy <s>`：一键设置路由策略
  - `/config reload`：从磁盘热重载配置
- **热重载**：ConfigStore 使配置可实时更新，保存后自动重新注册 Provider 与别名，**无需重启 pi**
- **Key 打码**：界面中 apiKey 只显示 `sk-****`，留空 = 不变

## 已完成

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | extension 入口、配置加载、Provider 注册 | 已完成 |
| Phase 2 | OpenAI Compatible Provider（模型发现 + 真实请求通路） | 已完成 |
| Phase 3 | 模型别名系统（models.json + 别名解析 + 流式转发） | 已完成 |
| Phase 4 | Router（priority / failover / balance + 自动切换） | 已完成 |
| Phase 5 | `/switch` 选择 UI + preset 集成 | 已完成 |
| Phase 6 | 多账号 Key 池（priority / 禁用 / failover） | 已完成 |
| Phase 7 | 请求统计（请求数 / 成功率 / 延迟 / failover） | 已完成 |
| Phase 8 | TUI 配置界面（/config 向导 + 热重载） | 已完成 |

## v0.3.2 正确性

- **`/config strategy` 合并写回**：只改 strategy，不再冲掉 `failureThreshold` / `cooldownMs` / `rateLimitCooldownMs`
- **删除 Provider 级联**：有账号/别名引用时提示并支持一并清理，避免保存校验失败
- **`!command` 模型发现**：启动发现与 `refreshModels` 和请求路径使用同一套 Secret 解析
- **别名 `input` 透传**：`models.json` 可声明 `input: ["text","image"]`，vision 不再被写死为纯文本
- **留空语义统一**：编辑 apiKey 时留空 = 不变；Provider 需显式「清除 apiKey」

## v0.3.1 稳定化

- **Binding 级线路身份**：Circuit Breaker 与 AttemptStats 不再只按 Provider 聚合；默认使用 `provider/api/baseUrl/model`，也可通过 binding `id` 显式指定稳定标识
- **结构化 HTTP 错误**：优先使用 transport/SDK 的状态码分类 401/403、429、408/504、5xx，并从 `Retry-After` Header 计算冷却时间
- **认证委托**：自定义 Provider 或 binding 可用 `authProvider` 委托给 pi 的内置 Provider（例如 `openai`、`anthropic`）解析 `/login`、OAuth 和动态 Header
- **协议感知校验**：按有效 `api` 检查 `compat` 字段并对错配字段告警；`thinkingLevelMap` 支持 `max`
- **端到端覆盖**：增加 AliasProvider → ModelRegistry header-only auth → OpenAI Responses 的真实 HTTP/SSE 测试

## 成本感知路由增量

- **阶段 A/B**：会话级 balance 与 failover 亲和、上下文用量、缓存读写和费用观测
- **阶段 C 第一批**：结构化故障决策、成本偏好和请求尝试预算
- **阶段 D 第一批**：binding `accounts` 范围、401/429 同 binding 账号优先，以及账号级会话亲和与 `/resume` 恢复
- **阶段 D 第二批**：保留非 2xx HTTP 状态；403 同 binding 账号恢复标记为 unknown 风险，无账号恢复时保守停止

## v0.3 能力

- **原生多协议路由**：委托 pi-ai transport 支持 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`
- **Binding 级协议覆盖**：同一别名可在不同线路使用不同 `api`、`baseUrl`、`headers` 和 `compat`
- **Thinking 映射**：Provider model 或 binding 可配置 `thinkingLevelMap`
- **pi 原生认证复用**：未使用账号池时，通过 ModelRegistry 复用 `/login`、OAuth、环境变量、动态 Header 和 pi 配置中的 `!command`
- **Secret command**：pi-switch 的 Provider/账号 Key 和 Header 支持请求时 `!command`；`$!` 表示字面量 `!`
- **原生 streaming**：不自行模拟协议，直接调用 pi-ai 对应协议的 `streamSimple`

> v0.3 当前支持上述四类 transport；Bedrock、Vertex、Azure Responses 等尚未接入 alias transport。

## v0.2 能力

- **Circuit Breaker**：网络、超时、5xx 连续失败达到阈值后暂时跳过坏线路
- **429 冷却**：识别 `Retry-After`，无提示时使用默认冷却时间
- **Attempt 统计**：记录每条上游线路的尝试数、成功率、TTFT、总耗时和错误分类
- **模型发现缓存与过滤**：离线启动保留模型目录，支持 include/exclude glob
- **安全持久化**：配置/缓存/统计使用临时文件替换；统计通过跨进程锁与增量合并避免覆盖
- **状态栏**：持续显示最近线路及打开的 circuit 数量
- **诊断**：`/switch check` 静态检查，`/switch probe` 主动探测

路由健康参数可在 `routing.json` 中配置：

```json
{
  "strategy": "failover",
  "failureThreshold": 3,
  "cooldownMs": 30000,
  "rateLimitCooldownMs": 60000
}
```

## Phase 7 能力

- **请求统计**：按别名 / provider / 账号记录请求数、成功率、累计与平均延迟
- **failover 计数**：自动切换次数单独统计，反映线路健康度
- **agent 级粒度**：pi 自动重试不重复计数（`agent_start` + `agent_settled`），每次用户请求只记一条
- **持久化**：写入 `~/.pi-switch/stats.json`（2s 防抖 + 退出时 flush），跨会话累计
- **状态展示**：`/switch status` 附带统计摘要

```
$ /switch status
Model: pi-switch/gpt5 · Provider: sub2api · Account: sub2api_backup · Latency: 820ms TTFT · 3 req · 100% ok · avg 830ms · 2 failover(s)
```

```json
// ~/.pi-switch/stats.json（自动生成）
{
  "byAlias": { "gpt5": { "requests": 3, "successes": 3, "failovers": 6, "totalLatencyMs": 9, ... } },
  "byProvider": { "sub2api": { ... } },
  "byAccount": { "sub2api_backup": { ... } }
}
```

## Phase 5 能力

### /switch 命令

| 命令 | 说明 |
|------|------|
| `/switch` | 打开模型选择器（TUI 下带线路描述的 SelectList） |
| `/switch gpt5` | 直接切换到别名 |
| `/switch status` | 当前模型 + 路由线路 + 账号 + 延迟 |
| `/switch providers` | 列出所有别名及其线路/账号 |
| `/switch check` | 静态检查别名、Key 池和 Circuit Breaker 状态（`test` 为兼容别名） |
| `/switch probe` | 并发请求各 Provider 的 `/models` 端点并输出延迟/状态 |

```
$ /switch status
Model: pi-switch/gpt5 · Provider: sub2api · Account: sub2api_backup · Latency: 820ms TTFT
```

### preset 集成

兼容 pi 原生 preset 格式（`~/.pi/agent/presets.json` 或项目 `.pi/presets.json`），
`provider: "pi-switch"` 的 preset 通过别名系统路由：

```json
{
  "coding": { "provider": "pi-switch", "model": "gpt5" },
  "creative": { "provider": "pi-switch", "model": "claude" }
}
```

```
/switch preset          # 选择 pi-switch preset
/switch preset coding   # 直接应用
```

> **注意：** pi-switch 使用 `/switch preset` 命令，不会覆盖 pi 原生的 `/preset` 命令。
> 其他 provider 的 preset 请使用 pi 原生 preset 扩展（`/preset`）。
> pi-switch preset（`provider: "pi-switch"`）也能通过原生 `/preset` 命令正常使用。

## Phase 6 能力

- **Key 池**：accounts.json 为同一 provider 配置多个 API Key
- **账号展开**：每个启用账号展开为独立候选线路，绑定优先级为主、账号优先级为次排序
- **账号 failover**：账号 key 无效/被限流时自动切换同 provider 的下一个账号
- **禁用**：`enabled: false` 的账号直接跳过
- **统计透传**：账号 `stats` 字段透传（Phase 7 写入请求次数/延迟等）
- **回退**：provider 从未配置账号时使用 providers.json 的 `apiKey`；已配置账号池但全部禁用/不可用时不回退

## 账号配置示例

```json
// ~/.pi-switch/accounts.json
{
  "gpt5_main": { "provider": "sub2api", "apiKey": "sk-xxxx", "priority": 1 },
  "gpt5_backup": { "provider": "sub2api", "apiKey": "sk-yyyy", "priority": 2 },
  "gpt5_disabled": { "provider": "sub2api", "apiKey": "sk-zzzz", "priority": 0, "enabled": false }
}
```

failover 效果：主账号 401/限流 → 自动切备用账号，日志显示 `sub2api/acc_bad ... failing over to sub2api/acc_good`。

## Phase 4 能力

- **三种路由策略**：`priority`（固定最高优先级线路）、`failover`（按优先级依次尝试，失败自动切换）、`balance`（轮询）
- **透明故障切换**：线路在**产生任何内容前**失败时自动切到下一条（failover / balance），用户无感知
- **策略解析顺序**：models.json 别名级 `strategy` > routing.json 全局 `strategy` > 默认 `priority`
- **绑定优先级**：绑定可配 `priority` 字段（越小越优先），同优先级保持声明顺序
- **失败收敛**：所有线路失败后透传最后一条线路的真实错误

## 路由配置示例

```json
// ~/.pi-switch/routing.json（全局默认）
{ "strategy": "failover" }

// ~/.pi-switch/models.json（别名级覆盖）
{
  "gpt5": {
    "displayName": "GPT-5",
    "strategy": "failover",
    "providers": [
      { "provider": "openai_official", "model": "gpt-5", "priority": 1 },
      { "provider": "sub2api", "model": "gpt-5", "priority": 2 }
    ]
  }
}
```

failover 效果：官方线路宕机 → 自动切到 sub2api，日志显示 `failing over to "sub2api"`。

## Phase 3 能力

- **统一模型别名**：models.json 中定义别名（如 `gpt5`），pi 中注册为虚拟 provider `pi-switch` 的模型（`pi-switch/gpt5`）
- **多线路绑定**：一个别名可绑定多个 provider/model，转发时按 Router 策略选择
- **流式转发**：请求经 binding 对应的 pi-ai 原生 `streamSimple` 实时转发，支持流式输出与工具调用
- **健壮性**：绑定指向缺失/禁用/未配置 baseUrl 的 provider 时跳过并警告；别名无可用绑定时返回明确的错误流

## 别名示例

```json
// ~/.pi-switch/models.json
{
  "gpt5": {
    "displayName": "GPT-5",
    "providers": [
      { "provider": "sub2api", "model": "gpt-5" },
      { "provider": "openai_official", "model": "gpt-5" }
    ]
  }
}
```

使用：

```
pi --model pi-switch/gpt5          # 直接指定
pi -p "hi" --model pi-switch/gpt5  # print 模式
# 交互模式 /model 中选择 GPT-5
```

请求链路：`pi-switch/gpt5` → 解析别名 → 选择 `sub2api/gpt-5` → 用 sub2api 的 baseUrl/Key 发起流式请求。

## 安装与启动

```bash
cd pi-switch
npm install
npm run link:ext   # Windows: junction ~/.pi/agent/extensions/pi-switch -> 本仓库

# 开发模式：直接用 -e 加载
pi -e ./src/index.ts

# 或复制/链接到全局扩展目录（支持 /reload 热重载）
#   ~/.pi/agent/extensions/pi-switch/  (Linux/macOS)
#   %USERPROFILE%\.pi\agent\extensions\pi-switch\  (Windows)
```

## 配置

配置目录：`~/.pi-switch/`（可用环境变量 `PI_SWITCH_CONFIG_DIR` 覆盖）

```
~/.pi-switch/
├── providers.json   # Provider 列表（Phase 1/2 使用）
├── accounts.json    # API Key 池（Phase 6）
├── models.json      # 模型别名（Phase 3 使用）
├── routing.json     # 路由策略（Phase 4）
└── stats.json       # 使用统计（Phase 7）
```

示例配置见 [`../../examples/`](../../examples/)。

### Provider 字段（providers.json）

| 字段 | 说明 |
|------|------|
| `name` | Provider 显示名称（默认取 key） |
| `type` | 协议简写：`openai` / `openai-responses` / `anthropic` / `gemini` |
| `api` | 推荐显式填写：`openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai` |
| `baseUrl` | 对应原生协议的 API 根地址 |
| `enabled` | 是否启用（默认 true） |
| `apiKey` | API Key 字面量、环境变量引用（`$ENV_VAR`）或 `!command` |
| `headers` | 附加请求头 |
| `authProvider` | 可选：委托给指定 pi Provider 解析 `/login`、OAuth 和动态 Header |
| `models` | 静态模型定义（始终注册） |
| `discoverModels` | 是否从 `GET {baseUrl}/models` 自动发现（OpenAI 兼容默认 true） |
| `modelDefaults` | 发现/静态模型的默认元数据（contextWindow / maxTokens / reasoning / input / cost） |
| `modelInclude` | 自动发现包含规则，支持 `*` / `?` glob |
| `modelExclude` | 自动发现排除规则，支持 `*` / `?` glob |

> **协议边界：** v0.3 alias 路由支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI。协议由 binding `api` 优先，其次 Provider `api`，最后由 `type` 推断。

自动发现成功后会缓存到 `~/.pi-switch/cache/models/<provider>.json`；下次启动先加载缓存，网络发现失败也保留上次模型列表。

OpenAI 兼容类型的 Provider 未显式配置 `apiKey` 时，默认按
`$<PROVIDER_NAME>_API_KEY` 约定读取环境变量（如 `sub2api` → `$SUB2API_API_KEY`）。

### 别名字段（models.json）

| 字段 | 说明 |
|------|------|
| `displayName` | 人类可读名称（如 "GPT-5"） |
| `providers` | 绑定列表：`{ id?, provider, model, api?, authProvider?, baseUrl?, headers?, compat?, thinkingLevelMap? }`；`id` 是稳定线路标识 |
| `reasoning` / `input` / `contextWindow` / `maxTokens` | 模型元数据（可选；`input` 默认 `["text"]`，vision 写 `["text","image"]`） |

## 开发与测试

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # pi -e ./src/index.ts

# 端到端测试（无需真实 API）：
node tests/mock-openai-server.mjs 6780       # 终端 1：mock OpenAI 兼容服务
PI_SWITCH_CONFIG_DIR=/tmp/test pi -p "hi" --model pi-switch/gpt5 -e ./src/index.ts
```

## License

MIT
