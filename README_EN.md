# pi-providers-manager

English | [中文](./README.md)

Interactive provider/model/subagent manager for [pi](https://pi.dev) coding agent.

Registers two TUI slash commands:

- `/providers` — Manage providers and models in `~/.pi/agent/models.json`
- `/agents` — Manage subagent configs in `~/.pi/agent/agents/*.md`

## Features

### /providers

- Create/delete providers (base URL without the version segment, apiKey, API type); the stored `baseUrl` is derived from the API type
- API-specific model lists: OpenAI `/models`, Anthropic `/v1/models`, Gemini `/v1beta/models`; native pagination, key interpolation/escapes, no `!command` execution
- Manual model addition
- Provider-aware models.dev metadata; ambiguous matches require selecting a source or skipping metadata rather than using the first entry
- Per-model editing: api type, headers (client fingerprint), thinkingLevelMap, reasoning_effort, input modalities, contextWindow, maxTokens; changing a model's api re-derives its endpoint with no manual input, and per-model endpoint pinning lives in the provider menu's advanced override entry. Saving returns to the model list so another model can be edited, esc exits to the provider menu
- Per-provider editing includes the canonical base (with the derived endpoint shown beside it), an advanced verbatim endpoint entry, and an advanced per-model endpoint entry
- contextWindow / maxTokens accept positive safe integers only; fractions are rejected, never rounded
- Remove models: loops until esc instead of leaving after one deletion
- Per-provider transport and handshake/stream-idle timeouts, with actual WebSocket support for standard Responses
- Codex and Azure Responses API choices with Codex-specific authentication/path warnings

### /agents

- List all subagents
- Edit model / thinkingLevel / tools / description / system prompt body
- Complete multiline YAML value replacement with comments, BOM, newlines and prompt preserved; validate before atomic writes
- Create / delete subagents

## Base URL and endpoint

Pi hands `model.baseUrl` to each SDK as `baseURL` without normalising it, and the SDKs disagree about where the version segment belongs: the OpenAI SDK requests `/chat/completions` and `/responses` (so the base must carry the segment), while the Anthropic SDK requests `/v1/messages` and the Google SDK `/v1beta/...` (so the base must not). The plugin therefore keeps one canonical base per provider and derives the stored endpoint from the API type:

| API type | Stored `baseUrl` | Requested path |
|---|---|---|
| `openai-completions` / `openai-responses` / `openai-codex-responses` | `http://host:3000/v1` | `/v1/chat/completions`, `/v1/responses` |
| `anthropic-messages` | `http://host:3000` | `/v1/messages` |
| `google-generative-ai` | `http://host:3000` | `/v1beta/...` |
| `mistral-conversations` | `http://host:3000` | versioned path inside the SDK |

A base keeps host and path prefix only; the trailing version segment is optional, and prefixes such as `/compatible-mode` or `/openai` are never swallowed. An endpoint already carrying a custom segment like `/v4` is kept as-is instead of being rewritten to `/v1`. Switching API type re-derives the provider endpoint plus every model that pins its own, so changing protocol never requires retyping an address. Gateways with an unusual shape go through the advanced endpoint entry, which stores the value verbatim.

## Provider transport

Open `/providers` → provider → **传输方式 / 超时**; save and `/reload` or restart. Existing providers are unchanged until explicitly configured.

| Mode | Standard `openai-responses` behavior |
|---|---|
| Inherit | No transport override; Pi still uses SSE for standard Responses |
| `auto` | Try WS; fall back to SSE with a notice if the handshake fails, or if a sent request produced no frame at all on that connection |
| `sse` | Original HTTP/SSE path |
| `websocket` | Strict WS with full context; replays once on a fresh connection while no frame arrived, never falls back to SSE |
| `websocket-cached` | Strict WS with safe connection-scoped context continuation; replays once while no frame arrived, never falls back to SSE |

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

Timeouts are integer milliseconds; clearing inherits Pi. `httpIdleTimeoutMs` also overrides the SDK `timeoutMs` for SSE. Standard Responses WS uses bridge-owned handshake, fallback and stream timers so a shorter SDK deadline cannot race them; in that mode the value is the stream-idle gap and the pooled-socket expiry, and it does not bound the SDK request timeout (the bridge sets that to unlimited). `0` disables plugin timers using the SDK-compatible disabled value; caller AbortSignals and custom-fetch deadlines still apply. A request that was sent but produced no frame at all is replayed once on a fresh connection; if that also stays silent, `auto` switches to SSE while strict WS reports the failure. Disconnects after the first frame, cancellation and stream-idle timeouts are never replayed or downgraded. A silent socket is killed by the link after about 129 s, so the `ws` transport keeps pooled sockets alive with pings and a transport without ping support pools for at most 110 s. Keep CPA on `openai-responses` and its original HTTPS base URL.
For 60 seconds enter `60000`, not `60`; auto fallback notices include the connection failure reason and timeout in milliseconds. Like Pi's parser, non-generation metadata such as `codex.rate_limits` and `codex.response.metadata` is ignored rather than treated as model output or protocol errors.
One session entry is recorded for the first fallback and the first replay, carrying the provider, transport mode and the connection facts (close code, frames, socket age). The UI warning still appears once per Pi session across providers, surviving reload/resume and branch navigation; new or forked sessions may warn again. These entries stay out of model context and do not change fallback behavior for later requests.

Transport overrides only apply to a single `openai-responses` or `openai-codex-responses` API without conflicting extension registration. Anthropic, Gemini, Chat Completions, Azure and other APIs retain native streaming/thinking semantics; old overrides are reported but not applied and can be cleared in the menu. Native Codex keeps Pi's WS and auto behavior; strict WS blocks HTTP downgrade. Reload after API/catalog changes.

WS events become an internal SSE stream for Pi's text, thinking, tool-call and usage parser; response callbacks see a synthetic status, not WS handshake headers. Select `sse` to restore HTTP transport. Clear all provider transport and timeout overrides, then `/reload`, to fully restore Pi's native path.
Cached continuation requires an exact input/output prefix match; mismatches send full context over WS. Per-request tracing headers do not prevent reuse, so handshake trace headers retain their first-request values. Invalid provider entries are isolated and cannot disable another provider's strict WS setting.

Verified target: Pi 1.4.0 / Node 26; the `ws` transport depends on the `ws` package. Development checks: `npm run check`, `npm test` (dummy credentials and local WS; no real model calls).

## Install

```bash
pi install git:github.com/piexian/pi-providers-manager@v0.3.1
```

## Requirements

- pi coding agent (TUI mode)
- Commands are unavailable in non-TUI modes (print/rpc)

## License

MIT
