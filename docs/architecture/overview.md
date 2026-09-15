# 系统架构概览

## 定位

pi-switch 是运行在 pi 进程内的模型路由扩展。它把一个模型别名解析为多个 Provider/账号候选线路，并负责选择、流式转发、故障切换、健康状态和统计；协议序列化及宿主认证能力尽量复用 pi/pi-ai。

## 主要数据流

```text
用户选择 pi-switch/<alias>
  → ConfigStore 读取并校验配置
  → ModelResolver 解析 alias 与 binding
  → AccountManager 展开可用账号
  → Router 按策略与 HealthManager 选择候选线路
  → AliasProvider 调用对应 pi-ai transport
  → StatsManager 记录 request/attempt
  → /switch 与状态栏展示结果
```

## 模块边界

- `config` 只负责配置模型、校验、Secret 解析和持久化。
- `model` 将配置转换为可路由 binding，不执行网络请求。
- `router` 负责顺序和健康判断，不处理 TUI。
- `provider` 负责 Provider 注册、发现和流式协议调用。
- `stats` 负责统计聚合与持久化，不决定路由策略。
- `ui` 只编排交互，通过上述模块完成操作。

详细文件职责见 [`../../src/README.md`](../../src/README.md)。影响这些边界的长期决策应新增 ADR。
