# 思考模式配置指南

pi-switch 支持为模型配置思考深度（Thinking/Reasoning）参数映射，让你可以在 pi 中使用 `Shift+Tab` 快捷键或 `/thinking` 命令切换思考级别。

## 快速开始

### 1. 通过 TUI 配置（推荐）

在 pi 中执行：

```bash
/config models
```

选择要配置的模型别名，然后：

1. 选择"思考支持（reasoning）" 选项，设置为"是"
2. 选择要配置的线路（如 `1. ZZ OneAPI/claude-fable-5`）
3. 选择"思考级别映射"
4. 选择"使用标准映射（推荐）"

这会自动应用以下映射：

```json
{
  "off": null,
  "low": "low",
  "medium": "medium",
  "high": "high",
  "xhigh": "high",
  "max": "high"
}
```

### 2. 手动编辑配置文件

编辑 `~/.pi-switch/models.json`：

```json
{
  "claude-fable-5": {
    "displayName": "Claude Fable 5",
    "reasoning": true,
    "providers": [
      {
        "provider": "ZZ OneAPI",
        "model": "claude-fable-5",
        "thinkingLevelMap": {
          "off": null,
          "low": "low",
          "medium": "medium",
          "high": "high",
          "xhigh": "high",
          "max": "high"
        }
      }
    ],
    "strategy": "priority",
    "contextWindow": 1000000
  }
}
```

保存后执行 `/config reload` 重新加载配置。

## 配置说明

### reasoning 字段

在模型别名配置中设置 `"reasoning": true` 表示该模型支持思考功能。

### thinkingLevelMap 字段

`thinkingLevelMap` 将 pi 的思考级别映射到上游 API 的实际参数值：

| pi 级别 | 说明 | 推荐映射 |
|---------|------|----------|
| `off` | 不使用思考 | `null` |
| `low` | 低级别思考 | `"low"` |
| `medium` | 中级别思考 | `"medium"` |
| `high` | 高级别思考 | `"high"` |
| `xhigh` | 超高级别思考 | `"high"` (如果 API 不支持更高级别) |
| `max` | 最大级别思考 | `"high"` (如果 API 不支持更高级别) |

- 设置为 `null` 表示该级别不被支持
- 其他值会作为字符串传递给上游 API

### 配置位置

`thinkingLevelMap` 可以配置在两个地方：

1. **Provider 层** (`providers.json` 中的 `models` 数组)：适合该 Provider 的所有模型使用相同映射
2. **Binding 层** (`models.json` 中的 `providers` 数组)：适合特定线路使用不同映射

Binding 层配置会覆盖 Provider 层配置。

## 使用思考功能

配置完成后，在 pi 中可以：

### 快捷键切换

按 `Shift+Tab` 打开思考级别选择器，选择想要的级别。

### 命令行切换

```bash
/thinking off      # 关闭思考
/thinking low      # 低级别
/thinking medium   # 中级别
/thinking high     # 高级别
```

### 查看当前状态

```bash
/switch status
```

会显示当前使用的模型和思考级别。

## 不同 API 的映射示例

### OpenAI 兼容 API

大多数 OpenAI 兼容的 API 支持 `low`、`medium`、`high`：

```json
{
  "off": null,
  "low": "low",
  "medium": "medium",
  "high": "high",
  "xhigh": "high",
  "max": "high"
}
```

### Anthropic Messages API

Anthropic 使用相同的级别名称：

```json
{
  "off": null,
  "low": "low",
  "medium": "medium",
  "high": "high",
  "xhigh": null,
  "max": null
}
```

### 自定义 API

如果你的 API 使用不同的参数值，可以自定义映射。例如，如果 API 使用 `"extended"` 表示高级思考：

```json
{
  "off": null,
  "low": "basic",
  "medium": "standard",
  "high": "extended",
  "xhigh": "extended",
  "max": "extended"
}
```

## 故障排查

### 提示 "Current model does not support thinking"

1. 检查模型配置中是否设置了 `"reasoning": true`
2. 检查线路配置中是否有 `thinkingLevelMap`
3. 执行 `/config reload` 重新加载配置
4. 使用 `/switch status` 查看当前模型是否正确

### 思考参数没有传递给 API

1. 检查 `thinkingLevelMap` 中当前级别的映射值不是 `null`
2. 查看 API 的文档，确认参数名称和值是否正确
3. 有些 API 可能使用不同的参数名（如 `reasoning_effort` 而不是 `thinking`），需要在 `compat` 字段中配置

### 快速批量配置多个模型

如果有多个思考模型需要配置，可以直接编辑 `~/.pi-switch/models.json`，在每个需要思考支持的模型中添加：

```json
{
  "reasoning": true,
  "providers": [
    {
      "provider": "your-provider",
      "model": "model-id",
      "thinkingLevelMap": {
        "off": null,
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "high",
        "max": "high"
      }
    }
  ]
}
```

然后执行 `/config reload`。

## 更多信息

- 思考功能由 pi-ai 0.84.x 原生支持
- pi-switch 只负责将 pi 的思考级别映射到上游 API 的参数
- 不同 Provider 和模型支持的思考级别可能不同，请参考具体 API 文档
