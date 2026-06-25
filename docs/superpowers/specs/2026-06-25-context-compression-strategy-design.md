# Coconut Context Compression Strategy Design

Date: 2026-06-25
Status: Approved direction; implementation plan follows

## Goal

Optimize Coconut's context compression strategy using DeerFlow's layered approach, without replacing Coconut's current OpenAI-compatible chat-completions architecture. The first implementation phase should deliver the highest-impact safeguards while leaving clear extension points for memory injection and provider-native caching later.

## Current State

Coconut already has a compact context pipeline:

- `src/lib/compaction.ts` estimates tokens, clears older `role: "tool"` results, and summarizes older conversation history.
- `src/lib/agent.ts` calls `maybeCompact()` before each model request and supports `/compact` for manual compression.
- `src/lib/config.ts` exposes `contextWindow`, `compressionThreshold`, and `keepRecentTurns`.
- Tool outputs are currently bounded at the tool/sandbox layer, for example `bash` uses an 8 KiB output cap and `read_file` truncates files over 2000 lines.

The existing implementation is a good base, but it lacks DeerFlow-style output externalization, run-level budget control, and explicit future boundaries for memory/dynamic context.

## Selected Approach

Implement **core three-layer enhancement plus two extension boundaries**.

### Layer 1: Tool Output Budget

Large tool outputs should not live in chat history verbatim.

When a tool result exceeds a configured threshold:

1. Save the full result under `.coconut/tool-results/`.
2. Store only a preview in conversation history.
3. Include the file path, original character count, estimated tokens, and omitted character count in the preview.
4. Preserve the original `tool_call_id` and `role: "tool"` message so OpenAI-compatible tool-call structure remains valid.
5. Avoid re-externalizing reads of `.coconut/tool-results/` to prevent persistence/read/persistence loops.

Preview shape:

```txt
<first N chars>

[Full <tool> output saved to .coconut/tool-results/<file>.log (...). Use read_file to inspect the full content. ... chars omitted.]

<last M chars>
```

Default config:

```jsonc
{
  "toolOutputExternalizeMinChars": 12000,
  "toolOutputPreviewHeadChars": 2000,
  "toolOutputPreviewTailChars": 1000,
  "toolOutputDir": ".coconut/tool-results"
}
```

### Layer 2: Summarization

Keep the existing two-stage flow:

1. Clear older tool results.
2. Summarize older conversation history when still above threshold or when `/compact` is forced.

Enhance it by making the summary contract more explicit:

- Overall user goal.
- Files, paths, functions, symbols, and line numbers referenced.
- Decisions made and approaches tried, including failed attempts.
- Current state and pending work.
- User preferences and constraints.
- Any externalized tool-result files that may still matter.

The split should continue to happen only on user-turn boundaries, so assistant `tool_calls` and matching `tool` results are not separated.

The compacted anchor message remains `role: "user"`, not `role: "system"`, because Coconut targets OpenAI-compatible providers and cannot assume mid-conversation system messages are supported.

### Layer 3: Token Budget Safety Net

Add run-level token budget tracking around the existing agent loop.

Coconut should track estimated usage per user turn using the existing heuristic estimator. The safety net has two thresholds:

- Warn threshold: inject an internal budget warning once, telling the model to converge and avoid unnecessary tool calls.
- Hard threshold: stop further tool execution and ask the model for a final response, or return a safe budget-stop message if another model call is not appropriate.

Default config:

```jsonc
{
  "tokenBudgetMax": 200000,
  "tokenBudgetWarnRatio": 0.8,
  "tokenBudgetHardRatio": 1.0
}
```

The warning must be injected between model calls, never between an assistant `tool_calls` message and its required tool results. This preserves message structure.

### Layer 4: Memory Injection Boundary

Do not implement long-term memory in this phase.

Prepare for it by keeping dynamic context separate from static system prompt construction. Add a small budget/config boundary such as:

```jsonc
{
  "memoryInjectionMaxTokens": 2000
}
```

No memory persistence, ranking, or guaranteed category logic is required in this implementation phase.

### Layer 5: Dynamic Context / Cache Boundary

Do not adopt provider-specific prompt caching yet.

