# ADR 0006：Custom Entry 亲和记录按 Session 生命周期恢复

- 状态：accepted
- 日期：2026-09-16

## 背景

会话亲和需要跨 `/resume` 和分支恢复，但不能让 `/new`、`/fork` 或 `/clone` 继承父会话的线路/账号。pi 的 Custom Entry 会随 Session 分支保存，因此恢复逻辑必须同时校验 Session 身份和记录顺序。

## 决策

1. `AliasProvider.restoreSessionAffinity()` 只接受当前 Session ID 的 SHA-256 哈希匹配项，不接受原始 Session ID，也不接受其他分支/会话的记录。
2. 同一 Session + alias 出现多条记录时，按 branch 顺序让最新有效记录覆盖旧记录。
3. 新 Session ID 不读取旧亲和，即使它们共享父分支中的 Custom Entry；首次请求重新执行 Router 初选。
4. 不创建独立亲和状态文件；跨进程重启的恢复依赖 pi 原生 session branch 被重新提供给扩展。

## 后果

- `/resume` 可以恢复最后一次成功切换后的 binding/账号。
- `/fork`、`/clone` 和 `/new` 保持新会话语义，不会意外复用父会话的缓存亲和或失效账号。
- 真实 pi 进程重启的端到端测试仍需要宿主提供可控的 Session branch；单元和集成测试覆盖匹配、覆盖和隔离规则。
