# pi-providers-manager

[English](./README_EN.md) | 中文

pi 编码代理的交互式供应商/模型/子代理管理扩展。

注册两个 TUI 斜杠命令：

- `/providers` — 管理 `~/.pi/agent/models.json` 中的供应商和模型
- `/agents` — 管理 `~/.pi/agent/agents/*.md` 子代理配置

## 功能

### /providers

- 新增/删除供应商（baseUrl、apiKey、API 类型）；anthropic/gemini 的 baseUrl 自动去除结尾版本段（/v1、/v1beta、/v2…）
- 按 API 类型拉取模型：OpenAI `/models`、Anthropic `/v1/models`、Gemini `/v1beta/models`；支持原生分页、鉴权插值与转义，不执行 `!command`
- 手动添加模型；按 models.dev 填充参数及扩展思考档，同名模型优先匹配供应商，歧义时选择来源或跳过，不再取第一条
- contextWindow / maxTokens 仅接受正安全整数，拒绝小数，不四舍五入
- 供应商级编辑：compat（缓存/思考协议兼容开关，布尔三态 + 枚举）、headers、authHeader、name、baseUrl、apiKey（不回显）、API 类型
- 供应商级传输：继承 / auto / sse / websocket / websocket-cached，以及 WS 握手、流空闲超时；标准 Responses 可实际走 WS
- API 选择补充 Codex / Azure Responses，并提示 Codex 专用鉴权与路径限制
- modelOverrides：单模型最终覆盖层（compat / headers / reasoning / thinkingLevelMap / contextWindow / maxTokens）
- 模型级编辑：api 类型、compat（完整键集，显示 provider 级已设值）、headers 客户端指纹、thinkingLevelMap、input 模态、contextWindow、maxTokens、baseUrl 覆盖
- 删除模型
- models.json 按 JSONC 读写，手写注释与 BOM 均保留

### /agents

- 列出所有子代理
- 编辑 model / thinkingLevel / tools / description / 系统提示正文
- 多行 YAML 字段整段替换，保留注释、BOM、换行及正文；写回校验和原子保存，错误不落盘
- 新建 / 删除子代理

## 供应商传输

`/providers` → 供应商 → **传输方式 / 超时**，保存后执行 `/reload` 或重启；不会自动切换任何已有供应商。

| 模式 | 标准 `openai-responses` 行为 |
|---|---|
| 继承 | 不接管传输；Pi 0.85.1 的普通 Responses 仍走 SSE |
| `auto` | WS 优先；仅握手失败、尚未发送生成请求时回退 SSE，并提示 |
| `sse` | 原有 HTTP/SSE |
| `websocket` | 严格 WS、全量上下文；不回退 SSE |
| `websocket-cached` | 严格 WS；安全匹配时使用连接内上下文续传 |

配置存于 `~/.pi/agent/provider-transports.json`（支持 `PI_CODING_AGENT_DIR`）；不向 `models.json` 写入无效的 transport 字段，不复制密钥。

```json
{
  "providers": {
    "cpa": {
      "transport": "websocket",
      "websocketConnectTimeoutMs": 15000,
      "httpIdleTimeoutMs": 300000
    }
  }
}
```

超时单位为毫秒，清空则继承 Pi。`httpIdleTimeoutMs` 控制请求/流空闲时间：SSE 同步覆盖 SDK 的 `timeoutMs`；标准 Responses WS 由桥接层管理握手、回退和流计时，避免 SDK 的短截止抢先取消。`0` 关闭本插件计时，SDK 使用其禁用约定值；调用方 `AbortSignal` 或自定义 fetch 的截止仍有效。取消、发送后的断线及流超时不自动转 SSE；CPA 保持 `openai-responses` 和原 HTTPS baseUrl。
例如 60 秒应填 `60000`，不是 `60`；auto 回退警告会显示连接失败原因和超时毫秒值。与 Pi 原解析器一致，忽略 `codex.rate_limits`、`codex.response.metadata` 等非生成元数据，不视为模型输出或协议错误。
回退警告每个 Pi 会话只显示一次（跨供应商），`/reload`、续聊和切分支不重置；新建或 fork 会话可重新提示。去重标记不进入模型上下文，不影响后续请求的回退。

传输覆盖仅接管单一 `openai-responses` / `openai-codex-responses` API，且不得与其他扩展注册冲突。Anthropic、Gemini、Chat Completions、Azure 等保留原生传输与思考参数，旧覆盖仅提示、不生效，可在菜单清空。原生 Codex 保留 Pi 的 WS 实现和 auto 策略，严格 WS 阻止 HTTP 降级；更改 API 或模型列表后需 `/reload`。

WS 网络事件在插件内部转成 SSE 流，继续由 Pi 解析文本、思考、工具调用和用量；响应回调看到的是合成状态，不是原始握手响应头。选择 `sse` 恢复 HTTP 传输；清除该供应商所有传输及超时覆盖后 `/reload`，才完全恢复 Pi 原生链路。
缓存续传仅在输入前缀与上一响应精确匹配时启用，否则仍用 WS 发送完整上下文。逐请求追踪头不影响连接复用；复用期间的握手追踪头保持首个请求值。各供应商独立校验，坏条目不会禁用其他供应商的严格 WS。

验证环境：Pi 0.85.1 / Node 24。开发检查：`npm run check`、`npm test`（假凭据与本地 WS，不调用真实模型）。

## 安装

```bash
pi install git:github.com/piexian/pi-providers-manager@v0.3.1
```

## 环境要求

- pi coding agent（TUI 模式）
- 非 TUI 模式（print/rpc）下命令会提示不可用

## 许可证

MIT
