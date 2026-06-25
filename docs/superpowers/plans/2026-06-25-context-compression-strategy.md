# Context Compression Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Coconut's first-phase DeerFlow-inspired context compression strategy: tool-output externalization, improved summarization, and run-level token budget controls, while preserving the current OpenAI-compatible agent architecture.

**Architecture:** Extend the existing `src/lib/compaction.ts` helpers and integrate them into `src/lib/agent.ts` at tool-result and model-call boundaries. Keep the system prompt static, keep compacted summaries as user anchor messages, and add config-driven behavior without introducing new runtime dependencies or changing providers.

**Tech Stack:** Bun, TypeScript, Ink/React TUI, OpenAI-compatible `/chat/completions`, Node `fs/path/crypto`, existing sandbox abstraction.

## Global Constraints

- Do not migrate to Vercel AI SDK, Anthropic SDK, or provider-specific APIs.
- Do not rewrite the agent loop; add focused helper functions and small integration points.
- Keep tool-call structure valid: assistant `tool_calls` must be followed by matching `role: "tool"` messages.
- Keep model-visible paths workspace-relative when possible.
- Store externalized tool outputs under `.coconut/tool-results/` by default.
- Add `.coconut/` to `.gitignore` so runtime artifacts are not committed.
- Use heuristic token accounting only; do not add tokenizer packages.
- Commit after each task using messages ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## File Structure

- Modify `src/lib/compaction.ts`: token estimator adjustment, externalization types/helpers, clearer cleared/externalized marker handling, summarization prompt update.
- Modify `src/lib/agent.ts`: accept new config, externalize tool results before adding them to history, inject budget warning, hard-stop further tool execution when run budget is exhausted.
- Modify `src/lib/config.ts`: schema/default/env/display/example fields for compression and budget settings.
- Modify `src/components/App.tsx`: pass new config fields into `Agent`; show token budget in `/tokens` output.
- Modify `src/index.tsx`: pass resolved config fields into `App`.
- Modify `coconut.config.example.json`: document new config keys.
- Modify `.gitignore`: ignore `.coconut/`.
- Modify `README.md`: update context compression docs.
- Create tests under `src/lib/compaction.test.ts` and `src/lib/config.test.ts` if the project has no existing harness; use `bun test`.

---

### Task 1: Config Surface for Compression Budgets

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/components/App.tsx`
- Modify: `src/index.tsx`
- Modify: `coconut.config.example.json`
- Test: `src/lib/config.test.ts`

**Interfaces:**
- Produces: `ResolvedConfig` fields:
  - `toolOutputExternalizeMinChars: number`
  - `toolOutputPreviewHeadChars: number`
  - `toolOutputPreviewTailChars: number`
  - `toolOutputDir: string`
  - `tokenBudgetMax: number`
  - `tokenBudgetWarnRatio: number`
  - `tokenBudgetHardRatio: number`
  - `memoryInjectionMaxTokens: number`
- Produces: `AgentConfig` receives the same fields in Task 3.

- [ ] **Step 1: Write failing config tests**

Create `src/lib/config.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coconut-config-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadConfig compression budget fields", () => {
  test("uses conservative defaults", async () => {
    await withTempDir(async (dir) => {
      const cfg = await loadConfig({ cwd: dir });
      expect(cfg.toolOutputExternalizeMinChars).toBe(12_000);
      expect(cfg.toolOutputPreviewHeadChars).toBe(2_000);
      expect(cfg.toolOutputPreviewTailChars).toBe(1_000);
      expect(cfg.toolOutputDir).toBe(".coconut/tool-results");
      expect(cfg.tokenBudgetMax).toBe(200_000);
      expect(cfg.tokenBudgetWarnRatio).toBe(0.8);
      expect(cfg.tokenBudgetHardRatio).toBe(1.0);
      expect(cfg.memoryInjectionMaxTokens).toBe(2_000);
    });
  });

  test("loads project config values", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, ".coconut.json"),
        JSON.stringify({
          toolOutputExternalizeMinChars: 100,
          toolOutputPreviewHeadChars: 20,
          toolOutputPreviewTailChars: 10,
          toolOutputDir: ".custom/results",
          tokenBudgetMax: 5000,
          tokenBudgetWarnRatio: 0.5,
          tokenBudgetHardRatio: 0.75,
          memoryInjectionMaxTokens: 333,
        }),
      );

      const cfg = await loadConfig({ cwd: dir });
      expect(cfg.toolOutputExternalizeMinChars).toBe(100);
      expect(cfg.toolOutputPreviewHeadChars).toBe(20);
      expect(cfg.toolOutputPreviewTailChars).toBe(10);
      expect(cfg.toolOutputDir).toBe(".custom/results");
      expect(cfg.tokenBudgetMax).toBe(5000);
      expect(cfg.tokenBudgetWarnRatio).toBe(0.5);
      expect(cfg.tokenBudgetHardRatio).toBe(0.75);
      expect(cfg.memoryInjectionMaxTokens).toBe(333);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/lib/config.test.ts
