# pi-switch 安装与使用指南

> pi-switch — AI Agent Model Gateway & Provider Manager（pi agent Extension）
>
> 通过统一接口管理多个 AI Provider、API Key、模型别名以及请求路由。
> 本指南对应 pi-switch v0.3.2（正确性修复：strategy 合并、级联删除、!command 发现、别名 input）。

---

## 目录

1. [环境要求](#1-环境要求)
2. [安装](#2-安装)
3. [快速开始（5 分钟上手）](#3-快速开始5-分钟上手)
4. [配置详解](#4-配置详解)
5. [日常使用](#5-日常使用)
6. [路由与故障切换](#6-路由与故障切换)
7. [多账号 Key 池](#7-多账号-key-池)
8. [请求统计](#8-请求统计)
9. [preset 集成](#9-preset-集成)
10. [故障排查](#10-故障排查)
11. [开发与测试](#11-开发与测试)

---

## 1. 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 22.19 | 与 pi-ai 0.84.1 的 runtime 要求一致 |
| pi agent | 0.84.x | 扩展宿主（已全局安装） |
| 操作系统 | Windows / Linux / macOS | 跨平台 |

确认环境：

```bash
node --version   # v22.19+
pi --version     # 0.84.x
```

---

## 2. 安装

### 方式 A：开发模式（最快验证）

```bash
# 1. 克隆/拷贝项目
git clone <repo-url> pi-switch
cd pi-switch

# 2. 安装依赖（仅类型检查需要，运行时由 pi 的 jiti 直接加载 TS）
npm install

# 3. 启动 pi 并加载扩展
pi -e ./src/index.ts
```

启动后看到 `pi-switch loaded` 即安装成功：

```
[pi-switch] loaded v0.3.2 · providers: sub2api (openai, 3 model(s)), pi-switch (alias, 1 model(s))
```

### 方式 B：全局安装（推荐，支持 /reload 热重载）

把扩展挂到 pi 的自动发现目录：`~/.pi/agent/extensions/pi-switch`。

#### B1. 开发期推荐：目录联接（改完不用再复制）

Windows（本仓库已提供脚本）：

```powershell
cd C:\path\to\pi-switch
powershell -ExecutionPolicy Bypass -File .\scripts\link-extension.ps1
```

效果：`%USERPROFILE%\.pi\agent\extensions\pi-switch` → 指向你的开发目录。
之后只改源码，在 pi 里执行 `/reload` 即可，无需反复 `Copy-Item`。

手动创建联接也可以：

```powershell
# Windows junction（一般不需要管理员）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.pi\agent\extensions\pi-switch" `
  -Target "C:\path\to\pi-switch"

# Linux / macOS
mkdir -p ~/.pi/agent/extensions
ln -s /path/to/pi-switch ~/.pi/agent/extensions/pi-switch
```

取消联接（只删链接，不删开发目录）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\link-extension.ps1 -Unlink
```

#### B2. 复制安装（给别人机器 / 不想暴露开发目录）

```bash
# Linux / macOS
mkdir -p ~/.pi/agent/extensions
cp -r pi-switch ~/.pi/agent/extensions/pi-switch

# Windows（PowerShell）
mkdir -p $env:USERPROFILE\.pi\agent\extensions
Copy-Item -Recurse pi-switch $env:USERPROFILE\.pi\agent\extensions\pi-switch
```

之后正常启动 `pi` 即可；联接安装下修改源码后在 pi 内 `/reload`，复制安装则需再次复制。

> **安全提示**：扩展拥有与用户相同的完整权限，仅安装可信来源的扩展。

### 验证安装

```bash
# 应能看到 pi-switch 下的模型（前提是已配置 providers.json / models.json）
pi --list-models
```

---

## 3. 快速开始（5 分钟上手）

以"通过本地 sub2api 中转使用 GPT-5"为例。

### 第 1 步：创建配置目录

```bash
mkdir -p ~/.pi-switch
```

> 提示：也可以跳过手写配置：进入交互模式后直接用 **`/config add-provider`** 向导添加，等效于编辑 JSON。

### 第 2 步：配置 Provider

`~/.pi-switch/providers.json`：

```json
{
  "sub2api": {
    "name": "sub2api 中转",
    "type": "openai",
    "baseUrl": "http://127.0.0.1:6780/v1",
    "apiKey": "$SUB2API_API_KEY"
  },
  "openai_official": {
    "name": "OpenAI Official",
    "type": "openai",
    "baseUrl": "https://api.openai.com/v1"
  }
}
```

`$SUB2API_API_KEY` 是环境变量引用；若未设置且没有显式 `apiKey`，
OpenAI 兼容 Provider 默认按 `$<PROVIDER_NAME>_API_KEY` 约定读取
（如 `sub2api` → `$SUB2API_API_KEY`）。

### 第 3 步：配置模型别名

`~/.pi-switch/models.json`：

```json
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

### 第 4 步：启动并验证

```bash
# 查看已注册的 Provider 与模型
pi --list-models
# 期望看到：
#   pi-switch  gpt5   ...
#   sub2api    gpt-5  ...（自动发现或静态配置）

# 直接使用别名对话
pi -p "你好" --model pi-switch/gpt5
```

交互模式下：

```
pi> /switch gpt5          # 切换到 GPT-5
pi> /switch status        # 查看当前线路与统计
```

**完成！** 一个别名 `gpt5` 背后有两条线路，官方线路故障时自动切换 sub2api。

---

## 4. 配置详解

配置目录：`~/.pi-switch/`（可用环境变量 `PI_SWITCH_CONFIG_DIR` 覆盖）

```
~/.pi-switch/
├── providers.json   # Provider 列表
├── accounts.json    # API Key 池（多账号）
├── models.json      # 模型别名
├── routing.json     # 路由策略
└── stats.json       # 请求统计（自动生成）
```

> 缺失的配置文件视为空配置，扩展会为缺失文件创建配置目录，不会报错。

### 4.1 providers.json — Provider

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 否 | 显示名称（默认取 key） |
| `type` | 是 | 协议简写：`openai` / `openai-responses` / `anthropic` / `gemini` |
| `api` | 否 | 推荐显式设置为 `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai` |
| `baseUrl` | 是 | 对应原生协议的 API 根地址 |
| `enabled` | 否 | 是否启用（默认 true） |
| `apiKey` | 否 | Key 字面量、环境变量引用或 `!command`（请求时执行；`$!` 转义字面量 `!`） |
| `headers` | 否 | 附加请求头 |
| `models` | 否 | 静态模型定义（始终注册，不依赖发现） |
| `discoverModels` | 否 | 是否从 `GET {baseUrl}/models` 自动发现（OpenAI 兼容默认 true，5s 超时，失败不影响启动） |
| `modelDefaults` | 否 | 发现/静态模型的默认元数据 |
| `modelInclude` | 否 | 自动发现包含 glob（`*` / `?`） |
| `modelExclude` | 否 | 自动发现排除 glob（`*` / `?`） |

> **协议边界：** v0.3 alias 路由支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Google Generative AI，并委托 pi-ai 原生 streaming。Bedrock、Vertex 和 Azure Responses 暂未接入 alias transport。
>
> Provider 未配置账号池时，路由会优先复用 pi ModelRegistry 的 `/login`、OAuth、环境变量、动态 Header 与 `!command` 认证；账号池 Key 由 pi-switch 请求时解析。
>
> 自动发现结果缓存在 `~/.pi-switch/cache/models/`，网络不可用时自动使用上次成功结果。

静态模型与自动发现示例：

```json
{
  "openrouter": {
    "type": "openai",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "$OPENROUTER_API_KEY",
    "discoverModels": false,
    "models": [
      { "id": "openai/gpt-4o", "name": "GPT-4o", "contextWindow": 128000, "maxTokens": 16384 }
    ]
  },
  "llama_local": {
    "type": "openai",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "apiKey": "ollama",
    "discoverModels": true,
    "modelDefaults": { "contextWindow": 32768, "maxTokens": 4096 }
  }
}
```

### 4.2 models.json — 模型别名

| 字段 | 必填 | 说明 |
|------|------|------|
| `displayName` | 否 | 人类可读名称（选择器中显示） |
| `strategy` | 否 | 本别名的路由策略覆盖（priority / failover / balance） |
| `providers` | 是 | 线路绑定列表 |
| `reasoning` / `contextWindow` / `maxTokens` | 否 | 模型元数据 |

线路绑定字段：

> v0.3.1 默认线路身份由 `provider/api/baseUrl/model` 组成。同一 Provider 的不同 endpoint/model 不再共享熔断状态；重命名或调整 endpoint 时如需保留稳定统计键，请显式填写 `id`。

| 字段 | 说明 |
|------|------|
| `id` | 可选稳定线路标识；Circuit Breaker 和 AttemptStats 使用它区分 binding |
| `provider` | providers.json 中的 Provider key |
| `model` | 发送给该 Provider 的模型 ID |
| `authProvider` | 可选，委托给指定 pi Provider 解析 `/login`、OAuth 和动态 Header |
| `priority` | 路由优先级（越小越优先，默认按声明顺序） |
| `cacheDomain` | 用户声明的缓存共享组：故障切换时优先尝试同组线路。空值非法；同一组跨协议或跨主机会产生配置告警 |
| `api` | binding 协议覆盖，可让同一 alias 在不同线路使用不同协议 |
| `baseUrl` / `headers` | binding 级 endpoint 和 Header 覆盖 |
| `compat` | pi-ai 协议兼容参数覆盖 |
| `thinkingLevelMap` | 将 pi thinking level（含 `max`）映射到 Provider/model 值，`null` 表示不支持 |

```json
{
  "claude": {
    "displayName": "Claude Sonnet",
    "strategy": "balance",
    "providers": [
      { "provider": "sub2api", "model": "claude-sonnet-4-5" },
      { "provider": "openrouter", "model": "anthropic/claude-sonnet-4-5" }
    ]
  }
}
```

注册后 pi 中表现为虚拟 Provider `pi-switch` 的模型：`pi-switch/gpt5`、`pi-switch/claude`。

### 4.3 routing.json — 路由策略

```json
{
  "strategy": "failover",
  "balanceScope": "session",
  "failureCostPolicy": "balanced",
  "maxAttempts": 2,
  "maxHighCostFailovers": 1,
  "failoverOnUnknown": false
}
```

取值：`priority`（默认）| `failover` | `balance`。
解析优先级：models.json 别名级 `strategy` > routing.json 全局 `strategy` > 默认 `priority`。
`failureCostPolicy` 可选 `availability`、`balanced`（默认）或 `economy`；`maxAttempts` 限制单次请求尝试次数，`maxHighCostFailovers` 限制高成本切换次数，`failoverOnUnknown` 控制未知风险错误是否切换。

### 4.4 accounts.json — 账号（Key 池）

```json
{
  "sub2api_main":   { "provider": "sub2api", "apiKey": "$SUB2API_KEY_1", "priority": 1 },
  "sub2api_backup": { "provider": "sub2api", "apiKey": "$SUB2API_KEY_2", "priority": 2 },
  "disabled_key":   { "provider": "sub2api", "apiKey": "sk-xxx", "priority": 0, "enabled": false }
}
```

| 字段 | 说明 |
|------|------|
| `provider` | 所属 Provider key |
| `apiKey` | Key 字面量或环境变量引用 |
| `priority` | 账号优先级（越小越优先） |
| `enabled` | 是否启用（默认 true，false 直接跳过） |
| `stats` | 使用统计（由扩展写入，无需手动维护） |

模型别名的每条 binding 可选 `accounts` 字段限制账号范围：

```json
{
  "provider": "sub2api",
  "model": "gpt-5",
  "priority": 1,
  "accounts": ["sub2api_main", "sub2api_backup"]
}
```

省略 `accounts` 时使用该 Provider 的全部启用账号。账号必须存在且属于同一 Provider；401/429 会优先切换当前 binding 的其他账号，成功后当前会话继续使用该账号。

### 4.5 stats.json — 统计（自动生成）

无需手动配置，由扩展写入并跨会话累计：

```json
{
  "byAlias":   { "gpt5": { "requests": 3, "successes": 3, "failovers": 6, ... } },
  "byProvider": { "sub2api": { ... } },
  "byAccount":  { "sub2api_backup": { ... } }
}
```

### 4.6 环境变量

| 变量 | 说明 |
|------|------|
| `PI_SWITCH_CONFIG_DIR` | 覆盖配置目录（默认 `~/.pi-switch`） |
| `<PROVIDER>_API_KEY` | Provider 默认 Key 约定（如 `SUB2API_API_KEY`） |

---

## 5. 日常使用

### /switch 命令族

| 命令 | 说明 |
|------|------|
| `/switch` | 打开模型选择器（TUI 下带线路描述） |
| `/switch gpt5` | 直接切换模型 |
| `/switch status` | 当前模型 + 线路 + 账号 + 延迟 + 成本统计 + 最近故障决策诊断 |
| `/switch providers` | 列出所有别名及其线路/账号 |
| `/switch check` | 静态检查 alias、Key 池和 Circuit Breaker（`test` 仍可作为兼容别名） |
| `/switch probe` | 主动请求 Provider `/models`，检查连通性、HTTP 状态和延迟 |

示例输出：

```
pi> /switch status
Model: pi-switch/gpt5 · Provider: sub2api · Account: sub2api_backup · Latency: 2ms · 3 req · 100% ok · avg 3ms · 6 failover(s) · HTTP 503 · route-failover-allowed · medium
```

### 其他使用方式

```bash
# 命令行直接指定
pi -p "问题" --model pi-switch/gpt5

# pi 原生模型选择（/model 或 Ctrl+P）中选择 pi-switch 下的别名
```

### preset 命令

```bash
pi> /switch preset          # 选择 pi-switch preset
pi> /switch preset coding   # 直接应用
pi> /preset                 # pi 原生 preset 命令（所有 provider 类型）
pi> /preset my-deepseek     # 原生 preset，不冲突
```

> **重要：** pi-switch 使用 `/switch preset` 避免覆盖 pi 原生的 `/preset` 命令。
> `presets.json` 中 `provider: "pi-switch"` 的 preset 两个命令都能正常使用。

### /config 配置界面（无需手编 JSON）

交互模式下用向导式配置代替手编 JSON，**保存后热重载，无需重启 pi**：

```
pi> /config                 # 主菜单（Providers / 别名 / 账号 / 策略）
pi> /config providers       # 列表选择后编辑 baseUrl / apiKey / 启用状态等
pi> /config add-provider    # 向导式新增 Provider
pi> /config models          # 编辑别名及其线路（model / priority / strategy）
pi> /config accounts        # 管理 Key 池账号
pi> /config strategy failover   # 一键设置路由策略
pi> /config reload          # 外部改了 JSON 后热重载
```

> 表单要点：apiKey 只显示 `sk-****`（留空 = 不变）；所有修改点"保存并重载"后立即生效。非交互模式（print/rpc）下 `/config` 显示命令帮助。

---

## 6. 路由与故障切换

三种策略：

| 策略 | 行为 | 适用场景 |
|------|------|----------|
| `priority` | 固定使用最高优先级线路，失败不切换 | 官方 API 优先 |
| `failover` | 按优先级依次尝试，线路在**产生内容前**失败自动切下一条 | 追求可用性 |
| `balance` | 默认按 pi 会话在健康线路间稳定分配并保持粘性；设置 `balanceScope: "request"` 才逐请求轮询 | 多中转分摊负载并减少长会话缓存抖动 |

故障切换是**分层**的：账号级 401/429 先切当前 binding 的其他账号；网络或线路级错误再切其他 binding。

跨 Provider、endpoint 或账号切换不保证共享 Prompt Cache；原线路可能已经产生输入处理费用，因此自动 failover 仍可能造成重复计费。

```
请求 pi-switch/gpt5
  → 线路 1: sub2api/main 账号   401 → 切换同 binding 账号
  → 线路 1: sub2api/backup 账号 成功 ✓
  → 若该 binding 没有可用账号，再进入其他线路
```

日志示例：

```
[pi-switch] alias "gpt5": openai_official failed (Connection error.), failing over to sub2api/sub2api_main
[pi-switch] alias "gpt5": sub2api/sub2api_main failed (401: Invalid API key), failing over to sub2api/sub2api_backup
```

已输出部分内容后的失败不会切换（避免输出混乱），直接透传错误。

---

## 7. 多账号 Key 池

同一 Provider 配置多个 Key，自动按优先级选择，失败自动切换下一个账号：

```json
{
  "key_a": { "provider": "sub2api", "apiKey": "$SUB2API_KEY_A", "priority": 1 },
  "key_b": { "provider": "sub2api", "apiKey": "$SUB2API_KEY_B", "priority": 2 }
}
```

- 有账号的 Provider：候选线路展开为"每个账号一条"，binding 优先级为主、账号优先级仅在同一 binding 内生效
- 未配置账号的 Provider：使用 providers.json 的 `apiKey`
- 账号 `apiKey` 无法解析（环境变量缺失）时跳过并告警
- binding 配置 `accounts` 后，仅展开指定账号；成功切换后的账号会参与会话亲和与 `/resume` 恢复

---

## 8. 请求统计

自动记录，无需配置：

- 维度：别名 / Provider / 账号
- 指标：请求数、成功/失败数、成功率、累计与平均延迟、failover 次数
- 粒度：**每次用户请求**（pi 自动重试不会重复计数）
- 持久化：`stats.json`，2 秒防抖写盘 + 退出时强制落盘

> `cacheRead`、`cacheWrite` 和费用来自上游 Usage；不同 Provider 的统计口径可能不同，不应直接横向比较。跨线路切换也不保证共享缓存，并可能产生重复计费。

查看方式：

```
pi> /switch status
... · 3 req · 100% ok · avg 3ms · 6 failover(s)
```

---

## 9. preset 集成

兼容 pi 原生 preset 格式，`provider: "pi-switch"` 的 preset 通过别名路由。

全局：`~/.pi/agent/presets.json`，或项目本地 `.pi/presets.json`：

```json
{
  "coding": { "provider": "pi-switch", "model": "gpt5" },
  "creative": { "provider": "pi-switch", "model": "claude" }
}
```

```bash
pi> /switch preset coding   # pi-switch 命令，激活 coding
pi> /preset coding           # pi 原生命令，同样可用
```

> **注意：** pi-switch 使用 `/switch preset` 命令，不会覆盖 pi 原生的 `/preset`。
> 其他 provider（如 DeepSeek）的 preset 请继续用 `/preset`。

---

## 10. 故障排查

| 现象 | 原因与处理 |
|------|-----------|
| 启动无 `pi-switch loaded` | 扩展未加载。检查 `pi -e` 路径；全局安装时确认位于 `~/.pi/agent/extensions/` |
| `--list-models` 看不到 pi-switch 模型 | models.json 缺失或为空；确认配置文件在配置目录下 |
| 提示 `no usable provider binding` | 别名绑定的 Provider 不存在 / 被禁用 / 无 baseUrl，检查日志中的 `skipping` 告警 |
| 提示 `no API key` | 账号或 Provider 的 key 未配置或环境变量未设置；`/switch check` 查看线路可用性 |
| 模型发现失败但不影响启动 | `GET {baseUrl}/models` 失败（地址不可达 / 不支持），静态 `models` 仍生效，日志有 warning |
| 启动明显变慢 | 多个 Provider 同时做模型发现（每个最长 5s），可通过 `discoverModels: false` 关闭 |
| 非交互模式（print/rpc）下 `/config` 只显示帮助 | 正常行为：对话框需要 TUI，请用 `pi -e ./src/index.ts` 进入交互模式 |
| 修改配置后不生效 | 先检查 `/config reload` 的校验错误；非法外部配置会保留上一份有效配置，再修正文件后重载 |
| 请求失败但日志有 `failing over` 后仍报错 | 所有线路都失败，最终透传最后一条线路的真实错误 |
| Windows 下命令行传 `/switch xxx` 被转成路径 | git-bash 的 MSYS 路径转换：用 `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'`（交互模式不受影响） |

---

## 11. 开发与测试

```bash
npm run typecheck   # TypeScript 类型检查
npm run dev         # pi -e ./src/index.ts 开发模式
```

### 端到端测试（无需真实 API）

项目自带 mock OpenAI 兼容服务器：

```bash
# 终端 1：启动 mock（可选 MOCK_KEYS 指定合法 key，逗号分隔）
MOCK_KEYS=sk-good node tests/mock-openai-server.mjs 6780

# 终端 2：配置指向 mock 后验证
mkdir -p ~/.pi-switch-test
# 编写 providers.json / models.json（baseUrl 指向 http://127.0.0.1:6780/v1）
PI_SWITCH_CONFIG_DIR=~/.pi-switch-test pi -p "hi" --model pi-switch/gpt5 -e ./src/index.ts
```

多服务器场景可同时起多个实例模拟多线路：

```bash
MOCK_ID=server-a node tests/mock-openai-server.mjs 6780
MOCK_ID=server-b node tests/mock-openai-server.mjs 6781
```

### 项目结构

```
src/
├── index.ts              # 扩展入口（装配 / 命令 / 统计事件 / 热重载）
├── config/loader.ts      # 配置加载（5 个 JSON）
├── config/store.ts       # ConfigStore（可重载配置，/config 热更新核心）
├── provider/             # manager（注册+发现）/ openai（OpenAI 兼容）/ alias（虚拟 Provider+转发）
├── account/manager.ts    # 多账号 Key 池
├── model/resolver.ts     # 模型别名解析
├── router/router.ts      # 路由策略（priority/failover/balance）
├── preset/preset.ts      # preset 集成
├── stats/manager.ts      # 请求统计
└── ui/                   # selector（选择器）/ switch（/switch）/ config（/config 配置 UI）
```

---

## License

MIT
