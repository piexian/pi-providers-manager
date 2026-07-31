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

### /agents

- List all subagents
- Edit model / thinkingLevel / tools / description / system prompt body
- Create / delete subagents

## Install

```bash
pi install git:github.com/piexian/pi-providers-manager
```

## Requirements

- pi coding agent (TUI mode)
- Commands are unavailable in non-TUI modes (print/rpc)

## License

MIT
