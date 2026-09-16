# ADR 0003：保留 binding/账号层级并粘住成功切换的账号

- 状态：accepted
- 日期：2026-09-15

## 背景

账号池此前按 Provider 展开为扁平候选。这样虽然能在 401/429 后找到同 Provider 的其他 Key，但无法表达某条 binding 只允许使用部分账号；成功切换账号后，原有亲和状态只记录 lineId，后续请求可能再次选回失败账号。

## 决策

1. `models.json` 的 binding 增加可选 `accounts` 数组。省略时保持兼容，使用该 Provider 的全部启用账号；指定后只展开列出的账号，并在配置校验阶段确认账号存在且属于同一 Provider。
2. 候选顺序先按 binding 优先级和声明顺序分组，再按账号优先级排序，避免不同 binding 的账号优先级互相穿插。
3. 会话亲和状态在 lineId 之外可记录账号名。旧的仅 lineId Custom Entry 仍可恢复，并在账号不可用时回退到该 binding 的可用账号。
4. 401/429 的结构化故障决策继续使用 `switch-account`，仅在当前 binding 没有后续账号时才允许进入跨线路候选。
5. AliasProvider 在传给 pi-ai 的 `fetch` 外包一层状态采集，以保留非 2xx 响应的 HTTP 状态和 `Retry-After`；403 的同 binding 账号恢复仍显示 `unknown` 成本风险，避免伪装成已知低成本。

## 后果

- 同一 binding 内的账号切换不会立即破坏线路级缓存亲和，且成功切换后不会反复尝试已失效账号。
- 账号名属于本地配置标识，Custom Entry 仍只写 Session ID 哈希，不写原始 Session ID 或 Secret。
- 账号配额和显式 `cacheDomain` 不在本批实现范围内；403 的基础账号/未知风险分流已在阶段 D 第二批完成。
