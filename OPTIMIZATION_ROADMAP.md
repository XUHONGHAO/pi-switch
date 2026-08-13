# pi-switch 项目评审与优化路线图

> 评审对象：pi-switch v0.1.0
> 评审日期：2026-08-11
> 项目定位：pi agent 的模型别名、Provider 管理、多账号与智能路由扩展

---

## 1. 总体评价

如果按个人项目或 MVP 衡量，当前完成度约为 **7.5/10**；如果按可长期稳定使用的生产级模型网关衡量，约为 **5.5/10**。

pi-switch 已经不只是一个简单的模型切换脚本，而是具备完整网关雏形的 pi 扩展：

- Provider 注册与模型发现
- 模型别名
- 多线路路由
- 多 API Key 池
- 流式请求转发
- 无内容输出时故障切换
- 请求统计
- TUI 配置界面
- 配置热重载

当前代码结构也比较清晰：

- `provider/`、`router/`、`account/`、`model/` 职责明确
- `ConfigStore` 统一管理配置和热重载
- Provider、Resolver 与 Router 基本解耦
- failover 只发生在产生内容之前，避免混合多条线路的输出
- Provider 模型发现具有超时和降级逻辑
- README、INSTALL 和示例配置较完整

项目真正有竞争力的方向并不是“切换模型”本身，而是：

> 模型别名 + 多线路健康路由 + 多 Key 池 + 可观测的自动故障切换。

当前最需要解决的问题是：文档中声明支持的范围比实际稳定实现的范围更大，并且部分边界行为会影响真实使用。

---

## 2. 当前值得保留的设计

### 2.1 模块划分合理

当前目录结构基本符合后续扩展需要：

```text
src/
├── account/       # 多账号 Key 池
├── config/        # 配置读取与保存
├── model/         # 模型别名解析
├── preset/        # preset 集成
├── provider/      # Provider 注册与别名 Provider
├── router/        # 路由策略
├── stats/         # 请求统计
└── ui/            # /switch 与 /config UI
```

建议继续保持“配置、解析、路由、传输、UI”分离，避免将健康检查、熔断和协议适配继续堆入 `AliasProvider`。

### 2.2 使用虚拟 Provider 暴露模型别名

将别名注册为：

```text
pi-switch/gpt5
pi-switch/claude
```

能够自然融入 pi 的模型注册表、`/model` 和命令行 `--model`，这是一个正确的集成方向。

### 2.3 无内容输出时才进行 failover

当前实现避免在一条线路已经输出文本后切换到另一条线路，能够防止用户看到拼接或重复内容。该原则应继续保留，并通过测试固定下来。

### 2.4 配置驱动与热重载

Provider、账号、模型别名和路由策略均由配置驱动，且 `/config` 保存后能够重新注册 Provider。这是良好的使用体验，也是后续 Web UI 或 daemon 化的基础。

---

## 3. P0：优先修复的正确性问题

以下问题建议在增加新功能之前修复。

### 3.1 `/switch preset` 当前无法按预期执行

#### 问题

`src/preset/preset.ts` 当前注册：

```ts
pi.registerCommand("switch preset", ...)
```

但 pi 扩展命令只将输入中第一个空格前的内容解析为命令名。

因此：

```text
/switch preset coding
```

实际执行的是已注册的 `switch` 命令，并将 `preset coding` 作为参数传入。`switch preset` 这个带空格的命令名不会被匹配。

#### 建议

将 preset 作为现有 `/switch` 命令的子命令处理：

```ts
if (arg === "preset" || arg.startsWith("preset ")) {
  // 打开 preset 选择器或直接应用指定 preset
}
```

也可以改成独立命令：

```text
/switch-preset coding
```

优先推荐第一种方式，使命令保持统一：

```text
/switch
/switch gpt5
/switch status
/switch providers
/switch preset coding
```

#### 附加问题

当前会读取 `preset.instructions`，但自定义应用流程没有实际应用该字段。在补齐行为前，不宜宣称与原生 preset 完全等价。

---

