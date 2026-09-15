# 项目文档

文档按“当前事实”和“历史记录”分开，便于人和 AI 快速找到权威上下文。

| 目录 | 用途 | 何时更新 |
|---|---|---|
| [`requirements/`](requirements/) | 产品需求、范围、验收标准 | 新功能开始前、范围变化时 |
| [`architecture/`](architecture/) | 当前架构、模块边界和数据流 | 架构或边界变化时 |
| [`decisions/`](decisions/) | 架构决策记录（ADR） | 重要且长期有效的选择确定时 |
| [`plans/`](plans/) | 未完成工作的实施计划 | 复杂任务实施前与进行中 |
| [`reviews/`](reviews/) | 代码、架构或版本评审快照 | 每次正式评审后 |
| [`development/`](development/) | 开发、测试、发布流程 | 工具链或流程变化时 |
| [`guides/`](guides/) | 安装、配置、故障排查等指南 | 用户操作变化时 |

## 推荐阅读顺序

- 新参与者或 AI：[`../AGENTS.md`](../AGENTS.md) → [`architecture/README.md`](architecture/README.md) → [`development/README.md`](development/README.md)
- 实现功能：对应 requirement → architecture/ADR → plan → tests
- 使用项目：[`../README.md`](../README.md) → [`guides/installation.md`](guides/installation.md)

不要把临时聊天记录放入仓库；只有可复用的结论才进入上述目录。