```

Expected: FAIL with TypeScript/runtime errors that `toolOutputExternalizeMinChars` and related fields do not exist.

- [ ] **Step 3: Add config schema fields and defaults**

In `src/lib/config.ts`, add these fields to `ConfigSchema`:

```ts
toolOutputExternalizeMinChars: z.number().int().positive().optional(),
toolOutputPreviewHeadChars: z.number().int().min(0).optional(),
toolOutputPreviewTailChars: z.number().int().min(0).optional(),
toolOutputDir: z.string().min(1).optional(),
tokenBudgetMax: z.number().int().positive().optional(),
tokenBudgetWarnRatio: z.number().min(0.1).max(0.99).optional(),
tokenBudgetHardRatio: z.number().min(0.1).max(1).optional(),
memoryInjectionMaxTokens: z.number().int().min(0).optional(),
```

Add these fields to `ResolvedConfig`:

```ts
toolOutputExternalizeMinChars: number;
toolOutputPreviewHeadChars: number;
toolOutputPreviewTailChars: number;
toolOutputDir: string;
tokenBudgetMax: number;
tokenBudgetWarnRatio: number;
tokenBudgetHardRatio: number;
memoryInjectionMaxTokens: number;
```

Add defaults to `DEFAULTS` after `keepRecentTurns`:

```ts
toolOutputExternalizeMinChars: 12_000,
toolOutputPreviewHeadChars: 2_000,
toolOutputPreviewTailChars: 1_000,
toolOutputDir: ".coconut/tool-results",
tokenBudgetMax: 200_000,
tokenBudgetWarnRatio: 0.8,
tokenBudgetHardRatio: 1.0,
memoryInjectionMaxTokens: 2_000,
```

In `loadConfig()`, set resolved fields after `keepRecentTurns`:

```ts
toolOutputExternalizeMinChars:
  merged.toolOutputExternalizeMinChars ?? DEFAULTS.toolOutputExternalizeMinChars,
toolOutputPreviewHeadChars:
  merged.toolOutputPreviewHeadChars ?? DEFAULTS.toolOutputPreviewHeadChars,
toolOutputPreviewTailChars:
  merged.toolOutputPreviewTailChars ?? DEFAULTS.toolOutputPreviewTailChars,
toolOutputDir: merged.toolOutputDir ?? DEFAULTS.toolOutputDir,
tokenBudgetMax: merged.tokenBudgetMax ?? DEFAULTS.tokenBudgetMax,
tokenBudgetWarnRatio: merged.tokenBudgetWarnRatio ?? DEFAULTS.tokenBudgetWarnRatio,
tokenBudgetHardRatio: merged.tokenBudgetHardRatio ?? DEFAULTS.tokenBudgetHardRatio,
memoryInjectionMaxTokens:
  merged.memoryInjectionMaxTokens ?? DEFAULTS.memoryInjectionMaxTokens,