### 3.2 文档声称支持 Anthropic/Gemini，但别名转发固定使用 OpenAI Completions

#### 问题

`src/provider/alias.ts` 最终固定调用：

```ts
openAICompletionsApi().streamSimple(...)
```

因此别名路由当前实际上只支持 OpenAI Chat Completions 兼容协议。

同时，当前 `apiForType()` 对非 OpenAI 类型直接返回配置中的 `type`：

```ts
return isOpenAICompatible(type) ? "openai-completions" : type;
```

但 pi 的标准 API 标识包括：

```text
openai-completions
openai-responses
anthropic-messages
google-generative-ai
azure-openai-responses
```

简单配置 `type: "anthropic"` 或 `type: "gemini"` 并不能保证得到合法且可用的 API 实现。

#### 短期建议

v0.1.x 明确收缩范围：

- 仅承诺 OpenAI Chat Completions Compatible
- `/config` 暂时只允许创建 OpenAI Compatible Provider
- 配置加载时拒绝或警告不支持的 binding
- README、INSTALL 和示例配置同步修改

建议文案：

> pi-switch v0.1 当前支持 OpenAI Chat Completions 兼容接口。Anthropic Messages、OpenAI Responses 和 Gemini 原生协议将在后续版本支持。

#### 中期建议

引入 Transport Adapter：

```ts
interface TransportAdapter {
  supports(binding: ResolvedBinding): boolean;
  stream(
    binding: ResolvedBinding,
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
}
```

可逐步实现：

- `OpenAICompletionsTransport`
- `OpenAIResponsesTransport`
- `AnthropicMessagesTransport`
- `GoogleGenerativeAITransport`

更理想的实现是委托给 pi 已注册目标 Provider 的原生流处理，而不是在 pi-switch 内重新实现全部协议。

---

### 3.3 账号全部禁用时可能意外回退到 Provider Key

#### 问题

`AliasProvider.expandCandidates()` 当前逻辑类似：

```ts
const accounts = this.accounts.forProvider(binding.provider);
if (accounts.length === 0) {
  candidates.push(binding);
  continue;
}
```

`forProvider()` 只返回启用且 API Key 可解析的账号。

当某个 Provider 已经配置账号池，但账号全部被禁用或 Key 无法解析时，`accounts.length` 仍为 0，随后可能回退使用 `providers.json` 中的 Provider Key。

这会违反用户“禁用账号”的明确意图。

#### 建议语义

- 从未配置账号池：允许使用 Provider Key
- 配置过账号池，但全部不可用：该 Provider 当前不可用
- 如需回退，必须使用显式配置，例如：

```json
{
  "fallbackToProviderKey": true
}
```

#### 建议实现

复用已有的 `AccountManager.hasAccounts()`：

```ts
if (!this.accounts.hasAccounts(binding.provider)) {
  candidates.push(binding);
  continue;
}

const accounts = this.accounts.forProvider(binding.provider);
for (const account of accounts) {
  candidates.push(/* account candidate */);
}
```

---

### 3.4 流式 failover 的事件序列可能不合法

#### 问题

上游通常会先发送：

```text
start
```

如果线路 A 随后在没有输出内容时失败，A 的 error 被抑制，然后线路 B 又可能发送：

```text
start
text_start
...
```

下游可能收到：

```text
start(A)
start(B)
text_start(B)
...
```

这不是一个干净的单流事件序列。

此外，当前异步路由主体缺少覆盖整个 attempt 循环的 `try/catch/finally`。如果 `streamSimple()` 或 `for await` 直接抛出异常，而不是生成 `error` 事件，外层 stream 可能不能正确生成终止事件或执行 `end()`。

#### 建议

为每次 attempt 增加“线路提交”状态：

1. 将上游 `start` 暂存在本地
2. 在出现第一个真实内容事件时才向下游提交该线路
3. 一旦提交该线路，不再允许 failover
4. attempt 抛出的异常统一转换成标准 error
5. 使用 `finally` 保证 `stream.end()`

需要通过测试固定以下情况：

