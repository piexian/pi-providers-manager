# pi-providers-manager

English | [中文](./README.md)

Interactive provider/model/subagent manager for [pi](https://pi.dev) coding agent.

Registers two TUI slash commands:

- `/providers` — Manage providers and models in `~/.pi/agent/models.json`
- `/agents` — Manage subagent configs in `~/.pi/agent/agents/*.md`

## Features

### /providers

- Create/delete providers (baseUrl, apiKey, API type)
- API-specific model lists: OpenAI `/models`, Anthropic `/v1/models`, Gemini `/v1beta/models`; native pagination, key interpolation/escapes, no `!command` execution
- Manual model addition
- Provider-aware models.dev metadata; ambiguous matches require selecting a source or skipping metadata rather than using the first entry
- Per-model editing: api type, headers (client fingerprint), thinkingLevelMap, reasoning_effort, input modalities, contextWindow, maxTokens, baseUrl override
- contextWindow / maxTokens accept positive safe integers only; fractions are rejected, never rounded
- Remove models
- Per-provider transport and handshake/stream-idle timeouts, with actual WebSocket support for standard Responses
- Codex and Azure Responses API choices with Codex-specific authentication/path warnings

### /agents

- List all subagents
- Edit model / thinkingLevel / tools / description / system prompt body
- Complete multiline YAML value replacement with comments, BOM, newlines and prompt preserved; validate before atomic writes
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

Timeouts are integer milliseconds; clearing inherits Pi. `httpIdleTimeoutMs` also overrides the SDK `timeoutMs` for SSE. Standard Responses WS uses bridge-owned handshake, fallback and stream timers so a shorter SDK deadline cannot race them. `0` disables plugin timers using the SDK-compatible disabled value; caller AbortSignals and custom-fetch deadlines still apply. Cancellation, post-send disconnects and stream-idle timeouts never trigger SSE replay. Keep CPA on `openai-responses` and its original HTTPS base URL.
For 60 seconds enter `60000`, not `60`; auto fallback notices include the connection failure reason and timeout in milliseconds. Like Pi's parser, non-generation metadata such as `codex.rate_limits` and `codex.response.metadata` is ignored rather than treated as model output or protocol errors.
Fallback warnings appear once per Pi session across providers, surviving reload/resume and branch navigation; new or forked sessions may warn again. The marker stays out of model context and does not change fallback behavior for later requests.

Transport overrides only apply to a single `openai-responses` or `openai-codex-responses` API without conflicting extension registration. Anthropic, Gemini, Chat Completions, Azure and other APIs retain native streaming/thinking semantics; old overrides are reported but not applied and can be cleared in the menu. Native Codex keeps Pi's WS and auto behavior; strict WS blocks HTTP downgrade. Reload after API/catalog changes.

WS events become an internal SSE stream for Pi's text, thinking, tool-call and usage parser; response callbacks see a synthetic status, not WS handshake headers. Select `sse` to restore HTTP transport. Clear all provider transport and timeout overrides, then `/reload`, to fully restore Pi's native path.
Cached continuation requires an exact input/output prefix match; mismatches send full context over WS. Per-request tracing headers do not prevent reuse, so handshake trace headers retain their first-request values. Invalid provider entries are isolated and cannot disable another provider's strict WS setting.

Verified target: Pi 0.85.1 / Node 24. Development checks: `npm run check`, `npm test` (dummy credentials and local WS; no real model calls).

## Install

```bash
pi install git:github.com/piexian/pi-providers-manager@v0.3.1
```

## Requirements

- pi coding agent (TUI mode)
- Commands are unavailable in non-TUI modes (print/rpc)

## License

MIT
