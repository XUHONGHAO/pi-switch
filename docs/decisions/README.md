# 架构决策记录（ADR）

用于记录影响长期维护、跨模块边界或难以撤销的技术决策。

文件命名：`NNNN-short-title.md`，例如 `0001-use-pi-native-transports.md`。

当前 ADR：

- [`0001-repository-documentation-structure.md`](0001-repository-documentation-structure.md)
- [`0002-structured-failure-decision-and-attempt-budget.md`](0002-structured-failure-decision-and-attempt-budget.md)
- [`0003-binding-account-scope-and-affinity.md`](0003-binding-account-scope-and-affinity.md)
- [`0004-persist-latest-routing-diagnostics.md`](0004-persist-latest-routing-diagnostics.md)
- [`0005-phase-aware-timeout-risk.md`](0005-phase-aware-timeout-risk.md)
- [`0006-custom-entry-session-affinity-lifecycle.md`](0006-custom-entry-session-affinity-lifecycle.md)
- [`0007-deferred-cache-domain-and-host-e2e.md`](0007-deferred-cache-domain-and-host-e2e.md)
- [`0008-runtime-hardening-and-config-reload.md`](0008-runtime-hardening-and-config-reload.md)
- [`0009-cache-domain-declaration-and-ordering.md`](0009-cache-domain-declaration-and-ordering.md)
- [`0010-host-level-extension-e2e-harness.md`](0010-host-level-extension-e2e-harness.md)

每份 ADR 保持简短，至少包含：状态、背景、决策、后果。状态可用 `proposed`、`accepted`、`superseded`。被替代时保留旧 ADR，并链接到新 ADR。