```

- [ ] **Step 4: Add env overrides with validation**

In `envOverrides()` in `src/lib/config.ts`, add after `COCONUT_KEEP_RECENT_TURNS`:

```ts
if (process.env.COCONUT_TOOL_OUTPUT_EXTERNALIZE_MIN_CHARS) {
  const n = Number(process.env.COCONUT_TOOL_OUTPUT_EXTERNALIZE_MIN_CHARS);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("COCONUT_TOOL_OUTPUT_EXTERNALIZE_MIN_CHARS must be a positive integer");
  out.toolOutputExternalizeMinChars = n;
}
if (process.env.COCONUT_TOOL_OUTPUT_PREVIEW_HEAD_CHARS) {
  const n = Number(process.env.COCONUT_TOOL_OUTPUT_PREVIEW_HEAD_CHARS);
  if (!Number.isInteger(n) || n < 0)
    throw new Error("COCONUT_TOOL_OUTPUT_PREVIEW_HEAD_CHARS must be a non-negative integer");
  out.toolOutputPreviewHeadChars = n;
}
if (process.env.COCONUT_TOOL_OUTPUT_PREVIEW_TAIL_CHARS) {
  const n = Number(process.env.COCONUT_TOOL_OUTPUT_PREVIEW_TAIL_CHARS);
  if (!Number.isInteger(n) || n < 0)
    throw new Error("COCONUT_TOOL_OUTPUT_PREVIEW_TAIL_CHARS must be a non-negative integer");
  out.toolOutputPreviewTailChars = n;
}
if (process.env.COCONUT_TOOL_OUTPUT_DIR) {
  out.toolOutputDir = process.env.COCONUT_TOOL_OUTPUT_DIR;
}
if (process.env.COCONUT_TOKEN_BUDGET_MAX) {
  const n = Number(process.env.COCONUT_TOKEN_BUDGET_MAX);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("COCONUT_TOKEN_BUDGET_MAX must be a positive integer");
  out.tokenBudgetMax = n;
}
if (process.env.COCONUT_TOKEN_BUDGET_WARN_RATIO) {
  const n = Number(process.env.COCONUT_TOKEN_BUDGET_WARN_RATIO);
  if (!Number.isFinite(n) || n < 0.1 || n > 0.99)
    throw new Error("COCONUT_TOKEN_BUDGET_WARN_RATIO must be between 0.1 and 0.99");
  out.tokenBudgetWarnRatio = n;
}
if (process.env.COCONUT_TOKEN_BUDGET_HARD_RATIO) {
  const n = Number(process.env.COCONUT_TOKEN_BUDGET_HARD_RATIO);
  if (!Number.isFinite(n) || n < 0.1 || n > 1)
    throw new Error("COCONUT_TOKEN_BUDGET_HARD_RATIO must be between 0.1 and 1");
  out.tokenBudgetHardRatio = n;
}
if (process.env.COCONUT_MEMORY_INJECTION_MAX_TOKENS) {
  const n = Number(process.env.COCONUT_MEMORY_INJECTION_MAX_TOKENS);
  if (!Number.isInteger(n) || n < 0)
    throw new Error("COCONUT_MEMORY_INJECTION_MAX_TOKENS must be a non-negative integer");
  out.memoryInjectionMaxTokens = n;
}
```

After building `resolved`, add this invariant check before `return resolved;`:

```ts
if (resolved.tokenBudgetWarnRatio >= resolved.tokenBudgetHardRatio) {
  throw new Error("tokenBudgetWarnRatio must be less than tokenBudgetHardRatio");
}
```

- [ ] **Step 5: Update config display and example config**

In `describeConfig()`, append lines after `keepRecentTurns`:

```ts
`toolOutputExternalizeMinChars: ${cfg.toolOutputExternalizeMinChars}`,
`toolOutputPreviewHeadChars:   ${cfg.toolOutputPreviewHeadChars}`,
`toolOutputPreviewTailChars:   ${cfg.toolOutputPreviewTailChars}`,
`toolOutputDir:                ${cfg.toolOutputDir}`,
`tokenBudgetMax:               ${cfg.tokenBudgetMax}`,
`tokenBudgetWarnRatio:         ${cfg.tokenBudgetWarnRatio}`,
`tokenBudgetHardRatio:         ${cfg.tokenBudgetHardRatio}`,
`memoryInjectionMaxTokens:     ${cfg.memoryInjectionMaxTokens}`,
```

Update `EXAMPLE_CONFIG` with:

```ts
toolOutputExternalizeMinChars: 12_000,
toolOutputPreviewHeadChars: 2_000,
toolOutputPreviewTailChars: 1_000,
toolOutputDir: ".coconut/tool-results",
tokenBudgetMax: 200_000,
tokenBudgetWarnRatio: 0.8,
tokenBudgetHardRatio: 1.0,
memoryInjectionMaxTokens: 2_000,
```

Update `coconut.config.example.json` to include the same JSON keys after `keepRecentTurns`.

- [ ] **Step 6: Pass fields through TUI props**

In `src/components/App.tsx`, extend `Props` with:

```ts
toolOutputExternalizeMinChars: number;
toolOutputPreviewHeadChars: number;
toolOutputPreviewTailChars: number;
toolOutputDir: string;
tokenBudgetMax: number;
tokenBudgetWarnRatio: number;
tokenBudgetHardRatio: number;
memoryInjectionMaxTokens: number;
```

Destructure those fields from props and pass them into `new Agent({ ... })`.

In `/tokens` output, change content to:

```ts
content: `Tokens: ${s.used.toLocaleString()} / ${s.window.toLocaleString()} (${pct}%)\nAuto-compact triggers at ${(compressionThreshold * 100).toFixed(0)}%\nRun budget: ${tokenBudgetMax.toLocaleString()} tokens (warn ${(tokenBudgetWarnRatio * 100).toFixed(0)}%, hard ${(tokenBudgetHardRatio * 100).toFixed(0)}%)`,
```

Add `tokenBudgetMax`, `tokenBudgetWarnRatio`, and `tokenBudgetHardRatio` to the `useCallback` dependency list.

In `src/index.tsx`, pass these props to `<App />`:

```tsx
toolOutputExternalizeMinChars={cfg!.toolOutputExternalizeMinChars}
toolOutputPreviewHeadChars={cfg!.toolOutputPreviewHeadChars}
toolOutputPreviewTailChars={cfg!.toolOutputPreviewTailChars}
toolOutputDir={cfg!.toolOutputDir}
tokenBudgetMax={cfg!.tokenBudgetMax}
tokenBudgetWarnRatio={cfg!.tokenBudgetWarnRatio}
tokenBudgetHardRatio={cfg!.tokenBudgetHardRatio}
memoryInjectionMaxTokens={cfg!.memoryInjectionMaxTokens}
```

- [ ] **Step 7: Run tests and typecheck/build**

Run:

```bash
bun test src/lib/config.test.ts
bun run build
```

Expected: tests PASS; build exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/config.ts src/components/App.tsx src/index.tsx coconut.config.example.json src/lib/config.test.ts
git commit -m "Add context compression budget config" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Tool Output Externalization Helpers

**Files:**
- Modify: `src/lib/compaction.ts`
- Test: `src/lib/compaction.test.ts`

**Interfaces:**
- Consumes: `estimateTokens(s: string | null | undefined): number`
- Produces:
  - `interface ToolOutputBudgetConfig`
  - `interface ExternalizedToolResult`
  - `function isExternalizedToolResult(content: string | null | undefined): boolean`
  - `async function maybeExternalizeToolResult(opts): Promise<ExternalizedToolResult>`

- [ ] **Step 1: Write failing compaction tests for estimator and externalization**

Create `src/lib/compaction.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  estimateTokens,
  isExternalizedToolResult,
  maybeExternalizeToolResult,
} from "./compaction.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coconut-compaction-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("estimateTokens", () => {
  test("estimates empty, ASCII, CJK, and mixed content", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")) .toBe(1);
    expect(estimateTokens("abcdefgh")) .toBe(2);
    expect(estimateTokens("你好世界")) .toBe(2);
    expect(estimateTokens("abcd你好")) .toBe(2);
  });
});