- A 连接失败，B 成功
- A 发出 `start` 后失败，B 成功
- A 已输出文本后失败，不得切换
- 用户 Abort 后不得切换
- 所有线路失败时只能产生一个终止 error

---

### 3.5 failover 条件过于宽泛

当前基本是“无内容 error + 有下一条线路”就执行 failover，但不同错误需要不同处理：

| 错误 | 建议行为 |
|---|---|
| 用户取消 / Abort | 立即停止，不 failover |
| Context overflow | 交给 pi 自动 compact/retry，不应换线路 |
| 400 参数错误 | 通常不 failover，除非明确属于线路兼容问题 |
| 401/403 | 优先切换同 Provider 的账号 |
| 429 | 根据 `Retry-After` 冷却账号或线路，再切换 |
| 5xx | 切换线路 |
| DNS/连接/超时 | 切换线路 |
| 已产生内容后的错误 | 不切换 |

建议增加统一错误分类：

```ts
type ErrorCategory =
  | "aborted"
  | "context-overflow"
  | "auth"
  | "rate-limit"
  | "invalid-request"
  | "timeout"
  | "network"
  | "server"
  | "unknown";
```

Router 根据分类决定：

- 是否切账号
- 是否切 Provider
- 是否熔断
- 冷却多久
- 是否直接将错误交还给 pi

---

## 4. 路由系统优化

### 4.1 增加 Circuit Breaker

当前每次请求都会重新尝试最高优先级线路。

如果线路 A 持续宕机，则每次请求都可能经历：

```text
A 等待超时 → B 成功
```

用户每次都会承担 A 的超时。

建议维护线路健康状态：

```ts
interface RouteHealth {
  consecutiveFailures: number;
  state: "closed" | "open" | "half-open";
  cooldownUntil?: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}
```

推荐初始规则：

- 连续失败 3 次：熔断 60 秒
- 冷却结束：进入 half-open
- half-open 只允许一个探测请求
- 探测成功：恢复 closed
- 探测失败：重新 open
- 429：按 `Retry-After` 或默认时间冷却
- 401/403：账号标记不可用，直到配置变更或人工恢复

---

### 4.2 从 round-robin 升级为健康感知评分

在没有足够历史数据前，不建议直接实现复杂机器学习或动态加权。

可以先采用简单评分：

```text
score =
  配置优先级
  + 熔断惩罚
  + 最近失败惩罚
  + P95 延迟惩罚
  + 429 冷却惩罚
```

选择分数最低的线路。

建议保留三种基础策略，同时增加一个健康感知策略：

```text
priority
failover
balance
adaptive
```

---

### 4.3 明确 Provider 路由和账号路由的层级

当前将 Provider binding 与账号展开成同一级 candidate，虽然简单，但会导致 `balance` 同时在 Provider 与账号之间轮询。

建议逐步调整为两层：

```text
Model Alias
  ├── Provider Route A
  │     ├── Account A1
  │     └── Account A2
  └── Provider Route B
        ├── Account B1
        └── Account B2
```

允许分别配置：

```json
{
  "providerStrategy": "failover",
  "accountStrategy": "round-robin"
}
```

常见且合理的组合是：

- Provider：priority + failover
- 同 Provider 账号：round-robin 或 least-used

---

## 5. 尽量复用 pi 原生 Provider 能力

pi 已经具备：

- 自定义 Provider 注册
- 模型注册和刷新
- `/login` 与 `auth.json`
- OAuth
- 环境变量和 `!command` Secret 解析
- Provider/model headers
- OpenAI compatibility 配置
- `thinkingLevelMap`
- `samplingParams`
- Provider 原生 streaming

当前别名转发路径自行解析 Key 并固定走 OpenAI Completions，因此没有完整复用：

- `/login` 保存的凭据
- `!command` Secret
- 目标模型 `compat`
- Provider 原生认证逻辑
- OpenAI Responses、Anthropic 和 Gemini 的原生实现
- 目标模型完整元数据

### 推荐的长期边界

pi-switch 主要负责：

- alias
- route selection
- health state
- failover
- stats
- UI

