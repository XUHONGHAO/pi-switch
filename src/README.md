# 源码结构

`src/index.ts` 是 pi package 声明的扩展入口。其余目录按领域划分：

- `account/`：多账号与 Key 池。
- `config/`：配置加载、校验、Secret 与持久化。
- `errors/`：上游错误分类。
- `model/`：模型别名解析。
- `preset/`：pi preset 集成。
- `provider/`：Provider 注册、发现、协议传输与别名转发。
- `router/`：路由选择和线路健康。
- `stats/`：请求及 attempt 统计。
- `ui/`：`/config`、`/switch` 等交互界面。
- `utils/`：无领域归属的通用基础设施。

新增代码优先放入已有领域；只有形成清晰、稳定的新职责时才新增顶层目录。跨领域依赖应通过明确接口完成，避免 UI 逻辑进入核心路由。