describe("maybeExternalizeToolResult", () => {
  test("keeps small output unchanged", async () => {
    await withTempDir(async (workspace) => {
      const result = await maybeExternalizeToolResult({
        workspace,
        toolName: "bash",
        content: "small output",
        config: {
          externalizeMinChars: 100,
          previewHeadChars: 10,
          previewTailChars: 10,
          outputDir: ".coconut/tool-results",
        },
      });

      expect(result.externalized).toBe(false);
      expect(result.content).toBe("small output");
      expect(result.filePath).toBeUndefined();
    });
  });

  test("externalizes large output and preserves head and tail preview", async () => {
    await withTempDir(async (workspace) => {
      const content = "HEAD-" + "x".repeat(80) + "-TAIL";
      const result = await maybeExternalizeToolResult({
        workspace,
        toolName: "bash",
        content,
        config: {
          externalizeMinChars: 20,
          previewHeadChars: 8,
          previewTailChars: 8,
          outputDir: ".coconut/tool-results",
        },
      });

      expect(result.externalized).toBe(true);
      expect(result.filePath).toMatch(/^\.coconut\/tool-results\/bash-/);
      expect(result.content).toContain("HEAD-xxx");
      expect(result.content).toContain("xxx-TAIL");
      expect(result.content).toContain("Full bash output saved to");
      expect(result.content).toContain("Use read_file to inspect the full content");
      expect(isExternalizedToolResult(result.content)).toBe(true);

      const saved = await readFile(path.join(workspace, result.filePath!), "utf-8");
      expect(saved).toBe(content);
    });
  });

  test("does not re-externalize reads from tool result files", async () => {
    await withTempDir(async (workspace) => {
      const content = "x".repeat(100);
      const result = await maybeExternalizeToolResult({
        workspace,
        toolName: "read_file",
        toolInput: { path: ".coconut/tool-results/bash-example.log" },
        content,
        config: {
          externalizeMinChars: 20,
          previewHeadChars: 8,
          previewTailChars: 8,
          outputDir: ".coconut/tool-results",
        },
      });

      expect(result.externalized).toBe(false);
      expect(result.content).toBe(content);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/lib/compaction.test.ts
```

Expected: FAIL because `maybeExternalizeToolResult` and `isExternalizedToolResult` do not exist, and CJK estimator currently returns 4 for `你好世界`.

- [ ] **Step 3: Update token estimator**

In `src/lib/compaction.ts`, change `estimateTokens` to:

```ts
export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  const cjk = (s.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const nonCjk = s.length - cjk;
  return Math.ceil(cjk / 2 + nonCjk / 4);
}
```

- [ ] **Step 4: Add imports and externalization interfaces**

At the top of `src/lib/compaction.ts`, add:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
```

After `TokenStats`, add:

```ts
export interface ToolOutputBudgetConfig {
  externalizeMinChars: number;
  previewHeadChars: number;
  previewTailChars: number;
  outputDir: string;
}

export interface ExternalizedToolResult {
  content: string;
  externalized: boolean;
  filePath?: string;
  originalChars: number;
  estimatedTokens: number;
}

const EXTERNALIZED_MARKER = "[Full ";
const EXTERNALIZED_SAVED_TO = " output saved to ";
```

- [ ] **Step 5: Add externalization helper functions**

In `src/lib/compaction.ts`, add before `clearOldToolResults`:

```ts
export function isExternalizedToolResult(
  content: string | null | undefined,
): boolean {
  return Boolean(
    content &&
      content.includes(EXTERNALIZED_MARKER) &&
      content.includes(EXTERNALIZED_SAVED_TO) &&
      content.includes("Use read_file to inspect the full content"),
  );
}

function safeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
}

function isToolResultFileRead(toolName: string, toolInput: unknown, outputDir: string): boolean {
  if (toolName !== "read_file") return false;
  if (!toolInput || typeof toolInput !== "object") return false;
  const p = (toolInput as { path?: unknown }).path;
  if (typeof p !== "string") return false;
  const normalizedInput = p.replace(/\\/g, "/");
  const normalizedDir = outputDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedInput === normalizedDir || normalizedInput.startsWith(`${normalizedDir}/`);
}

function formatExternalizedPreview(opts: {
  toolName: string;
  content: string;
  filePath: string;
  headChars: number;
  tailChars: number;
}): string {
  const { toolName, content, filePath, headChars, tailChars } = opts;
  const head = headChars > 0 ? content.slice(0, headChars) : "";
  const tail = tailChars > 0 ? content.slice(Math.max(headChars, content.length - tailChars)) : "";
  const omitted = Math.max(0, content.length - head.length - tail.length);
  const marker = `[Full ${toolName} output saved to ${filePath} (${content.length} chars, ~${estimateTokens(content)} tokens). Use read_file to inspect the full content. ${omitted} chars omitted from this preview.]`;
  if (head && tail) return `${head}\n\n${marker}\n\n${tail}`;
  if (head) return `${head}\n\n${marker}`;
  if (tail) return `${marker}\n\n${tail}`;
  return marker;
}

export async function maybeExternalizeToolResult(opts: {
  workspace: string;
  toolName: string;
  toolInput?: unknown;
  content: string;
  config: ToolOutputBudgetConfig;
}): Promise<ExternalizedToolResult> {
  const { workspace, toolName, toolInput, content, config } = opts;
  const originalChars = content.length;
  const estimatedTokens = estimateTokens(content);

  if (originalChars < config.externalizeMinChars) {
    return { content, externalized: false, originalChars, estimatedTokens };
  }
  if (isExternalizedToolResult(content)) {
    return { content, externalized: false, originalChars, estimatedTokens };
  }
  if (isToolResultFileRead(toolName, toolInput, config.outputDir)) {
    return { content, externalized: false, originalChars, estimatedTokens };
  }

  const relDir = config.outputDir.replace(/^\/+/, "");
  const absDir = path.resolve(workspace, relDir);
  const workspaceRoot = path.resolve(workspace);
  if (absDir !== workspaceRoot && !absDir.startsWith(workspaceRoot + path.sep)) {
    throw new Error(`toolOutputDir ${config.outputDir} resolves outside the workspace`);
  }

  await fs.mkdir(absDir, { recursive: true });
  const fileName = `${safeToolName(toolName)}-${Date.now()}-${randomBytes(4).toString("hex")}.log`;
  const absPath = path.join(absDir, fileName);
  await fs.writeFile(absPath, content, "utf-8");
  const filePath = path.posix.join(relDir.replace(/\\/g, "/"), fileName);

  return {
    content: formatExternalizedPreview({
      toolName,
      content,
      filePath,
      headChars: config.previewHeadChars,
      tailChars: config.previewTailChars,
    }),
    externalized: true,
    filePath,
    originalChars,
    estimatedTokens,
  };
}
```

- [ ] **Step 6: Make old tool-result clearing skip externalized previews**

In `clearOldToolResults()`, replace:

```ts
if (content.startsWith("[older tool result cleared")) return m;
```

with:

```ts
if (content.startsWith("[older tool result cleared")) return m;
if (isExternalizedToolResult(content)) return m;
```

- [ ] **Step 7: Run tests and build**

Run:

```bash
bun test src/lib/compaction.test.ts
bun run build
```

Expected: tests PASS; build exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/compaction.ts src/lib/compaction.test.ts
git commit -m "Add tool output externalization helpers" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Agent Integration for Tool Output and Token Budgets

**Files:**
- Modify: `src/lib/agent.ts`
- Test: `src/lib/compaction.test.ts`

**Interfaces:**
- Consumes from Task 1: new config fields on `AgentConfig`.
- Consumes from Task 2: `maybeExternalizeToolResult()` and `ToolOutputBudgetConfig`.
- Produces: large tool results stored as previews in `history`; budget warnings inserted only between model calls.

- [ ] **Step 1: Add tests for summary boundary helpers already available to agent**

Append to `src/lib/compaction.test.ts`:

```ts
import { clearOldToolResults, compactHistory } from "./compaction.js";
import type { ChatMessage } from "./agent.js";

describe("history compaction boundaries", () => {
  test("clearOldToolResults skips externalized previews", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "turn 1" },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "bash",
        content: "abc\n\n[Full bash output saved to .coconut/tool-results/bash-x.log (100 chars, ~25 tokens). Use read_file to inspect the full content. 90 chars omitted from this preview.]\n\nxyz",
      },
      { role: "user", content: "turn 2" },
      { role: "user", content: "turn 3" },
      { role: "user", content: "turn 4" },
      { role: "user", content: "turn 5" },
    ];

    const result = clearOldToolResults(messages, 2);
    expect(result.cleared).toBe(0);
    expect(result.messages[1]?.content).toContain("Full bash output saved to");
  });

  test("compactHistory preserves recent turns and summarizes only older user-boundary history", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old goal" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "recent goal 1" },
      { role: "assistant", content: "recent answer 1" },
      { role: "user", content: "recent goal 2" },
    ];

    const result = await compactHistory({
      messages,
      keepRecentTurns: 2,
      summarize: async (text) => {
        expect(text).toContain("old goal");
        expect(text).not.toContain("recent goal 1");
        return "summary of old goal";
      },
    });

    expect(result.removed).toBe(2);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toContain("summary of old goal");
    expect(result.messages.at(-1)?.content).toBe("recent goal 2");
  });
});
```

- [ ] **Step 2: Run tests**

Run:

```bash
bun test src/lib/compaction.test.ts
```

Expected: PASS after Task 2.

- [ ] **Step 3: Extend `AgentConfig` and imports**

In `src/lib/agent.ts`, update imports from `compaction.ts` to include:

```ts
maybeExternalizeToolResult,
type ToolOutputBudgetConfig,
```

Extend `AgentConfig` with optional fields:

```ts
toolOutputExternalizeMinChars?: number;
toolOutputPreviewHeadChars?: number;
toolOutputPreviewTailChars?: number;
toolOutputDir?: string;
tokenBudgetMax?: number;
tokenBudgetWarnRatio?: number;
tokenBudgetHardRatio?: number;
memoryInjectionMaxTokens?: number;
```

Add private fields to `Agent`:

```ts
private toolOutputBudget: ToolOutputBudgetConfig;
private tokenBudgetMax: number;
private tokenBudgetWarnRatio: number;
private tokenBudgetHardRatio: number;
private memoryInjectionMaxTokens: number;
```

In the constructor, initialize:

```ts
this.toolOutputBudget = {
  externalizeMinChars: config.toolOutputExternalizeMinChars ?? 12_000,
  previewHeadChars: config.toolOutputPreviewHeadChars ?? 2_000,
  previewTailChars: config.toolOutputPreviewTailChars ?? 1_000,
  outputDir: config.toolOutputDir ?? ".coconut/tool-results",
};
this.tokenBudgetMax = config.tokenBudgetMax ?? 200_000;
this.tokenBudgetWarnRatio = config.tokenBudgetWarnRatio ?? 0.8;
this.tokenBudgetHardRatio = config.tokenBudgetHardRatio ?? 1.0;
this.memoryInjectionMaxTokens = config.memoryInjectionMaxTokens ?? 2_000;
```

- [ ] **Step 4: Add budget helper methods**

In `Agent`, add private methods before `runSummarizer()`:

```ts
private estimatedRunTokens(startTokens: number): number {
  return Math.max(0, this.tokenStats().used - startTokens);
}

private shouldWarnBudget(startTokens: number): boolean {
  return this.estimatedRunTokens(startTokens) >= this.tokenBudgetMax * this.tokenBudgetWarnRatio;
}

private shouldHardStopBudget(startTokens: number): boolean {
  return this.estimatedRunTokens(startTokens) >= this.tokenBudgetMax * this.tokenBudgetHardRatio;
}

private budgetWarningMessage(): ChatMessage {
  return {
    role: "user",
    content:
      `<system-reminder>\n` +
      `You are nearing this turn's token budget. Avoid unnecessary tool calls, summarize what matters, and work toward a final answer.\n` +
      `</system-reminder>`,
  };
}
```

- [ ] **Step 5: Add tool-result externalization method**

In `Agent`, add:

```ts
private async prepareToolResultForHistory(
  name: string,
  input: unknown,
  result: string,
  onInfo?: (msg: string) => void,
): Promise<string> {
  try {
    const prepared = await maybeExternalizeToolResult({
      workspace: this.sandbox.workspace,
      toolName: name,
      toolInput: input,
      content: result,
      config: this.toolOutputBudget,
    });
    if (prepared.externalized && prepared.filePath) {
      onInfo?.(
        `Saved full ${name} output to ${prepared.filePath} (${prepared.originalChars.toLocaleString()} chars, ~${prepared.estimatedTokens.toLocaleString()} tokens)`,
      );
    }
    return prepared.content;
  } catch (e: any) {
    const head = result.slice(0, this.toolOutputBudget.previewHeadChars);
    const tail = this.toolOutputBudget.previewTailChars > 0
      ? result.slice(Math.max(this.toolOutputBudget.previewHeadChars, result.length - this.toolOutputBudget.previewTailChars))
      : "";
    const omitted = Math.max(0, result.length - head.length - tail.length);
    const note = `[Tool output persistence failed: ${e?.message ?? e}. Showing bounded preview; ${omitted} chars omitted.]`;
    return tail ? `${head}\n\n${note}\n\n${tail}` : `${head}\n\n${note}`;
  }
}
```

- [ ] **Step 6: Integrate budget checks in `send()`**

In `send()`, after pushing the user message, add:

```ts
const turnStartTokens = this.tokenStats().used;
let budgetWarningInjected = false;
let hardStopped = false;
```

At the top of the `for (let iter = 0; iter < this.maxIterations; iter++)` loop, before `const response = await this.chatComplete(this.history);`, add:

```ts
if (this.shouldHardStopBudget(turnStartTokens)) {
  hardStopped = true;
  events.onInfo?.("Token budget hard stop reached; asking for a final answer without more tool calls.");
  this.history.push({
    role: "user",
    content:
      `<system-reminder>\n` +
      `This turn has reached its token budget. Do not call tools. Provide the best final answer from the current context, including any limitations.\n` +
      `</system-reminder>`,
  });
  const response = await this.chatComplete(this.history);
  const choice = response.choices[0];
  if (choice?.message.content) events.onText(choice.message.content);
  if (choice) {
    this.history.push({ role: "assistant", content: choice.message.content ?? "" });
  }
  break;
}

if (!budgetWarningInjected && this.shouldWarnBudget(turnStartTokens)) {
  budgetWarningInjected = true;
  this.history.push(this.budgetWarningMessage());
  events.onInfo?.("Token budget warning injected; asking Coconut to converge.");
}
```

After the loop and before `events.onDone();`, add:

```ts
if (hardStopped) {
  events.onInfo?.("Stopped additional tool work because the run token budget was exhausted.");
}
```

- [ ] **Step 7: Integrate externalization for successful and failed tool results**

In the successful tool execution block, replace:

```ts
events.onToolResult(name, result, false);
this.history.push({
  role: "tool",
  tool_call_id: call.id,
  name,
  content: result,
});
```

with:

```ts
const historyContent = await this.prepareToolResultForHistory(
  name,
  input,
  result,
  events.onInfo,
);
events.onToolResult(name, historyContent, false);
this.history.push({
  role: "tool",
  tool_call_id: call.id,
  name,
  content: historyContent,
});
```

In the catch block for tool errors, replace the pushed `content: `Error: ${msg}`` with:

```ts
const errorContent = await this.prepareToolResultForHistory(
  name,
  input,
  `Error: ${msg}`,
  events.onInfo,
);
events.onToolResult(name, errorContent, true);
this.history.push({
  role: "tool",
  tool_call_id: call.id,
  name,
  content: errorContent,
});
```

Remove the earlier `events.onToolResult(name, msg, true);` from that catch block so the UI receives only the prepared content once.

- [ ] **Step 8: Run tests and build**

Run:

```bash
bun test src/lib/compaction.test.ts
bun run build
```

Expected: tests PASS; build exits 0.

- [ ] **Step 9: Commit**

```bash
git add src/lib/agent.ts src/lib/compaction.test.ts
git commit -m "Integrate tool output and token budgets" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Ignore Runtime Artifacts and Update Documentation

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `coconut.config.example.json`

**Interfaces:**
- Consumes: config fields from Task 1.
- Consumes: `.coconut/tool-results/` runtime behavior from Tasks 2-3.
- Produces: user-facing documentation for the implemented and reserved layers.

- [ ] **Step 1: Update `.gitignore`**

Append to `.gitignore` after Coconut config ignores:

```gitignore

# Coconut runtime artifacts
.coconut/
```

- [ ] **Step 2: Update README feature bullet**

In `README.md`, replace the context compression feature bullet with:

```md
- 🗜️ Context compression — layered pipeline with tool-output externalization, old-result clearing, LLM summarization, and run-level token budget warnings when conversations approach the context window
```

- [ ] **Step 3: Replace README context compression section**

Replace the current `## Context compression` section content up to `## Sandbox` with:

```md
## Context compression

Coding agents burn through context fast — tool outputs, file contents, long stack traces. Coconut uses a DeerFlow-inspired layered compression strategy while staying provider-neutral and OpenAI-compatible.

1. **Token estimation** — every message in history is measured with a lightweight mixed ASCII/CJK heuristic. The TUI header shows `tokens: 12.3K / 64K (19%)`, color-coded green → yellow → red as you approach the threshold.
2. **Tool output budget** — large tool results are saved under `.coconut/tool-results/`. The conversation keeps only a head/tail preview with the saved file path. Use `read_file` on that path when the full output is needed.
3. **Cheap history cleanup** — older bulky `tool` payloads are replaced with placeholders while preserving `tool_call_id` linkage so the message sequence remains valid.
4. **LLM summarization** — if usage is still over threshold, history older than the last `keepRecentTurns` user turns is summarized into a single anchor message. The summary preserves goals, files, decisions, current state, pending work, user preferences, and important externalized output paths.
5. **Run token budget** — each user turn has a run-level estimated token budget. Coconut injects a warning when the turn approaches the budget and stops additional tool work at the hard limit so it can converge instead of looping forever.
6. **Manual override** — `/compact` runs the full compression pipeline immediately regardless of threshold.

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

  "memoryInjectionMaxTokens": 2000
}
```

> Token counts are heuristic, not provider-billed counts. They are intentionally provider-independent so Coconut can work with any OpenAI-compatible endpoint.
>
> `.coconut/` contains runtime artifacts and is ignored by git. Tool-result files are not deleted automatically in this phase.
```

- [ ] **Step 4: Verify example config includes all keys**

Ensure `coconut.config.example.json` contains:

```json
  "toolOutputExternalizeMinChars": 12000,
  "toolOutputPreviewHeadChars": 2000,
  "toolOutputPreviewTailChars": 1000,
  "toolOutputDir": ".coconut/tool-results",

  "tokenBudgetMax": 200000,
  "tokenBudgetWarnRatio": 0.8,
  "tokenBudgetHardRatio": 1.0,

  "memoryInjectionMaxTokens": 2000,
```

- [ ] **Step 5: Run docs-adjacent build check**

Run:

```bash
bun run build
```

Expected: build exits 0.

- [ ] **Step 6: Commit**

```bash
git add .gitignore README.md coconut.config.example.json
git commit -m "Document layered context compression" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: End-to-End Verification and Push

**Files:**
- No planned source changes unless verification reveals a defect.

**Interfaces:**
- Consumes: all tasks.
- Produces: verified branch pushed to remote.

- [ ] **Step 1: Run full test suite**

Run:

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 2: Run production build**

Run:

```bash
bun run build
```

Expected: build exits 0 and updates/creates `dist/coconut.js` only if build output is tracked by the project. If `dist/` is ignored, do not add it.

- [ ] **Step 3: Manual smoke test for config display**

Run without an API key to inspect startup config error safely:

```bash
env -u COCONUT_API_KEY -u DEEPSEEK_API_KEY bun run src/index.tsx
```

Expected: exits with “No API key found” and prints config fields without leaking any secret. Confirm new budget fields appear in the displayed config.

- [ ] **Step 4: Manual smoke test for externalization helper through tests**

Run:

```bash
bun test src/lib/compaction.test.ts --timeout 10000
```

Expected: PASS and no leftover test directories under `/tmp` with prefix `coconut-compaction-test-`.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: clean working tree. If expected untracked runtime files exist under `.coconut/`, they should be ignored and not shown.

- [ ] **Step 6: Push branch**

Run:

```bash
git push
```

Expected: branch pushes to `origin/context-compression-strategy`.

- [ ] **Step 7: Final summary**

Report:

```md
Implemented Coconut context compression phase 1:
- Tool outputs over threshold externalize to `.coconut/tool-results/` with bounded previews.
- Summaries preserve goals/files/decisions/state/preferences and externalized output references.
- Run token budget warning/hard-stop guard added.
- Config, example config, README, and `.gitignore` updated.
- Verification: `bun test` PASS, `bun run build` PASS.
- Branch pushed: `context-compression-strategy`.
```

---

## Self-Review Notes

- Spec coverage: Tasks 1-4 cover config, tool output externalization, summarization helper behavior, token budget safety net, `.gitignore`, example config, and README. Memory/dynamic-context boundaries are represented by `memoryInjectionMaxTokens` and static-system/no-provider-migration constraints.
- Placeholder scan: no `TBD`, `TODO`, or “implement later” instructions remain.
- Type consistency: config field names match across `ConfigSchema`, `ResolvedConfig`, `AgentConfig`, `App` props, example config, and docs.
