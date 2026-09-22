# 需求文档

这里定义“做什么”，是实现和验收的主要依据。一个独立功能或需求域使用一份文档。

建议字段：

- 状态：`draft` / `accepted` / `implemented` / `superseded`
- 背景与目标
- 非目标
- 用户场景或行为规则
- 验收标准（可测试）
- 约束、风险与关联 ADR/plan

不要在需求文档中堆实现细节；实现选择放入 architecture、ADR 或 plan。

当前文档：

- [`product-scope.md`](product-scope.md)：已实现的产品范围与核心行为基线。
- [`cost-aware-routing.md`](cost-aware-routing.md)：成本感知自动路由与会话亲和性需求（implemented；宿主级 E2E、账号配额、TUI 原生缓存开关按 ADR 0007 延期）。
