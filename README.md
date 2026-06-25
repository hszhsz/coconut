# 🥥 Coconut

A minimal coding agent CLI with a TUI interface — like Claude Code, but tiny.

Built with TypeScript, Bun, [Ink](https://github.com/vadimdemedes/ink), and any OpenAI-compatible LLM API. **Defaults to DeepSeek V4 Pro.**

## Features

- 🖥️  Terminal UI with chat-style messaging
- 🔧 Tool use: read/write/edit files, list directories, run shell commands
- 🔄 Multi-turn agentic loop — the model can call tools repeatedly until done
- 🧪 Sandboxing — run all tool operations in a Docker container or workspace-scoped local mode
- 📝 Config file — persist your model, sandbox, temperature, and persona in `~/.config/coconut/config.json` or `.coconut.json`
- 🗜️ Context compression — layered pipeline with tool-output externalization, old-result clearing, LLM summarization, and run-level token budget warnings when conversations approach the context window
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

Coconut loads configuration in this order (later wins):

1. **Built-in defaults**
2. **`~/.config/coconut/config.json`** (or `$XDG_CONFIG_HOME/coconut/config.json`) — your user-global defaults
3. **`./.coconut.json`** in the workspace — per-project overrides
4. **`$COCONUT_CONFIG`** — explicit file path
5. **Environment variables** — always win, so secrets can stay in env

Bootstrap a config from the included template:

```bash
mkdir -p ~/.config/coconut
cp coconut.config.example.json ~/.config/coconut/config.json
$EDITOR ~/.config/coconut/config.json
```

Full schema (every field optional; unknown keys are rejected):

```jsonc
{
  "model": "deepseek-v4-pro",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",         // prefer env var DEEPSEEK_API_KEY for secrets
  "system": "You are an expert Go programmer. Prefer table-driven tests.",
  "maxTokens": 4096,
  "temperature": 0.3,
  "maxIterations": 15,
  "sandbox": {
    "kind": "local",          // or "docker"
    "workspace": null,        // null = current working directory
    "image": "node:22-slim",
    "network": "bridge"       // or "none"
  }
}
```

The `system` field is *appended* to Coconut's built-in system prompt — use it for a persona or project-specific rules ("always write JSDoc", "use Python 3.13 syntax", etc.). Run `/config` inside the TUI to see exactly which values were loaded and from where (API key is redacted in the output).

> ⚠️ A `.coconut.json` containing `apiKey` will be readable by anyone with access to the project. Keep keys in env vars when possible; `.coconut.json` is gitignored by default.

### Environment variables

Env vars override anything from config files:

| Env var               | Default                          | Description                              |
| --------------------- | -------------------------------- | ---------------------------------------- |
| `DEEPSEEK_API_KEY`    | (required if not in config)      | API key for the LLM provider             |
| `COCONUT_API_KEY`     | falls back to `DEEPSEEK_API_KEY` | Alternative env name                     |
| `COCONUT_CONFIG`      | (unset)                          | Path to an explicit config file          |
| `COCONUT_MODEL`       | `deepseek-v4-pro`                | Model name                               |
| `COCONUT_BASE_URL`    | `https://api.deepseek.com/v1`    | OpenAI-compatible chat completions URL   |
| `COCONUT_SYSTEM`      | (unset)                          | System-prompt addendum                   |
| `COCONUT_MAX_TOKENS`  | `4096`                           | Max output tokens per turn               |
| `COCONUT_TEMPERATURE` | `0.3`                            | Sampling temperature                     |
| `COCONUT_CONTEXT_WINDOW`         | `64000` | Tokens before compression kicks in       |
| `COCONUT_COMPRESSION_THRESHOLD`  | `0.7`   | Trigger at this fraction of the window   |
| `COCONUT_KEEP_RECENT_TURNS`      | `4`     | Number of recent user turns kept verbatim |
| `COCONUT_SANDBOX`         | `local`                          | Sandbox kind: `local` or `docker`    |
| `COCONUT_WORKSPACE`       | current working directory        | Workspace root the agent operates in |
| `COCONUT_SANDBOX_IMAGE`   | `node:22-slim`                   | Docker image (when sandbox=`docker`) |
| `COCONUT_SANDBOX_NETWORK` | `bridge`                         | Container network: `bridge` or `none` (offline) |

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

| Command    | Action                                  |
| ---------- | --------------------------------------- |
| `/help`    | Show available commands                 |
| `/config`  | Show resolved config (paths + values, key redacted) |
| `/sandbox` | Show sandbox kind + workspace           |
| `/tokens`  | Show current token usage and compaction threshold |
| `/compact` | Force-compress conversation history right now |
| `/clear`   | Reset conversation history              |
| `/exit`    | Quit                                    |
| `Ctrl+C`   | Quit                                    |

## Context compression

Coding agents burn through context fast — tool outputs, file contents, long stack traces. Coconut uses a DeerFlow-inspired layered compression strategy while staying provider-neutral and OpenAI-compatible.

1. **Token estimation** — every message in history is measured with a lightweight mixed ASCII/CJK heuristic. The TUI header shows `tokens: 12.3K / 64K (19%)`, color-coded green → yellow → red as you approach the threshold.
2. **Tool output budget** — large tool results are saved under `.coconut/tool-results/`. The conversation keeps only a head/tail preview with the saved file path. Use `read_file` on that path when the full output is needed.
3. **Cheap history cleanup** — older bulky `tool` payloads are replaced with placeholders while preserving `tool_call_id` linkage so the message sequence remains valid.
4. **LLM summarization** — if usage is still over threshold, history older than the last `keepRecentTurns` user turns is summarized into a single anchor message. The summary preserves goals, files, decisions, current state, pending work, user preferences, and important externalized output paths.
5. **Run token budget** — each user turn has a run-level estimated token budget. Coconut injects a warning when the turn approaches the budget and stops additional tool work at the hard limit so it can converge instead of looping forever.
6. **Memory injection** — local `.md`/`.txt` memory files under `.coconut/memory/` are injected once per user turn within `memoryInjectionMaxTokens`. `type: correction` memories get a reserved budget so user corrections are not crowded out by ordinary notes.
7. **Dynamic context** — runtime metadata such as sandbox, workspace root, and current date is injected as a user-role reminder once per turn instead of being baked into the static system prompt.
8. **Manual override** — `/compact` runs the full compression pipeline immediately regardless of threshold.

Defaults: 64K token window, compaction triggers at 70% (≈45K tokens), keep the last 4 user turns verbatim, externalize tool outputs above 12K characters, and warn at 80% of the run budget. Tune them in your config:

```jsonc
{
  "contextWindow": 64000,
  "compressionThreshold": 0.7,
  "keepRecentTurns": 4,

  "toolOutputExternalizeMinChars": 12000,
  "toolOutputPreviewHeadChars": 2000,
  "toolOutputPreviewTailChars": 1000,
  "toolOutputDir": ".coconut/tool-results",

  "tokenBudgetMax": 200000,
  "tokenBudgetWarnRatio": 0.8,
  "tokenBudgetHardRatio": 1.0,

  "memoryInjectionMaxTokens": 2000,
  "memoryDir": ".coconut/memory",
  "memoryInjectionGuaranteedCorrectionTokens": 500,
  "dynamicContextEnabled": true,
  "dynamicContextIncludeDate": true
}
```

### Local memory files

Phase two memory injection is read-only: Coconut reads local memory files but does not write or edit them automatically.

Default location:

```txt
.coconut/memory/
```

Supported files: `.md` and `.txt`. Optional frontmatter:

```md
---
type: correction
priority: 10
---
When I correct Coconut, preserve the correction before ordinary project notes.
```

Recognized `type` values include `correction`, `preference`, `project`, and `reference`; other values are accepted as ordinary memories. Higher `priority` values are selected first. Missing frontmatter defaults to `type: reference` and `priority: 0`.

> Token counts are heuristic, not provider-billed counts. They are intentionally provider-independent so Coconut can work with any OpenAI-compatible endpoint.
>
> `.coconut/` contains runtime artifacts and is ignored by git. Tool-result files are not deleted automatically in this phase.

## Sandbox

By default Coconut runs in **`local`** sandbox mode: tools execute on the host, but every file/shell operation is confined to the workspace root (`COCONUT_WORKSPACE`, defaulting to the current directory). Attempts by the model to read or write outside the workspace are rejected.

For stronger isolation set `COCONUT_SANDBOX=docker`. Coconut starts a container, mounts your workspace at `/workspace`, and routes every tool call through `docker exec`. The model cannot touch anything outside the mount. The container is removed on exit (signal handlers + a synchronous `exit` hook guarantee no leaked containers, even on hard crash).

```bash
# Isolated container, no network — for "run the model's untrusted code" workflows
export COCONUT_SANDBOX=docker
export COCONUT_SANDBOX_NETWORK=none
bun run start

# Or use a different image (anything with `sh` works — Alpine, Debian, your own)
export COCONUT_SANDBOX_IMAGE=python:3.12-slim
bun run start
```

Requirements for `docker` mode: Docker Desktop, Colima, or Lima reachable as `docker` on `PATH`.

## Tools available to the agent

- `read_file` — read a file
- `write_file` — create/overwrite a file
- `edit_file` — string-replace in a file
- `list_files` — list directory contents
- `bash` — run a shell command (30s timeout)

## Architecture

```
src/
├── index.tsx           # Entry point — loads config, inits sandbox, renders App
├── components/
│   ├── App.tsx         # Main TUI: input box + message list + token meter
│   └── Message.tsx     # Renders one message (user/assistant/tool/info/error)
├── lib/
│   ├── agent.ts        # OpenAI-compatible chat completions + tool loop
│   ├── compaction.ts   # Token estimator + tool-result clearing + LLM summary
│   ├── config.ts       # Layered config loader (defaults → file → env)
│   ├── sandbox.ts      # Sandbox abstraction: LocalSandbox + DockerSandbox
│   └── types.ts        # Shared types
└── tools/
    └── index.ts        # Sandbox-aware tool definitions and executors
```

The agent loop in `lib/agent.ts`:
1. POST conversation + tool schemas to `/chat/completions`
2. If the response includes `tool_calls` → execute each tool **through the sandbox**, append results as `role: "tool"` messages, loop
3. Otherwise → done with this turn

The sandbox interface (`lib/sandbox.ts`) abstracts `exec`/`readFile`/`writeFile`/`readDir`. Tools never touch the filesystem directly — every operation goes through whichever sandbox is configured.
