# pi-providers-manager

[English](./README_EN.md) | 中文

pi 编码代理的交互式供应商/模型/子代理管理扩展。

注册两个 TUI 斜杠命令：

- `/providers` — 管理 `~/.pi/agent/models.json` 中的供应商和模型
- `/agents` — 管理 `~/.pi/agent/agents/*.md` 子代理配置

## 功能

### /providers

- 新增/删除供应商（baseUrl、apiKey、API 类型）；anthropic/gemini 的 baseUrl 自动去除结尾版本段（/v1、/v1beta、/v2…）
- 从 `{baseUrl}/models` 接口批量拉取模型列表（按 API 类型选择鉴权头：Bearer / x-api-key / x-goog-api-key）
- 手动添加模型；按 models.dev 元数据自动填充模型参数（name、reasoning、cost、contextWindow 等），上游支持 xhigh/max 思考档时自动写入 thinkingLevelMap 透传声明
- 供应商级编辑：compat（缓存/思考协议兼容开关，布尔三态 + 枚举）、headers、authHeader、name、baseUrl、apiKey（不回显）、API 类型
- modelOverrides：单模型最终覆盖层（compat / headers / reasoning / thinkingLevelMap / contextWindow / maxTokens）
- 模型级编辑：api 类型、compat（完整键集，显示 provider 级已设值）、headers 客户端指纹、thinkingLevelMap、input 模态、contextWindow、maxTokens、baseUrl 覆盖
- 删除模型
- models.json 按 JSONC 读写，手写注释与 BOM 均保留

### /agents

- 列出所有子代理
- 编辑 model / thinkingLevel / tools / description / 系统提示正文
- 新建 / 删除子代理

## 安装

```bash
pi install git:github.com/piexian/pi-providers-manager
```

## 环境要求

- pi coding agent（TUI 模式）
- 非 TUI 模式（print/rpc）下命令会提示不可用

## 许可证

MIT