协议、认证和 Provider 兼容性尽量由 pi 原生 Provider 负责。

理想情况下，binding 应解析到实际模型：

```ts
const targetModel = ctx.modelRegistry.find(binding.provider, binding.model);
```

然后使用目标 Provider 对应的原生流实现发起请求。

如果受当前 API 限制无法完全委托，也应通过 Transport Adapter 隔离协议差异，避免让 Router 直接依赖 `openAICompletionsApi()`。

---

## 6. 模型发现优化

### 6.1 增加模型过滤

当前 `GET /models` 返回的所有条目都会注册，其中可能包含：

- embedding 模型
- TTS 模型
- image 模型
- rerank 模型
- 不支持 Chat Completions 的模型

建议支持 include/exclude：

```json
{
  "modelInclude": ["gpt-*", "claude-*"],
  "modelExclude": ["*-embedding-*", "*-tts", "*-image*", "*-rerank*"]
}
```

还可以增加显式模型类型筛选或用户确认步骤。

### 6.2 缓存最后一次成功发现结果

建议缓存路径：

```text
~/.pi-switch/cache/models/<provider>.json
```

启动流程：

1. 先读取上次成功缓存，使模型立即可用
2. 再请求远程 `/models`
3. 成功后更新缓存
4. 发现失败时保留旧目录

这样可以减少启动等待，并提高 Provider 临时不可用时的稳定性。

---

## 7. 配置与安全

### 7.1 增加运行时 Schema 校验

当前配置加载主要检查顶层是不是 JSON object，无法及时发现字段级错误。

建议使用 TypeBox、Zod 或 JSON Schema 校验：

- Provider key 格式
- `baseUrl` 是否合法
- `strategy` 是否属于枚举
- `priority` 是否为有限数字
- alias 是否至少有一个 binding
- binding 引用的 Provider 是否存在
- account 引用的 Provider 是否存在
- 模型 ID 是否为空
- 当前 Transport 是否支持该 Provider
- 保留 Provider 名称冲突
- Header 是否为字符串值

建议增加：

```text
/config validate
```

错误信息应包含文件和 JSON 路径：

```text
models.json:gpt5.providers[1].provider:
provider "foo" does not exist
```

### 7.2 配置保存改为原子写入

当前 `saveSection()` 直接覆盖正式 JSON 文件。进程异常退出时可能留下空文件或部分内容。

建议流程：

1. 校验新配置
2. 写入 `providers.json.tmp`
3. 完成关闭或 fsync
4. 将旧文件备份为 `.bak`
5. rename 临时文件替换正式文件
6. 重新注册 Provider
7. 重新注册失败时恢复旧配置

### 7.3 配置重载前等待 Agent 空闲

pi 的扩展命令可以在 Agent 工作时立即执行。若此时 unregister/re-register Provider，可能产生竞态。

建议所有会修改 Provider 注册状态的命令先执行：

```ts
await ctx.waitForIdle();
```

然后再保存和重载。

### 7.4 Secret 管理升级

Key 打码只解决了显示层问题，Key 仍可能明文保存在 `accounts.json`。

建议优先支持：

- `$ENV_VAR`
- pi `/login` 和 `auth.json`
- `!op read ...`
- `!security find-generic-password ...`
- Windows Credential Manager
- macOS Keychain
- Linux Secret Service

最低要求：

- 示例配置全部使用环境变量，不使用看似真实的 Key
- 文件写入时限制权限
- 日志永不打印 Key
- Secret headers 同样解析并脱敏
- 文档明确说明明文 Key 风险

当前自定义 `resolveEnvRef()` 只覆盖环境变量，不支持 pi 原生 `!command` Secret 语义，建议逐步复用 pi 的认证解析机制。

---

## 8. 统计与可观测性

### 8.1 修正延迟定义

当前首次收到任意 stream event 就记录 latency，但第一个事件通常是本地立即生成的 `start`，因此显示的延迟可能只有几毫秒，并不是真正的首 Token 时间。

建议分别记录：

