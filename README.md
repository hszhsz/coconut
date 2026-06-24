# 🥥 Coconut

A minimal coding agent CLI with a TUI interface — like Claude Code, but tiny.

Built with TypeScript, Bun, [Ink](https://github.com/vadimdemedes/ink), and any OpenAI-compatible LLM API. **Defaults to DeepSeek V4 Pro.**

## Features

- 🖥️  Terminal UI with chat-style messaging
- 🔧 Tool use: read/write/edit files, list directories, run shell commands
- 🔄 Multi-turn agentic loop — the model can call tools repeatedly until done
- 🔌 OpenAI-compatible — works with DeepSeek, Qwen, Moonshot, OpenAI, vLLM, Ollama, etc.
- ⚡ Bun-powered, single-file build

## Setup

Requires [Bun](https://bun.sh/) 1.0+.

```bash
bun install
export DEEPSEEK_API_KEY=sk-...
```

## Run

```bash
# Dev (with hot reload)
bun run dev

# Run directly
bun run start

# Build a standalone bundle
bun run build
./dist/coconut.js
```

## Configuration

By default, Coconut uses **`deepseek-v4-pro`** via the DeepSeek API. Override any of the following:

| Env var               | Default                          | Description                              |
| --------------------- | -------------------------------- | ---------------------------------------- |
| `DEEPSEEK_API_KEY`    | (required)                       | API key for the LLM provider             |
| `COCONUT_API_KEY`     | falls back to `DEEPSEEK_API_KEY` | Alternative env name                     |
| `COCONUT_MODEL`       | `deepseek-v4-pro`                | Model name                               |
| `COCONUT_BASE_URL`    | `https://api.deepseek.com/v1`    | OpenAI-compatible chat completions URL   |

### Use a different provider

Any OpenAI-compatible endpoint works:

```bash
# OpenAI
export COCONUT_API_KEY=sk-...
export COCONUT_BASE_URL=https://api.openai.com/v1
export COCONUT_MODEL=gpt-4o

# Moonshot / Kimi
export COCONUT_API_KEY=sk-...
export COCONUT_BASE_URL=https://api.moonshot.cn/v1
export COCONUT_MODEL=moonshot-v1-32k

# Local Ollama
export COCONUT_API_KEY=ollama
export COCONUT_BASE_URL=http://localhost:11434/v1
export COCONUT_MODEL=qwen2.5-coder
```

## Commands

| Command   | Action                       |
| --------- | ---------------------------- |
| `/help`   | Show available commands      |
| `/clear`  | Reset conversation history   |
| `/exit`   | Quit                         |
| `Ctrl+C`  | Quit                         |

## Tools available to the agent

- `read_file` — read a file
- `write_file` — create/overwrite a file
- `edit_file` — string-replace in a file
- `list_files` — list directory contents
- `bash` — run a shell command (30s timeout)

## Architecture

```
src/
├── index.tsx           # Entry point — resolves env, renders App
├── components/
│   ├── App.tsx         # Main TUI: input box + message list
│   └── Message.tsx     # Renders one message (user/assistant/tool/error)
├── lib/
│   ├── agent.ts        # OpenAI-compatible chat completions + tool loop
│   └── types.ts        # Shared types
└── tools/
    └── index.ts        # Tool definitions and executors
```

The agent loop in `lib/agent.ts`:
1. POST conversation + tool schemas to `/chat/completions`
2. If the response includes `tool_calls` → execute each tool, append results as `role: "tool"` messages, loop
3. Otherwise → done with this turn
