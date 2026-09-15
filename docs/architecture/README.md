# 架构文档

记录系统当前结构、模块职责、关键数据流和稳定边界。

- 架构文档描述“现在如何工作”，不记录待办清单。
- 发生跨模块调整时同步更新。
- 重要取舍与原因写入 [`../decisions/`](../decisions/)，不要混在架构说明中。

- [`overview.md`](overview.md)：系统定位、主要数据流与模块边界。
- [`pi-native-passthrough.md`](pi-native-passthrough.md)：pi/pi-ai 会话与缓存参数的透传契约及各 transport 实际行为。
- 当前源码领域概览见 [`../../src/README.md`](../../src/README.md)。
