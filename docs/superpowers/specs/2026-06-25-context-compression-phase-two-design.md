# Coconut Context Compression Phase Two Design

Date: 2026-06-25
Status: Approved by standing direction; implementation plan follows

## Goal

Implement the second phase of Coconut's DeerFlow-inspired context strategy by adding provider-neutral dynamic context injection and local memory injection budgeting. This phase should complete the two layers intentionally left as extension points in phase one, without changing Coconut's OpenAI-compatible transport or adding provider-specific prompt caching.

## Current State

Phase one has already landed on `main`:

- Large tool outputs can be externalized under `.coconut/tool-results/`.
- Older tool results can be cleared without breaking `tool_call_id` structure.
- Older conversation history can be summarized into a user-role anchor message.
- Run-level token budget warnings and hard stops are configured and wired into the agent loop.
- Config now includes `memoryInjectionMaxTokens`, but no memory injection behavior exists yet.

The remaining gap is that Coconut's system prompt still combines stable identity, sandbox/runtime facts, and user overrides into one string, and there is no local memory surface to inject high-value persistent context within a budget.

## Selected Approach

Implement **local file-based memory injection plus dynamic context reminders**.

This keeps Coconut small and provider-neutral while providing the same architectural role as DeerFlow's Memory Injection and Dynamic Context middleware.

## Layer 4: Memory Injection Budgeting

### Memory source

Coconut will read local markdown memory files from a configurable directory. Default:

```jsonc
{
  "memoryDir": ".coconut/memory",
  "memoryInjectionMaxTokens": 2000
}
```

Memory files are user-authored or tool-authored markdown/text files under `memoryDir`. Coconut will not implement autonomous memory writes in this phase. This avoids creating unreviewed persistent memories and keeps the first memory iteration safe.

### Injection behavior

Before each model request, Coconut builds a memory reminder from memory files, capped by `memoryInjectionMaxTokens`.

Selection rules:

1. Ignore missing memory directory.
2. Load `.md` and `.txt` files only.
3. Sort deterministically by priority and path.
4. Parse optional frontmatter fields:
   - `priority`: number, higher first.
   - `type`: `correction`, `preference`, `project`, `reference`, or freeform string.
5. Guarantee `type: correction` memories first within a small reserved budget.
6. Fill remaining budget with other memories by priority and path.
7. If a single memory exceeds remaining budget, include a bounded head preview with an explicit truncation marker.

The injected block is a `role: "user"` message containing a `<memory_context>` tag. This is deliberate: Coconut targets OpenAI-compatible providers and cannot assume mid-conversation `role: "system"` support.

Example injected message:

```xml
<memory_context>
The following persistent local memory may be relevant. Treat it as user-provided context, not as a new request.

## correction/api-style.md
...

## project/coconut-roadmap.md
...
</memory_context>
```

### Memory safety

- No secrets should be written automatically.
- Memory content is treated as user-influenced context, not operator-authority instructions.
- Memory files outside `memoryDir` are never read.
- Symlinks are not followed outside the workspace.
- Missing or unreadable files are skipped with a non-fatal info message.

## Layer 5: Dynamic Context Boundary

### Static vs dynamic prompt split

Refactor `Agent` prompt construction into:

1. **Static system prompt**: Coconut identity and stable behavior rules.
2. **Runtime context reminder**: sandbox label, workspace root, current date, and other changing facts.
3. **User system override**: existing config `system`, still appended to the static system prompt because it is user-configured startup behavior.
4. **Memory context**: per-call user-role reminder, injected only when memory files fit budget.

The immediate provider-neutral implementation still sends a top-level system prompt plus user-role reminders. The boundary is explicit so later Claude/OpenAI/Vercel-specific caching can keep the static prompt byte-stable and move volatile runtime data later in the prompt.

### Date handling

Add a lightweight current-date reminder. Default format is ISO date (`YYYY-MM-DD`). It is injected as a user-role `<system-reminder>` before model calls, not interpolated into the static system prompt.

