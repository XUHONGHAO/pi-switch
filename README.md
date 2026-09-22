# pi-switch

[![CI](https://github.com/XUHONGHAO/pi-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/XUHONGHAO/pi-switch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

面向 [pi coding agent](https://github.com/badlogic/pi-mono) 的多 Provider 模型网关与配置管理扩展。

用一个模型别名聚合多条上游线路，在 OpenAI、Anthropic、Gemini 及兼容服务之间做优先级路由、故障切换或负载均衡；并提供中文 TUI 配置、API Key 池、线路健康管理和请求统计。

```text
pi-switch/gpt5
  ├─ OpenAI Official / gpt-5
  ├─ OpenAI Compatible / gpt-5
  └─ Backup Provider / gpt-5
```

调用方始终使用 `pi-switch/gpt5`，上游出错时按配置自动切到其他线路。

## 功能特性

- **统一模型别名**：一个名称聚合不同 Provider、endpoint、协议和模型 ID
- **三种路由策略**：`priority` / `failover` / `balance`（默认会话级负载均衡）
- **原生多协议转发**：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Generative AI
- **多账号 Key 池**：同一 Provider 配置多个 API Key，按优先级选择或故障切换
- **线路健康管理**：Circuit Breaker、`429` / `Retry-After` 冷却、会话粘性、显式 `cacheDomain` 缓存共享组
- **思考深度支持**：通过 `thinkingLevelMap` 配合 `Shift+Tab` / `/thinking` 切换思考级别
- **中文 TUI 配置**：`/config` 管理 Provider、别名、账号和路由，保存即热重载，无需手写 JSON
- **请求统计与诊断**：成功率、延迟、failover、上下文用量、缓存读写、费用，以及 `/switch check` / `probe`
- **认证复用**：复用 pi 的 `/login`、OAuth、环境变量与 `!command`；界面中 API Key 打码

## 环境要求

Node.js `>= 22.19.0`、pi coding agent `0.84.x`，支持 Windows / Linux / macOS。

## 安装

```bash
git clone https://github.com/XUHONGHAO/pi-switch.git
cd pi-switch
npm install
```

临时体验（不安装）：

```bash
pi -e ./src/index.ts
```

安装到 pi 扩展目录（正常启动 `pi` 时自动加载）：

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\scripts\link-extension.ps1
```

```bash
# Linux / macOS
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-switch
```

> 扩展与当前用户拥有相同权限，请只安装可信来源的代码。完整安装方式见 [安装与使用指南](docs/guides/installation.md)。

## 快速开始

在 pi 中依次执行：

```text
/config add-provider   # 添加 Provider（协议、baseUrl、API Key）
/config models         # 创建模型别名，添加线路并设置策略
/switch gpt5           # 切换到该别名
```

命令行调用：

```bash
pi -p "你好" --model pi-switch/gpt5 -e ./src/index.ts
```

已全局链接扩展时可省略 `-e ./src/index.ts`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `/switch` | 打开模型别名选择器 |
| `/switch <alias>` | 直接切换到指定别名 |
| `/switch status` | 当前线路、账号、延迟、缓存/费用/亲和统计与最近故障诊断 |
| `/switch providers` | 查看所有别名及其线路 |
| `/switch check` / `probe` | 检查配置引用与线路状态 / 主动探测响应延迟 |
| `/config` | 打开配置主菜单（providers / models / accounts / strategy） |
| `/config reload` | 从磁盘重新加载配置 |

## 路由策略

| 策略 | 行为 |
|---|---|
| `priority` | 只用优先级最高的可用线路，失败不切换 |
| `failover` | 产生内容前失败时按优先级切换，切换后会话粘住新线路 |
| `balance` | 会话级负载均衡（默认），每个会话分配一条线路并保持粘性 |

> 上游已输出内容后不再切换，以免拼接不同响应。会话亲和在 `/new`、`/fork`、`/clone` 时重置，`/resume` 时恢复。跨线路不保证共享 Prompt Cache，自动切换可能造成重复计费。

## 配置

配置默认保存在 `~/.pi-switch/`，可用环境变量 `PI_SWITCH_CONFIG_DIR` 更改：

```text
~/.pi-switch/
├── providers.json   # Provider 与协议
├── models.json      # 模型别名和线路
├── accounts.json    # 多账号 Key 池
├── routing.json     # 全局路由和健康参数
└── stats.json       # 请求统计（自动生成）
```

推荐用 `/config` 管理；也可直接编辑 JSON 后执行 `/config reload`。字段说明与示例见 [安装与使用指南](docs/guides/installation.md) 和 [`examples/`](examples/)。

API Key 支持直接值、`$ENV_VAR` 环境变量引用和 `!command` 命令；请勿把真实 Key 写入仓库。

## 文档

- [安装与使用指南](docs/guides/installation.md)：完整安装、配置字段、命令、故障排查
- [思考深度配置](docs/guides/thinking-support.md)：`thinkingLevelMap` 与 `Shift+Tab` / `/thinking`
- 架构、需求与决策：[`docs/`](docs/README.md)
- 开发约定：[`AGENTS.md`](AGENTS.md)、[开发手册](docs/development/handbook.md)

## 开发与测试

```bash
npm run typecheck
npm test
npm run check
```

CI 在 Ubuntu、Windows 和 macOS 上运行类型检查、测试与打包检查。提交前建议执行 `npm run check`。

## 参与贡献

欢迎 Issue 和 PR。报告问题时请附上操作系统、Node.js 与 pi 版本、协议与路由策略、`/switch check` 或 `/switch probe` 输出，以及已移除敏感信息的最小配置。

## License

[MIT](LICENSE)
