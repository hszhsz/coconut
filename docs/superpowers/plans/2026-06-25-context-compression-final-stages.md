# Context Compression Final Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add memory lifecycle commands, context diagnostics, and bounded retention for externalized tool outputs.

**Architecture:** Add focused helper functions to `src/lib/memory.ts` for safe memory file management, add tool-result retention helpers to `src/lib/compaction.ts`, then wire commands through `src/components/App.tsx` while preserving the current Agent transport and loop.

**Tech Stack:** Bun, TypeScript, Ink/React, Node `fs/path/crypto`, current Coconut config and sandbox abstractions.

## Global Constraints

- Work directly on `main` as requested.
- Do not change provider transport or add SDKs.
- Do not implement autonomous model memory writes.
- Only delete files under configured `memoryDir` or `toolOutputDir`.
- Never print API keys or full diagnostics secrets.
- Commit and push after successful changes.

---

### Task 1: Memory Lifecycle Helpers

**Files:**
- Modify: `src/lib/memory.ts`
- Modify: `src/lib/memory.test.ts`

**Interfaces:**
- `createMemoryNote(opts): Promise<string>` returns relative path.
- `listMemoryFiles(opts): Promise<MemoryFileSummary[]>` returns metadata.
- `readMemoryFile(opts): Promise<string>` returns content.
- `deleteMemoryFile(opts): Promise<string>` returns deleted relative path.

Steps:
- [ ] Add tests for create/list/read/delete and traversal rejection.
- [ ] Implement safe path resolution under `memoryDir`.
- [ ] Implement note file creation in `notes/` with frontmatter `type: reference`, `priority: 0`.
- [ ] Implement list/read/delete.
- [ ] Run `bun test src/lib/memory.test.ts` and `bun run build`.
- [ ] Commit.

### Task 2: Tool Result Retention Helpers

**Files:**
- Modify: `src/lib/compaction.ts`
- Modify: `src/lib/compaction.test.ts`
- Modify: `src/lib/config.ts`
- Modify: `src/lib/config.test.ts`
- Modify: `coconut.config.example.json`

**Interfaces:**
- Config: `toolOutputRetentionMaxFiles: number`, `toolOutputRetentionMaxBytes: number`.
- `pruneToolResults(opts): Promise<ToolResultRetentionStats>`.

Steps:
- [ ] Add tests for pruning oldest files by count and bytes.
- [ ] Add config schema/default/env/display/example fields.
- [ ] Implement retention helper in `compaction.ts`.
- [ ] Call pruning after externalization.
- [ ] Run targeted tests and build.
- [ ] Commit.

### Task 3: TUI Commands and Diagnostics

**Files:**
- Modify: `src/components/App.tsx`
- Modify: `src/index.tsx` if new props are needed.
- Modify: `README.md`

**Commands:**
- `/remember <text>`
- `/memory`
- `/memory show <path>`
- `/memory delete <path>`
- `/context`

Steps:
- [ ] Add command handlers using memory helpers.
- [ ] Add `/context` summary using agent tokenStats, config values, memory list, and tool-result directory stats.
- [ ] Update `/help` text.
- [ ] Update README command and context sections.
- [ ] Run `bun test` and `bun run build`.
- [ ] Smoke test startup without API key.
- [ ] Commit and push `main`.

## Self-Review Notes

- Covers all final-stage design requirements.
- No placeholders.
- All new destructive behavior is path-confined.
