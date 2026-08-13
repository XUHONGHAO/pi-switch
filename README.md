# pi-switch

[![CI](https://github.com/XUHONGHAO/pi-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/XUHONGHAO/pi-switch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

面向 [pi coding agent](https://github.com/badlogic/pi-mono) 的多 Provider 模型网关与配置管理扩展。

使用一个模型别名连接多条上游线路，在 OpenAI、Anthropic、Gemini 及兼容服务之间进行优先级路由、故障切换或负载均衡；同时提供中文 TUI 配置界面、API Key 池、线路健康管理和请求统计。

## 为什么使用 pi-switch？

如果同一个模型存在官方 API、中转服务和多个 API Key，通常需要反复修改 Provider 与模型配置。pi-switch 将它们统一成一个稳定别名：

```text
pi-switch/gpt5
  ├─ OpenAI Official / gpt-5
  ├─ OpenAI Compatible / gpt-5
  └─ Backup Provider / gpt-5
```

调用方始终使用 `pi-switch/gpt5`。上游发生网络错误、限流或服务异常时，可按照配置自动选择其他线路。

## 功能特性

- **统一模型别名**：一个名称聚合不同 Provider、endpoint、协议和真实模型 ID
- **三种路由策略**：
  - `priority`：仅使用最高优先级线路
  - `failover`：失败时按优先级自动切换
  - `balance`：在线路之间轮询
- **原生多协议转发**：支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI
- **多账号 Key 池**：同一 Provider 可配置多个 API Key，并按优先级选择或故障切换
- **Circuit Breaker**：连续失败后暂时跳过异常线路，并识别 `429` 与 `Retry-After`
- **中文 TUI 配置**：通过 `/config` 管理 Provider、模型别名、账号和路由，无需手写 JSON
- **热重载**：配置保存后立即重新注册模型，无需重启 pi
- **模型发现与缓存**：支持 `/models` 自动发现、glob 过滤和离线缓存
- **认证复用**：可复用 pi 的 `/login`、OAuth、环境变量、动态 Header 与 `!command`
- **请求统计与诊断**：记录成功率、延迟和 failover，并提供静态检查与主动探测
- **安全配置**：界面中 API Key 打码，配置保存前执行结构和字段校验

## 环境要求

- Node.js `>= 22.19.0`
- pi coding agent `0.84.x`
- Windows、Linux 或 macOS

确认环境：

```bash
node --version
pi --version
```

## 安装

目前推荐从源码安装。

### 1. 克隆并安装依赖

```bash
git clone https://github.com/XUHONGHAO/pi-switch.git
cd pi-switch
npm install
```

### 2. 加载扩展

临时加载，适合先体验：

```bash
pi -e ./src/index.ts
```

或者安装到 pi 的扩展目录，以便正常启动 `pi` 时自动加载。

#### Windows

项目附带目录联接脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\link-extension.ps1
```

取消联接：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\link-extension.ps1 -Unlink
```

#### Linux / macOS

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-switch
```

> 扩展与当前用户拥有相同权限，请只安装可信来源的代码。

## 快速开始

启动交互模式：

```bash
pi -e ./src/index.ts
```

### 1. 添加 Provider

在 pi 中执行：

```text
/config add-provider
```

按照界面依次填写：

- Provider 标识和显示名称
- API 协议
- `baseUrl`
- API Key、环境变量引用或 `!command`
- 是否自动发现模型

API Key 推荐使用环境变量，例如：

```text
$OPENAI_API_KEY
```

### 2. 创建模型别名

执行：

```text
/config models
```

选择“新增模型别名”，填写别名和 `contextWindow（上下文窗口）`，再从已配置的 Provider 中添加线路。例如：

```text
别名：gpt5
线路 1：openai_official / gpt-5
线路 2：openai_compatible / gpt-5
策略：failover（失败时自动切换线路）
```

### 3. 选择并使用模型

```text
/switch
```

在列表中选择刚创建的模型别名。也可以直接切换：

```text
/switch gpt5
```

命令行调用：

```bash
pi -p "你好，请介绍一下自己" --model pi-switch/gpt5 -e ./src/index.ts
```

如果已经全局链接扩展，可以省略 `-e ./src/index.ts`。

## 常用命令

### 模型与线路

| 命令 | 说明 |
|---|---|
| `/switch` | 打开模型别名选择器 |
| `/switch <alias>` | 直接切换到指定别名 |
| `/switch status` | 查看当前模型、实际线路、账号、延迟和统计 |
| `/switch providers` | 查看所有别名及其线路 |
| `/switch check` | 检查配置引用、Key 池和 Circuit Breaker 状态 |
| `/switch probe` | 主动探测 Provider 的模型接口和响应延迟 |

### 配置管理

| 命令 | 说明 |
|---|---|
| `/config` | 打开配置主菜单 |
| `/config providers` | 管理 Provider |
| `/config add-provider` | 新增 Provider |
| `/config models` | 管理模型别名和线路 |
| `/config accounts` | 管理多账号 API Key 池 |
| `/config strategy <strategy>` | 设置全局路由策略 |
| `/config reload` | 从磁盘重新加载配置 |

## 路由策略

| 策略 | 行为 | 适用场景 |
|---|---|---|
| `priority` | 只使用优先级最高的可用线路，失败不切换 | 必须固定使用指定上游 |
| `failover` | 在产生内容前失败时自动尝试下一条线路 | 优先保障可用性 |
| `balance` | 按轮询方式分配请求，失败时继续尝试 | 多线路分摊请求 |

> 如果上游已经输出内容，pi-switch 不会再切换线路，以免把不同响应拼接在一起。

## 配置文件

配置默认保存在：

```text
~/.pi-switch/
├── providers.json   # Provider 与协议配置
├── models.json      # 模型别名和线路
├── accounts.json    # 多账号 API Key 池
├── routing.json     # 全局路由和健康参数
└── stats.json       # 自动生成的请求统计
```

可通过环境变量 `PI_SWITCH_CONFIG_DIR` 更改配置目录。完整示例见 [`example/`](example/)。

虽然推荐使用 `/config`，也可以直接编辑 JSON，然后执行 `/config reload`。

### Provider 示例

```json
{
  "openai_official": {
    "name": "OpenAI Official",
    "type": "openai-responses",
    "api": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "$OPENAI_API_KEY",
    "discoverModels": false,
    "models": [
      {
        "id": "gpt-5",
        "name": "GPT-5",
        "reasoning": true
      }
    ]
  }
}
```

支持的 API 协议：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`

### 模型别名示例

```json
{
  "gpt5": {
    "displayName": "GPT-5",
    "strategy": "failover",
    "contextWindow": 1000000,
    "providers": [
      {
        "provider": "openai_official",
        "model": "gpt-5",
        "priority": 1
      },
      {
        "provider": "openai_compatible",
        "model": "gpt-5",
        "priority": 2
      }
    ]
  }
}
```

`contextWindow` 的默认值为 `200000`，使用默认值时可以省略。

### 多账号 Key 池示例

```json
{
  "main_key": {
    "provider": "openai_compatible",
    "apiKey": "$OPENAI_KEY_1",
    "priority": 1
  },
  "backup_key": {
    "provider": "openai_compatible",
    "apiKey": "$OPENAI_KEY_2",
    "priority": 2
  }
}
```

未配置账号池时使用 Provider 自身的 `apiKey`；配置账号池后，每个启用账号会作为独立候选线路。

### 路由健康参数示例

```json
{
  "strategy": "failover",
  "failureThreshold": 3,
  "cooldownMs": 30000,
  "rateLimitCooldownMs": 60000
}
```

## API Key 与 Secret

Provider 和账号的 API Key 支持：

```text
sk-...                    # 直接值，不推荐提交到版本控制
$OPENAI_API_KEY           # 环境变量，推荐
!secret-tool get api-key  # 请求时执行命令
```

请勿将真实 API Key 写入仓库。项目中的 [`example/`](example/) 只包含占位符和环境变量引用。

## Preset 集成

在 `~/.pi/agent/presets.json` 或项目 `.pi/presets.json` 中使用：

```json
{
  "coding": {
    "provider": "pi-switch",
    "model": "gpt5"
  }
}
```

应用 preset：

```text
/switch preset coding
```

也可以使用 pi 原生 `/preset` 命令。pi-switch 不会覆盖该命令。

## 故障排查

| 问题 | 处理方式 |
|---|---|
| 启动时没有 pi-switch 加载信息 | 检查 `-e` 路径或扩展目录链接 |
| 看不到 `pi-switch/<alias>` 模型 | 创建模型别名，并执行 `/config reload` |
| 提示没有可用线路 | 用 `/switch check` 检查 Provider 引用、启用状态和 API Key |
| 模型发现失败 | 检查 `baseUrl`；不支持 `/models` 时关闭自动发现并配置静态模型 |
| 配置修改后没有生效 | 执行 `/config reload` 或在 pi 中执行 `/reload` |
| 所有线路最终仍报错 | 执行 `/switch probe`，并检查各线路的认证和协议配置 |

## 开发与测试

```bash
npm run typecheck
npm test
npm run check
```

CI 会在 Ubuntu、Windows 和 macOS 上运行类型检查、测试及 npm 打包检查。

## 参与贡献

欢迎提交 Issue 和 Pull Request。建议在提交前运行：

```bash
npm run check
```

报告问题时，请提供：

- 操作系统、Node.js 与 pi 版本
- 使用的协议类型和路由策略
- `/switch check` 或 `/switch probe` 输出
- 已移除 API Key 等敏感信息的最小配置

## License

[MIT](LICENSE)
