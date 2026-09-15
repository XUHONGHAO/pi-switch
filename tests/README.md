# 测试

使用 Vitest，测试文件后缀为 `.test.ts`。

- 单元测试覆盖纯逻辑、配置校验和边界条件。
- 集成测试覆盖真实协议、流式事件、认证与 failover 链路。
- 协议级透传测试固定 pi/pi-ai 契约：`alias-native-passthrough` 断言 pi-ai 生成的缓存与亲和字段，`pi-host-passthrough` 通过真实 `ModelRuntime` 与 `AgentSession` 验证宿主仍会下发 `sessionId` / `cacheRetention`。契约说明见 [`../docs/architecture/pi-native-passthrough.md`](../docs/architecture/pi-native-passthrough.md)。
- 需要真实 pi 运行时的测试必须使用临时 `authPath` / `agentDir` / `cwd`，不得读取开发者的 `~/.pi` 状态。
- `mock-openai-server.mjs` 用于手工端到端调试。
- 缺陷修复必须加入能在修复前失败的回归测试。

运行：

```bash
npm test
npm run check
```