Coconut currently defaults to DeepSeek via an OpenAI-compatible endpoint. The implementation should avoid adding Claude- or Vercel-specific APIs. However, the code should keep static system instructions separate from future dynamic reminders so a later provider-specific caching layer can be added without rewriting the agent loop.

## Component Changes

### `src/lib/compaction.ts`

Add or update:

- Tool-output externalization helpers.
- Preview formatting helpers.
- Safer marker detection for already-cleared or already-externalized results.
- Summary prompt language that includes externalized result references and pending state.
- Token estimator adjustment for CJK text: use a less aggressive estimate than 1 char = 1 token; approximate 2 CJK chars = 1 token while retaining 4 non-CJK chars = 1 token.

### `src/lib/agent.ts`

Add integration points:

- After each tool execution and before pushing the `tool` message into history, run the tool output through the output-budget layer.
- Before each model call, run the token budget safety check.
- Inject the budget warning only once per user turn.
- If hard budget is exceeded, stop executing more tools and force convergence.

Do not rewrite the agent loop, replace the transport, or migrate to Vercel AI SDK / Anthropic SDK.

### `src/lib/config.ts`

Add config schema and resolved config fields for:

- `toolOutputExternalizeMinChars`
- `toolOutputPreviewHeadChars`
- `toolOutputPreviewTailChars`
- `toolOutputDir`
- `tokenBudgetMax`
- `tokenBudgetWarnRatio`
- `tokenBudgetHardRatio`
- `memoryInjectionMaxTokens`

Update env overrides using `COCONUT_*` names.

### Runtime Files

Add `.coconut/` to `.gitignore` so externalized outputs are not committed.

### Documentation

Update:

- `coconut.config.example.json`
- README context-compression section

The docs should explain:

- Why `.coconut/tool-results/` exists.
- How to inspect a full externalized output with `read_file`.
- That token accounting is heuristic and provider-independent.
- Which layers are implemented now and which are extension points.

## Data Flow

For each user turn:

1. Append user message to history.
2. Run auto-compaction if the conversation is above threshold.
3. Start or continue the agentic tool loop.
4. Before each model call, check estimated run budget.
5. If warning threshold is crossed, append one internal budget warning user message.
6. If hard threshold is crossed, do not continue tool execution; converge.
7. Call the model.
8. Append assistant message.
9. For each requested tool:
   - Execute through sandbox.
   - Externalize large output if needed.
   - Append the preview as the `tool` message content.
10. Loop until no tools, hard budget stop, or max iterations.

## Error Handling

- If externalization write fails, fall back to in-context head/tail truncation with an explicit note that persistence failed.
- If summary model call fails during auto-compaction, surface the error through existing `onError` behavior; do not silently drop history.
- If forced `/compact` cannot reduce history because there are too few turns, report that no compaction was needed.
- If token hard stop is reached, prefer a final model response using current compacted history. If even that is not viable, emit a clear budget-stop message.
- Never delete externalized tool-result files automatically in this phase; they are session artifacts under `.coconut/`.

## Testing Strategy

Use lightweight unit tests or direct TypeScript/Bun checks where the project already supports them. If no test harness exists, add focused tests only if they do not require broad framework setup.

Critical cases:

1. Token estimator handles ASCII, CJK, mixed content, and empty strings.
2. Tool externalization writes full output and returns a bounded preview.
3. Externalization preserves head and tail content.
4. Reads under `.coconut/tool-results/` are not externalized again.
5. `clearOldToolResults` does not re-clear already-cleared/externalized placeholders.
6. `compactHistory` preserves recent turns and splits only on user boundaries.
7. Budget warning is injected at most once per turn.
8. Hard budget prevents further tool execution.
9. Config defaults and env overrides resolve correctly.

## Non-Goals

- No migration to Vercel AI SDK.
- No migration to Anthropic SDK.
- No provider-native prompt caching.
- No durable long-term memory store.
- No full middleware framework.
- No UI redesign.

## Implementation Notes

- Prefer small, named helper functions in `compaction.ts` over expanding `agent.ts` directly.
- Keep all paths workspace-relative in model-visible messages.
- Use `.coconut/tool-results/` as the default output directory and ensure parent directories are created lazily.
- Keep defaults conservative: externalize only clearly-large outputs, warn before hard stop, and preserve recent turns verbatim.