- `connectMs`：收到 HTTP response
- `ttftMs`：首个 `text_delta`、`thinking_delta` 或 `toolcall_delta`
- `totalMs`：收到 done/error
- `tokensPerSecond`
- HTTP 状态码
- 错误分类

UI 中最有价值的是：

```text
TTFT 820ms · total 6.2s · 58 tok/s
```

### 8.2 区分请求级统计与 attempt 级统计

示例：

```text
A 失败 → B 失败 → C 成功
```

最终请求是成功的，但 A/B 的失败必须被独立记录，否则无法形成正确的健康状态。

建议拆分：

```ts
interface RequestStats {
  requestId: string;
  alias: string;
  success: boolean;
  failovers: number;
  totalMs: number;
}

interface AttemptStats {
  requestId: string;
  provider: string;
  account?: string;
  startedAt: number;
  ttftMs?: number;
  totalMs: number;
  success: boolean;
  statusCode?: number;
  errorCategory?: ErrorCategory;
}
```

Router 的熔断和评分应使用 AttemptStats，而不是最终请求统计。

### 8.3 解决多进程覆盖问题

多个 pi 进程同时运行时：

1. 两个进程读取相同旧数据
2. 各自累加
3. 后写入者覆盖先写入者

短期方案：

- 临时文件 + rename
- 写前重新读取并 merge
- 文件锁

长期推荐 SQLite，因为以下数据天然适合数据库：

- 请求统计
- attempt 历史
- 线路健康状态
- 熔断状态
- 模型发现缓存

---

## 9. UI 与用户体验

### 9.1 增加常驻状态指示

可使用 `ctx.ui.setStatus()` 显示：

```text
pi-switch: gpt5 → sub2api/key-b · TTFT 820ms · healthy
```

在发生 failover 时临时提示：

```text
openai-official → sub2api（429）
```

并监听 `model_select` 更新状态。

这能让用户明确知道当前实际使用的 Provider 和账号，是模型路由器很有辨识度的体验。

### 9.2 让 `/switch test` 做真正的测试

当前 `/switch test` 更接近“检查是否配置 Key”，并没有请求 Provider。

建议拆分为：

```text
/switch check        # 静态配置检查
/switch probe        # GET /models 或最小请求探测
/switch benchmark    # 多次测试 TTFT/P95
```

探测应支持：

- AbortSignal 取消
- 并行度限制
- 超时配置
- TUI Loader
- Provider/账号级结果
- 状态码和错误分类显示

### 9.3 改善配置向导

建议后续增加：

- Provider 使用选择器，而不是手输 key
- 模型使用发现结果选择器，而不是手输 model id
- 保存前显示 diff
- 保存前自动 validate
- 删除 Provider 时提示受影响的 alias/account
- 删除 alias 时提示 preset 引用
- 提供“测试后保存”流程

---

## 10. 工程化建议

### 10.1 增加自动化测试

当前 `test/mock-openai-server.mjs` 适合手工 E2E，但不足以作为回归保障。

#### 单元测试

至少覆盖：

- Router priority 排序
- Router balance 轮询
- stable sort 与同优先级行为
- 账号 candidate 展开
- 账号全部禁用时不回退
- 环境变量 Key 解析
- 配置 Schema 校验
- 模型发现 merge/filter
- 错误分类
- Circuit Breaker 状态迁移

#### 流式集成测试

至少覆盖：

- 第一线路连接失败，第二线路成功
- 第一账号 401，切换第二账号
- Provider 429，遵守 `Retry-After`
- 第一线路发出 `start` 后失败
- 已输出文本后失败，不切换
- AbortSignal 中止
- 所有线路失败
- Context overflow 不被错误 failover
- 工具调用流完整透传
- Unicode 内容
- 图片输入和图片 tool result
- 空响应和异常终止

### 10.2 增加 CI

推荐最小 CI：

