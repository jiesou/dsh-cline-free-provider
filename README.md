# dsh-cline-free-provider

Cline Free provider for dsh.

[English](README.en.md)

本插件可以将 Cline 的免费模型，接入 dsh 使用。

<img height="650" alt="截图 2026-08-17 10-39-41" src="https://github.com/user-attachments/assets/849c8ca8-2f97-4603-898a-37598a2dede5" />

Cline 提供 OpenRouter 上可用的各种免费模型，以及 DeepSeek V4 Flash。

如果你使用的是 Cline Pass 订阅计划，可以直接按照 Cline Pass 官方文档配置官方接口和 API Key，不需要本插件。

获取 API Key：<https://app.cline.bot/dashboard/account?tab=api-keys>

## 安装

从 npm 安装（预构建产物，推荐）：

```sh
dsh plugin --profile web add @jiesou/dsh-cline-free-provider
```

或从 GitHub 安装：

```sh
dsh plugin --profile web add github:jiesou/dsh-cline-free-provider
```

## 安装之后

Cline 的 API Key 通过 DSH credentials 服务保存（变量名为 `CLINE_API_KEY`，可在 Web Models 页面填写）。

模型列表**无需任何配置**，插件启动时会自动从远程同步并过滤所有免费模型。在 Web Models 页面选择 Cline provider 和模型后即可开始使用。

### 配置项

全部可选，默认即可用：

```yaml
- id: cline-free-provider
  name: '@jiesou/dsh-cline-free-provider'
  config:
    apiKeyEnv: CLINE_API_KEY
    baseURL: https://api.cline.bot/api/v1
    defaultMaxTokens: 32768
    defaultContextWindow: 262144
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiKeyEnv` | `string` | `"CLINE_API_KEY"` | 读取 API Key 的环境变量名（或 credential ref） |
| `baseURL` | `string` | `"https://api.cline.bot/api/v1"` | Cline 网关 base URL |
| `defaultMaxTokens` | `number` | `32768` | 模型无精确 maxTokens 时的兜底值 |
| `defaultContextWindow` | `number` | `262144` | 模型无精确 contextWindow 时的兜底值 |

## License

[MIT](LICENSE)
