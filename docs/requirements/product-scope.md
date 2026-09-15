# 产品范围与核心行为

- 状态：implemented
- 最近核对版本：0.3.2

## 目标

让 pi 用户通过稳定的模型别名使用多个上游 Provider 和账号，并在可安全切换的错误发生时自动选择备用线路。

## 核心行为

1. 一个 alias 可绑定多条不同 Provider、模型、协议或账号线路。
2. 支持 `priority`、`failover`、`balance` 三种路由策略。
3. 仅在当前线路尚未提交内容且错误允许切换时 failover；用户取消、上下文溢出、无效请求或已输出内容后不得切换。
4. 支持 OpenAI Completions、OpenAI Responses、Anthropic Messages 和 Google Generative AI transport。
5. 支持线路熔断、429 冷却、模型发现缓存和 request/attempt 统计。
6. 用户可通过 `/switch` 使用别名，通过 `/config` 管理配置并热重载。
7. API Key 支持环境变量与命令引用；界面和日志不得泄露 Secret。

## 非目标

- 当前不是独立 HTTP 网关，也不直接服务其他 Agent。
- 当前不承诺跨进程共享实时健康状态。
- 当前不覆盖 pi-ai 尚未接入的全部云厂商协议。

## 验收基线

- `npm run check` 通过。
- 配置引用错误能在加载或保存前给出明确诊断。
- failover、认证和各原生 transport 的关键路径有自动化测试。
- 用户可见行为变化同步更新 README、指南与 CHANGELOG。

具体配置和操作方法见 [`../guides/installation.md`](../guides/installation.md)，实现边界见 [`../architecture/overview.md`](../architecture/overview.md)。