```text
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

当前评审环境尝试执行 `npm run typecheck` 时，因为项目副本未安装 `node_modules`，`tsc` 不可用。这不代表代码存在类型错误，只表示当前环境未能完成类型检查。

### 10.3 按 pi package 规范整理 package.json

建议增加：

- `keywords: ["pi-package"]`
- repository、bugs、homepage
- `files` 白名单
- `test`、`check` 和 `prepack`
- CHANGELOG

pi 核心包建议放入 `peerDependencies`，使用 `"*"` 范围：

```json
{
  "keywords": ["pi-package", "pi", "model-router"],
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "check": "npm run typecheck && npm test",
    "prepack": "npm run check"
  }
}
```

TypeScript、测试框架和 `@types/node` 保留在 `devDependencies`。

---

## 11. 长期产品架构

当前实现与长期愿景之间存在边界差异。

当前代码实现的是：

> pi 内部的 Model Router Extension

长期愿景是：

> Claude Code、Codex、OpenCode、Gemini CLI 和 pi 共用的 Gateway

仅靠 pi Extension 无法直接成为其他 Agent 的统一后端。

如果决定实现跨 Agent Gateway，建议拆分：

```text
pi-switch-core
  ├── config
  ├── routing
  ├── health
  ├── accounts
  └── stats

pi-switch-daemon
  ├── OpenAI-compatible HTTP endpoint
  ├── Anthropic-compatible endpoint
  └── admin API

pi-switch-pi-extension
  ├── /switch
  ├── /config
  └── status UI