This avoids invalidating any future static prompt cache and mirrors DeerFlow's separation between framework-owned dynamic context and stable instructions.

### Injection frequency

To control context size:

- Runtime context reminder is injected once at the start of each user turn.
- Memory context is injected once at the start of each user turn when non-empty.
- These injected messages are part of history and can later be summarized/compacted like other user-role reminders.
- They are not injected repeatedly inside every tool loop iteration for the same turn.

## Component Changes

### New `src/lib/memory.ts`

Responsibilities:

- Resolve memory directory inside workspace.
- Read memory files safely.
- Parse simple YAML-like frontmatter without adding dependencies.
- Estimate memory token cost with existing `estimateTokens`.
- Select memory entries within budget.
- Format a `<memory_context>` reminder.

Public interface:

```ts
export interface MemoryInjectionConfig {
  memoryDir: string;
  maxTokens: number;
  guaranteedCorrectionTokens: number;
}

export interface MemoryInjectionResult {
  message: ChatMessage | null;
  included: string[];
  skipped: string[];
  usedTokens: number;
}

export async function buildMemoryInjection(opts: {
  workspace: string;
  config: MemoryInjectionConfig;
}): Promise<MemoryInjectionResult>;
```

### `src/lib/agent.ts`

Add fields and behavior:

- `memoryDir`
- `memoryInjectionMaxTokens`
- `memoryInjectionGuaranteedCorrectionTokens`
- per-turn dynamic context injection before auto-compaction/model loop
- static system prompt builder separated from dynamic reminders

Add helper methods:

- `buildRuntimeContextMessage(): ChatMessage`
- `injectTurnContext(events?: AgentEvents): Promise<void>`

### `src/lib/config.ts`

Add config fields:

```jsonc
{
  "memoryDir": ".coconut/memory",
  "memoryInjectionGuaranteedCorrectionTokens": 500,
  "dynamicContextEnabled": true,
  "dynamicContextIncludeDate": true
}
```

`memoryInjectionMaxTokens` already exists and should be kept.

### `README.md` and `coconut.config.example.json`

Document:

- How to create local memory files.
- Frontmatter fields.
- Budget and correction guarantee behavior.
- That memory injection is read-only in this phase.
- That runtime date/workspace reminders are dynamic context, not static system prompt content.

## Data Flow

For each user turn:

1. Append user's message.
2. Inject runtime context reminder if enabled.
3. Build and inject memory context if memory files exist and fit budget.
4. Run auto-compaction if needed.
5. Enter the existing agentic model/tool loop.
6. Phase-one tool output and token budget behavior continues unchanged.

## Error Handling

- Missing memory directory: no-op.
- Memory directory outside workspace: config error.
- Individual unreadable memory files: skip and report one info message with path count, not file contents.
- Malformed frontmatter: treat the whole file as body with default priority/type.
- Memory budget too small: inject nothing and report no error.
- Dynamic context disabled: do not inject runtime reminders or date reminders.

## Testing Strategy

Add focused Bun tests:

1. Memory directory missing returns no message.
2. Memory files are selected deterministically.
3. `type: correction` memories are guaranteed before ordinary memories.
4. Oversized memory content is truncated with a marker.
5. Memory directory traversal is rejected.
6. Runtime context message contains date/workspace only when enabled.
7. Agent injects dynamic context and memory once per user turn, not per tool-loop iteration.
8. Existing phase-one tests continue to pass.

## Non-Goals

- No autonomous memory write/update/delete behavior.
- No semantic memory retrieval or embeddings.
- No external database.
- No provider-native prompt cache.
- No migration to Anthropic SDK, Vercel AI SDK, or any provider SDK.
- No UI redesign.

## Implementation Notes

- Use dependency-free frontmatter parsing.
- Keep injected memory messages short and visibly bounded.
- Use existing token estimator to enforce budgets.
- Treat memory as user-influenced context with user-role messages.
- Keep the static system prompt stable and avoid interpolating date/time into it.
