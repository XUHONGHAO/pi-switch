# 思考支持功能更新总结

## 修改内容

### 1. 代码修改

**文件：`src/ui/config.ts`**

- 添加了 `ModelProviderBinding` 类型导入
- 在新增模型别名向导中添加了"思考支持"选项
- 在编辑模型别名界面中添加了"思考支持（reasoning）"配置项
- 在编辑线路界面中添加了"思考级别映射"配置项
- 新增 `editThinkingLevelMap()` 函数，提供标准思考级别映射的快速配置

**主要新增功能：**

1. **新增模型时**：可以选择是否支持思考功能
2. **编辑模型时**：可以开启/关闭思考支持
3. **编辑线路时**：可以配置思考级别映射
   - 使用标准映射（推荐）- 自动应用 off→null, low→low, medium→medium, high→high, xhigh→high, max→high
   - 清除映射
   - 取消操作

### 2. 文档更新

**新增文件：`docs/guides/thinking-support.md`**
- 完整的思考支持配置指南
- TUI 配置方法和手动编辑方法
- 不同 API 的映射示例
- 使用说明和故障排查

**更新文件：`README.md`**
- 在功能特性中添加"思考深度支持"说明
- 在配置管理部分添加思考深度配置的快速指南

### 3. 配置文件修改

**文件：`~/.pi-switch/models.json`**

为以下模型添加了思考支持：
- `claude-opus-4-8`
- `gpt-5.6-sol`
- `claude-opus-5-thinking`
- `claude-fable-5`

每个模型都配置了：
- `reasoning: true` - 标记模型支持思考
- `thinkingLevelMap` - 标准思考级别映射

## 使用方法

### 通过 TUI 配置新模型

1. 在 pi 中执行 `/config models`
2. 选择"新增别名"或选择已有别名进行编辑
3. 将"思考支持（reasoning）"设置为"是"
4. 选择线路，然后选择"思考级别映射"
5. 选择"使用标准映射（推荐）"
6. 保存并重载

### 使用思考功能

配置完成后：
- 按 `Shift+Tab` 打开思考级别选择器
- 或使用命令：`/thinking off|low|medium|high`
- 查看状态：`/switch status`

## 技术细节

### thinkingLevelMap 配置

```json
{
  "off": null,        // 不使用思考
  "low": "low",       // 低级别思考
  "medium": "medium", // 中级别思考
  "high": "high",     // 高级别思考
  "xhigh": "high",    // 超高级别（映射到 high）
  "max": "high"       // 最大级别（映射到 high）
}
```

### 配置位置

可以在两个层级配置 `thinkingLevelMap`：

1. **Provider 层**（`providers.json` 的 `models` 数组）
   - 适合该 Provider 的所有模型使用相同映射

2. **Binding 层**（`models.json` 的 `providers` 数组）
   - 适合特定线路使用不同映射
   - 会覆盖 Provider 层的配置

## 测试结果

✅ 类型检查通过 (`npm run typecheck`)
✅ 所有测试通过 (`npm test`) - 44个测试全部通过
✅ 完整检查通过 (`npm run check`)

## 验证步骤

1. 编辑配置文件后执行 `/config reload`
2. 选择支持思考的模型
3. 按 `Shift+Tab` 应该能看到思考级别选择器
4. 切换思考级别后，参数会根据 `thinkingLevelMap` 传递给上游 API

## 注意事项

1. 不同的 API Provider 可能使用不同的思考参数值，需要根据实际情况调整映射
2. 如果 API 不支持某个思考级别，应该将其映射为 `null`
3. 配置 `reasoning: true` 是启用思考功能的前提
4. 每次修改配置后都需要执行 `/config reload` 使配置生效

## 相关文件

- 代码实现：`src/ui/config.ts`
- 类型定义：`src/config/loader.ts`
- 使用文档：`docs/guides/thinking-support.md`
- 主文档：`README.md`
- 示例配置：`examples/models.json`, `examples/providers.json`