```

这样：

- pi 扩展负责管理界面和 pi 集成
- Claude Code、Codex、OpenCode 指向 daemon
- 路由、熔断、账号池和统计只有一套核心实现
- 多个 Agent 可以共享线路健康状态
- Web UI 可以连接 daemon 的 admin API

在 v0.x 阶段不必立即 daemon 化，但应避免让 Router、Stats 和 Config 强依赖 pi UI 类型，为将来抽离 `pi-switch-core` 保留空间。

---

## 12. 推荐版本路线图

### v0.1.1：正确性修复

目标：让当前已声明的 MVP 行为可靠。

- [x] 修复 `/switch preset` 命令解析
- [x] 明确 v0.1 仅支持 OpenAI Compatible
- [x] 修复账号全部禁用时回退 Provider Key
- [x] 修复 failover 流事件序列
- [x] 为路由异步任务增加完整异常兜底
- [x] 根据错误类型决定是否 failover
- [x] 修正 TTFT 统计
- [x] 增加配置 Schema 与引用校验
- [x] 增加 Router、错误分类和配置校验测试
- [x] 增加 AliasProvider 流式 failover 集成测试（v0.2 完成后统一补充）
- [x] 同步 README、INSTALL 与实际能力

### v0.2：可靠性与可观测性

目标：减少坏线路对用户请求延迟的持续影响。

- [x] Circuit Breaker
- [x] 429 `Retry-After` 冷却
- [x] Attempt 级统计
- [x] 模型发现缓存
- [x] 模型 include/exclude 过滤
- [x] 原子配置写入与失败回滚
- [x] 重载前等待 Agent 空闲
- [x] 常驻状态栏
- [x] `/switch check` 与 `/switch probe`
- [x] 多进程统计安全

### v0.3：协议与 pi 原生能力集成

目标：从 OpenAI Compatible Router 扩展为真正的多协议 Router。

- [x] Transport Adapter（基于 pi-ai 原生 transport dispatch）
- [x] OpenAI Responses
- [x] Anthropic Messages
- [x] Gemini / Google Generative AI
- [x] binding 级 `api` / `baseUrl` / headers / compat
- [x] `thinkingLevelMap`
- [x] 复用 pi 原生 Provider auth（ModelRegistry）
- [x] 复用 `/login` 和 OAuth
- [x] 支持 `!command` Secret（Provider/账号 Key 与 Header）
- [x] 委托目标 Provider 原生 streaming
- [x] 多协议配置校验、单元测试与既有 SSE failover 回归

实现说明：未配置账号池时，AliasProvider 通过 pi 的 ModelRegistry 获取目标模型认证，因而能复用宿主的存储凭据、OAuth 刷新、环境变量、动态 Header 和配置命令。配置账号池时则保留 pi-switch 的逐账号路由语义，并在请求时解析 Secret。v0.3 的 alias transport 范围是 OpenAI Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI。

### v1.0 或独立 Gateway 阶段

目标：成为多 Agent 共用的本地模型网关。

- [ ] 抽离 `pi-switch-core`
- [ ] 本地 Gateway daemon
- [ ] OpenAI-compatible 服务端接口
- [ ] Anthropic-compatible 服务端接口
- [ ] SQLite
- [ ] Admin API
- [ ] Web UI
- [ ] 多 Agent 共享路由状态
- [ ] 配置迁移和版本升级机制

---

## 13. 建议的代码层次演进

建议最终逐步演进为：

```text
src/
├── core/
│   ├── config/
│   │   ├── schema.ts
│   │   ├── loader.ts
│   │   └── store.ts
│   ├── routing/
│   │   ├── router.ts
│   │   ├── policy.ts
│   │   ├── health.ts
│   │   └── circuit-breaker.ts
│   ├── accounts/
│   │   └── pool.ts
│   ├── stats/
│   │   ├── request-stats.ts
│   │   └── attempt-stats.ts
│   └── errors/
│       └── classify.ts
├── transports/
│   ├── transport.ts
│   ├── openai-completions.ts
│   ├── openai-responses.ts
│   ├── anthropic.ts
│   └── google.ts
├── pi/
│   ├── provider.ts
│   ├── commands/
│   ├── preset.ts
│   └── ui/
└── index.ts
```

不需要一次性重构。推荐先提取：

1. Error classifier
2. Attempt executor
3. Health/Circuit Breaker
4. Transport interface

这样可以逐步降低 `provider/alias.ts` 的复杂度。

---

## 14. v0.3.1 稳定化（已完成）

- [x] Circuit Breaker 与 AttemptStats 改为 binding 级稳定线路身份；支持显式 `id`
- [x] 优先使用结构化 HTTP status 分类错误，并解析 `Retry-After` 秒数或 HTTP-date
- [x] 自定义 Provider/binding 支持 `authProvider`，可委托 pi 内置 `/login`、OAuth 和动态 Header
- [x] 按有效协议校验 `compat` 字段，错配字段输出 warning；thinking level 补齐 `max`
- [x] 增加 AliasProvider → ModelRegistry header-only auth → OpenAI Responses 真实集成测试
- [x] 增加 `.npmignore`、MIT `LICENSE`、`CHANGELOG.md`、`prepack` 检查和三平台 CI

兼容说明：旧 binding 无需修改，默认线路键由 provider、api、baseUrl 和 model 自动生成。已有 `stats.json` 不会被删除；升级后的新 AttemptStats 使用 binding 级键。若希望修改 endpoint/model 后仍保持同一统计身份，应显式设置 binding `id`。

---

## 14.1 v0.3.2 正确性（已完成）

- [x] `/config strategy` 合并写回现有 routing 阈值，避免冲掉 failureThreshold / cooldownMs / rateLimitCooldownMs
- [x] 删除 Provider 时检测账号/别名依赖，支持级联清理
- [x] 启动模型发现与 `refreshModels` 使用 `resolveConfigValue`（支持 `!command`）
- [x] 别名 `input` 模态透传；`ModelAliasConfig.input` 可配置
- [x] Provider apiKey 编辑「留空 = 不变」，与 README / 账号编辑语义一致

---

## 15. 最终建议

pi-switch 值得继续开发，但现阶段应优先从“增加功能”转向“提高正确性与可靠性”。

最重要的四个关键词是：

1. **正确性**：命令、账号语义、流事件必须准确
2. **可靠性**：错误分类、熔断、冷却和回滚
3. **复用**：尽量使用 pi 原生 Provider、认证和协议能力
4. **测试**：通过自动化测试固定路由与流式边界行为

完成 v0.1.1 和 v0.2 后，项目将从“功能较多的 MVP”提升为一个可以长期挂载使用的可靠 pi 扩展。之后再扩展多协议和独立 Gateway，风险会明显更低。
