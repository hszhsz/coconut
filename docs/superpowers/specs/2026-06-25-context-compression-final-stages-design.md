# Coconut Context Compression Final Stages Design

Date: 2026-06-25
Status: Direct main-branch implementation

## Goal

Finish the remaining practical context-compression layers for Coconut by making memory manageable, context state inspectable, and externalized tool outputs bounded over time.

## Current State

Phase one implemented tool-output externalization, summarization, and token budget controls. Phase two implemented read-only local memory injection and dynamic runtime context reminders. The remaining gaps are operational:

- Users can create memory files manually, but Coconut has no safe TUI commands to list, add, or remove memories.
- Users can view `/tokens`, but cannot inspect which compression layers are active or how much memory/dynamic context is being injected.
- Externalized tool outputs accumulate under `.coconut/tool-results/` with no retention policy.

## Selected Approach

Implement a small operational layer:

1. **Explicit memory lifecycle commands**
   - `/remember <text>` creates a reviewed memory file under `.coconut/memory/notes/`.
   - `/memory` lists memory files with type/priority/size.
   - `/memory show <path>` displays a memory file.
   - `/memory delete <path>` deletes only files under the memory directory.

2. **Context diagnostics command**
   - `/context` displays token stats, compression threshold, token budget, dynamic context settings, memory injection settings, memory file count, and externalized tool-result count/size.

3. **Tool-result retention**
   - New config controls: `toolOutputRetentionMaxFiles` and `toolOutputRetentionMaxBytes`.
   - On startup and after externalizing output, Coconut prunes oldest tool-result files until both limits are satisfied.
   - Defaults are conservative: 200 files and 50 MiB.

## Non-Goals

- No autonomous memory writes from the model.
- No semantic retrieval, embeddings, or external database.
- No provider-native prompt cache.
- No SDK migration.
- No destructive cleanup outside `.coconut/tool-results/` or configured `memoryDir`.

## Data Flow

- User runs `/remember text` → Coconut writes a markdown memory with frontmatter → future turns inject it within budget.
- User runs `/context` → Coconut computes diagnostics from in-memory token stats plus filesystem summaries.
- Tool result is externalized → retention cleanup runs on the output directory.

## Error Handling

- Empty `/remember` returns usage text.
- Memory paths are resolved against `memoryDir`; traversal is rejected.
- Missing memory file on show/delete returns a friendly error.
- Retention cleanup skips unreadable files and reports a concise info message.
- Diagnostics never print API keys or memory file contents, only metadata.

## Testing

Add focused Bun tests for memory command helpers and retention helpers. Existing `bun test` and `bun run build` must pass.
