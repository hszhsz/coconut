# 🥥 Coconut

A minimal coding agent CLI with a TUI interface — like Claude Code, but tiny.

Built with TypeScript, Bun, [Ink](https://github.com/vadimdemedes/ink), and the official Anthropic SDK.

## Features

- 🖥️  Terminal UI with chat-style messaging
- 🔧 Tool use: read/write/edit files, list directories, run shell commands
- 🔄 Multi-turn agentic loop — Claude can call tools repeatedly until done
- ⚡ Bun-powered, single-file build

## Setup

Requires [Bun](https://bun.sh/) 1.0+.

```bash
bun install
export ANTHROPIC_API_KEY=sk-ant-...
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

| Env var              | Default              | Description                  |
| -------------------- | -------------------- | ---------------------------- |
| `ANTHROPIC_API_KEY`  | (required)           | Your Anthropic API key       |
| `COCONUT_MODEL`      | `claude-sonnet-4-6`  | Model to use                 |

## Commands

| Command   | Action                |
| --------- | --------------------- |
| `/help`   | Show available commands |
| `/clear`  | Reset conversation history |
| `/exit`   | Quit                  |
| `Ctrl+C`  | Quit                  |

## Tools available to the agent

- `read_file` — read a file
- `write_file` — create/overwrite a file
- `edit_file` — string-replace in a file
- `list_files` — list directory contents
- `bash` — run a shell command (30s timeout)

## Architecture

```
src/
├── index.tsx           # Entry point — checks env, renders App
├── components/
│   ├── App.tsx         # Main TUI: input box + message list
│   └── Message.tsx     # Renders one message (user/assistant/tool/error)
├── lib/
│   ├── agent.ts        # Anthropic SDK + agentic tool loop
│   └── types.ts        # Shared types
└── tools/
    └── index.ts        # Tool definitions and executors
```

The agent loop in `lib/agent.ts`:
1. Send conversation to Claude
2. If response has `tool_use` blocks → execute each tool, append results, loop
3. If `stop_reason === "end_turn"` → done
