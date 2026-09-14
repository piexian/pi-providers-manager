# pi-providers-manager

English | [中文](./README.md)

Interactive provider/model/subagent manager for [pi](https://pi.dev) coding agent.

Registers two TUI slash commands:

- `/providers` — Manage providers and models in `~/.pi/agent/models.json`
- `/agents` — Manage subagent configs in `~/.pi/agent/agents/*.md`

## Features

### /providers

- Create/delete providers (baseUrl, apiKey, API type)
- Batch-fetch model list from `{baseUrl}/models` endpoint
- Manual model addition
- Auto-fill model params from models.dev metadata (name, reasoning, cost, contextWindow, etc.)
- Per-model editing: api type, headers (client fingerprint), thinkingLevelMap, reasoning_effort, input modalities, contextWindow, maxTokens, baseUrl override
- Remove models
- Per-provider transport and handshake/stream-idle timeouts, with actual WebSocket support for standard Responses
- Codex and Azure Responses API choices with Codex-specific authentication/path warnings

### /agents

- List all subagents
- Edit model / thinkingLevel / tools / description / system prompt body
- Create / delete subagents

## Provider transport

Open `/providers` → provider → **传输方式 / 超时**; save and `/reload` or restart. Existing providers are unchanged until explicitly configured.

| Mode | Standard `openai-responses` behavior |
|---|---|
| Inherit | No transport override; Pi 0.85.1 still uses SSE for standard Responses |
| `auto` | Try WS; fall back to SSE with a notice only if the handshake fails before sending the generation request |
| `sse` | Original HTTP/SSE path |
| `websocket` | Strict WS with full context; never fall back to SSE |
| `websocket-cached` | Strict WS with safe connection-scoped context continuation |

Settings are stored in `~/.pi/agent/provider-transports.json`, respecting `PI_CODING_AGENT_DIR`. The plugin does not add ignored transport keys to `models.json` or duplicate credentials.

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

Timeouts are integer milliseconds; `0` disables them and clearing a value inherits Pi. Cancellation, post-send disconnects, and stream-idle timeouts do not trigger automatic SSE replay. Keep CPA on `openai-responses` with its original HTTPS base URL; no fabricated Codex JWT is needed.
For 60 seconds enter `60000`, not `60`; auto fallback notices include the connection failure reason and timeout in milliseconds. Like Pi's parser, non-generation metadata such as `codex.rate_limits` and `codex.response.metadata` is ignored rather than treated as model output or protocol errors.
Fallback warnings appear once per Pi session across providers, surviving reload/resume and branch navigation; new or forked sessions may warn again. The marker stays out of model context and does not change fallback behavior for later requests.

Transport overrides require a single API per provider and no conflicting provider registration from another extension. Conflicts are reported without replacing the existing registration. Native Codex keeps Pi's WS implementation and auto fallback policy; strict WS blocks HTTP downgrade. Reload after changing API types or the model catalog.

WS events are adapted internally to an SSE stream for Pi's text, thinking, tool-call and usage parser. Response callbacks see a synthetic status, not the original WS handshake headers. To roll back, select `sse` or clear the override and `/reload`.
Cached continuation requires an exact input/output prefix match; mismatches send full context over WS. Per-request tracing headers do not prevent reuse, so handshake trace headers retain their first-request values. Invalid provider entries are isolated and cannot disable another provider's strict WS setting.

Verified target: Pi 0.85.1 / Node 24. Development checks: `npm run check`, `npm test` (dummy credentials and local WS; no real model calls).

## Install

```bash
pi install git:github.com/piexian/pi-providers-manager@v0.3.0
```

## Requirements

- pi coding agent (TUI mode)
- Commands are unavailable in non-TUI modes (print/rpc)

## License

MIT
