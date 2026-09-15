# AI 开发指南

本文件是 AI 与贡献者进入仓库后的首要上下文。

## 开始任务前

1. 阅读根目录 `README.md` 与 `docs/README.md`。
2. 涉及行为变更时，先查 `docs/requirements/`、`docs/architecture/` 和 `docs/decisions/`。
3. 实现应保持 `src/` 现有领域边界；不要为了目录美观做无需求的大重构。
4. 完成后运行 `npm run check`；涉及打包时再运行 `npm pack --dry-run`。

## 目录职责

- `src/`：可发布的扩展源码。
- `tests/`：单元与集成测试，路径尽量映射源码领域。
- `examples/`：可提交的脱敏配置示例。
- `docs/requirements/`：需求、范围、验收标准（定义“做什么”）。
- `docs/architecture/`：系统结构、模块边界、数据流（定义“如何组织”）。
- `docs/decisions/`：重要且长期有效的架构决策记录（ADR）。
- `docs/plans/`：尚未完成的实施计划；完成后归档或删除。
- `docs/reviews/`：带日期的评审快照，不作为当前事实的唯一来源。
- `docs/development/`：开发流程、测试和发布说明。
- `docs/guides/`：面向用户或开发者的操作指南。
- `scripts/`：可重复执行的维护与开发脚本。

## 文档规则

- 当前事实只维护在一个权威位置，其他文档使用链接，避免复制。
- 新功能先写需求（目标、非目标、验收标准），复杂改动再写 plan。
- 跨模块或难以撤销的选择新增 ADR；文件名使用 `NNNN-short-title.md`。
- Review 文件名使用 `YYYY-MM-DD-topic.md`，并明确评审对象与版本。
- 文档引用一律使用仓库相对路径；不得写入 API Key、令牌或个人路径。
- 需求状态使用：`draft`、`accepted`、`implemented`、`superseded`。

## 代码与测试规则

- TypeScript ESM；遵循现有风格，不引入无必要依赖。
- 修复缺陷必须补回归测试；新增行为必须有可验证的验收标准。
- 不提交 `node_modules/`、覆盖率、构建产物、本地 `.pi*` 配置或真实 Secret。
- 修改用户可见行为时同步更新 `README.md`、相关 guide 和 `CHANGELOG.md`。
