# Context Compression Phase Two Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral dynamic context injection and local memory injection budgeting to Coconut.

**Architecture:** Create a focused `src/lib/memory.ts` module for safe local memory loading, frontmatter parsing, deterministic selection, and budgeted formatting. Wire it into `Agent.send()` once per user turn, before auto-compaction and model/tool loops, while keeping static system prompt construction stable and provider-neutral.

**Tech Stack:** Bun, TypeScript, Node `fs/path`, existing OpenAI-compatible chat completions, existing `ChatMessage` and heuristic token estimator.

## Global Constraints

- Do not implement autonomous memory writes, semantic retrieval, embeddings, external databases, provider-native prompt cache, or SDK migrations.
- Do not change Coconut's OpenAI-compatible `/chat/completions` transport.
- Treat memory as user-influenced context using `role: "user"`, not operator-authority system instructions.
- Inject runtime context and memory at most once per user turn, not per tool-loop iteration.
- Keep memory reads inside workspace; do not follow traversal outside the configured memory directory.
- Use dependency-free frontmatter parsing.
- Use the existing heuristic token estimator for all memory budgets.
- Commit after each task using messages ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

## File Structure

- Create `src/lib/memory.ts`: memory file discovery, frontmatter parsing, budgeted selection, message formatting.
- Create `src/lib/memory.test.ts`: unit tests for memory selection and safety.
- Modify `src/lib/config.ts`: add phase-two config fields and env overrides.
- Modify `src/lib/config.test.ts`: cover new config defaults and project overrides.
- Modify `src/lib/agent.ts`: add dynamic runtime and memory injection once per turn.
- Modify `src/components/App.tsx`: pass new config into `Agent` and expose it in `/tokens` or `/config` via existing config description.
- Modify `src/index.tsx`: pass new config fields to `App`.
- Modify `coconut.config.example.json`: add memory/dynamic context settings.
- Modify `README.md`: document local memory files and dynamic context.

---

### Task 1: Memory Injection Module

**Files:**
- Create: `src/lib/memory.ts`
- Create: `src/lib/memory.test.ts`

**Interfaces:**
- Consumes: `estimateTokens` from `src/lib/compaction.ts`.
- Produces:
  - `MemoryInjectionConfig`
  - `MemoryInjectionResult`
  - `buildMemoryInjection(opts: { workspace: string; config: MemoryInjectionConfig }): Promise<MemoryInjectionResult>`

- [ ] **Step 1: Write failing memory tests**

Create `src/lib/memory.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildMemoryInjection } from "./memory.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coconut-memory-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildMemoryInjection", () => {
  test("missing memory directory returns no message", async () => {
    await withTempDir(async (workspace) => {
      const result = await buildMemoryInjection({
        workspace,
        config: {
          memoryDir: ".coconut/memory",
          maxTokens: 2000,
          guaranteedCorrectionTokens: 500,
        },
      });

      expect(result.message).toBeNull();
      expect(result.included).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.usedTokens).toBe(0);
    });
  });

  test("selects files deterministically by priority then path", async () => {
    await withTempDir(async (workspace) => {
      const dir = path.join(workspace, ".coconut", "memory");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "b.md"), "---\npriority: 1\ntype: preference\n---\nB body");
      await writeFile(path.join(dir, "a.md"), "---\npriority: 1\ntype: preference\n---\nA body");
      await writeFile(path.join(dir, "z.md"), "---\npriority: 5\ntype: project\n---\nZ body");

      const result = await buildMemoryInjection({
        workspace,
        config: {
          memoryDir: ".coconut/memory",
          maxTokens: 2000,
          guaranteedCorrectionTokens: 500,
        },
      });

      expect(result.included).toEqual([
        ".coconut/memory/z.md",
        ".coconut/memory/a.md",
        ".coconut/memory/b.md",
      ]);
      expect(result.message?.content).toContain("## .coconut/memory/z.md");
      expect(result.message?.content).toContain("## .coconut/memory/a.md");
      expect(result.message?.content).toContain("## .coconut/memory/b.md");
    });
  });

  test("guarantees correction memories before ordinary memories", async () => {
    await withTempDir(async (workspace) => {
      const dir = path.join(workspace, ".coconut", "memory");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "ordinary.md"), "---\npriority: 100\ntype: project\n---\nOrdinary body");
      await writeFile(path.join(dir, "correction.md"), "---\npriority: 0\ntype: correction\n---\nCorrection body");

      const result = await buildMemoryInjection({
        workspace,
        config: {
          memoryDir: ".coconut/memory",
          maxTokens: 2000,
          guaranteedCorrectionTokens: 500,
        },
      });

      expect(result.included[0]).toBe(".coconut/memory/correction.md");
      expect(result.message?.content?.indexOf("Correction body")).toBeLessThan(
        result.message?.content?.indexOf("Ordinary body") ?? Number.MAX_SAFE_INTEGER,
      );
    });
  });

  test("truncates oversized memory with explicit marker", async () => {
    await withTempDir(async (workspace) => {
      const dir = path.join(workspace, ".coconut", "memory");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "large.md"), "---\npriority: 1\ntype: project\n---\n" + "x".repeat(2000));

      const result = await buildMemoryInjection({
        workspace,
        config: {
          memoryDir: ".coconut/memory",
          maxTokens: 80,
          guaranteedCorrectionTokens: 20,
        },
      });

      expect(result.message?.content).toContain("[memory truncated");
      expect(result.included).toEqual([".coconut/memory/large.md"]);
    });
  });

  test("rejects memory directory traversal outside workspace", async () => {
    await withTempDir(async (workspace) => {
      await expect(
        buildMemoryInjection({
          workspace,
          config: {
            memoryDir: "../outside",
            maxTokens: 2000,
            guaranteedCorrectionTokens: 500,
          },
        }),
      ).rejects.toThrow("memoryDir must stay inside the workspace");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/lib/memory.test.ts
```

Expected: FAIL because `src/lib/memory.ts` does not exist.

- [ ] **Step 3: Implement memory module**

Create `src/lib/memory.ts` with:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { estimateTokens } from "./compaction.js";
import type { ChatMessage } from "./agent.js";

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

interface MemoryEntry {
  relPath: string;
  absPath: string;
  type: string;
  priority: number;
  body: string;
  isCorrection: boolean;
}

function resolveMemoryDir(workspace: string, memoryDir: string): { abs: string; rel: string } {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, memoryDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("memoryDir must stay inside the workspace");
  }
  return { abs, rel: path.relative(root, abs).replace(/\\/g, "/") || "." };
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: text };
  const raw = text.slice(4, end).trim();
  const body = text.slice(end + "\n---".length).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body };
}

async function collectMemoryFiles(absDir: string, relDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
        out.push(childRel);
      }
    }
  }
  await walk(absDir, relDir);
  return out.sort();
}

function entryTokens(entry: MemoryEntry): number {
  return estimateTokens(`## ${entry.relPath}\n${entry.body}`);
}

function formatEntry(entry: MemoryEntry, maxTokens: number): string {
  const header = `## ${entry.relPath}\n`;
  const full = `${header}${entry.body.trim()}`;
  if (estimateTokens(full) <= maxTokens) return full;
  const maxChars = Math.max(80, maxTokens * 4 - header.length);
  const truncated = entry.body.trim().slice(0, maxChars);
  return `${header}${truncated}\n[memory truncated from ${entry.body.length} chars to fit budget]`;
}

async function loadEntries(workspace: string, absDir: string, relDir: string): Promise<MemoryEntry[]> {
  const files = await collectMemoryFiles(absDir, relDir);
  const root = path.resolve(workspace);
  const entries: MemoryEntry[] = [];
  for (const relPath of files) {
    const absPath = path.resolve(root, relPath);
    if (absPath !== root && !absPath.startsWith(root + path.sep)) continue;
    const text = await fs.readFile(absPath, "utf-8");
    const { meta, body } = parseFrontmatter(text);
    const type = meta.type || "reference";
    const priority = Number.isFinite(Number(meta.priority)) ? Number(meta.priority) : 0;
    entries.push({
      relPath,
      absPath,
      type,
      priority,
      body,
      isCorrection: type === "correction",
    });
  }
  return entries;
}

function selectEntries(entries: MemoryEntry[], maxTokens: number, guaranteedCorrectionTokens: number): MemoryEntry[] {
  const corrections = entries
    .filter((e) => e.isCorrection)
    .sort((a, b) => b.priority - a.priority || a.relPath.localeCompare(b.relPath));
  const ordinary = entries
    .filter((e) => !e.isCorrection)
    .sort((a, b) => b.priority - a.priority || a.relPath.localeCompare(b.relPath));

  const selected: MemoryEntry[] = [];
  let used = 0;
  const correctionBudget = Math.min(maxTokens, Math.max(0, guaranteedCorrectionTokens));

  for (const entry of corrections) {
    const cost = Math.min(entryTokens(entry), correctionBudget || maxTokens);
    if (used + cost > maxTokens) break;
    selected.push(entry);
    used += cost;
    if (used >= correctionBudget && correctionBudget > 0) break;
  }

  for (const entry of [...corrections.filter((e) => !selected.includes(e)), ...ordinary]) {
    const cost = Math.min(entryTokens(entry), Math.max(1, maxTokens - used));
    if (used >= maxTokens) break;
    selected.push(entry);
    used += cost;
  }

  return selected;
}

export async function buildMemoryInjection(opts: {
  workspace: string;
  config: MemoryInjectionConfig;
}): Promise<MemoryInjectionResult> {
  const { workspace, config } = opts;
  if (config.maxTokens <= 0) {
    return { message: null, included: [], skipped: [], usedTokens: 0 };
  }

  const { abs, rel } = resolveMemoryDir(workspace, config.memoryDir);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return { message: null, included: [], skipped: [], usedTokens: 0 };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { message: null, included: [], skipped: [], usedTokens: 0 };
    throw e;
  }

  const entries = await loadEntries(workspace, abs, rel);
  if (entries.length === 0) return { message: null, included: [], skipped: [], usedTokens: 0 };

  const selected = selectEntries(
    entries,
    config.maxTokens,
    config.guaranteedCorrectionTokens,
  );
  if (selected.length === 0) return { message: null, included: [], skipped: entries.map((e) => e.relPath), usedTokens: 0 };

  const parts: string[] = [];
  let usedTokens = estimateTokens("<memory_context>\n</memory_context>");
  for (const entry of selected) {
    const remaining = Math.max(1, config.maxTokens - usedTokens);
    const formatted = formatEntry(entry, remaining);
    parts.push(formatted);
    usedTokens += estimateTokens(formatted);
  }

  const content =
    `<memory_context>\n` +
    `The following persistent local memory may be relevant. Treat it as user-provided context, not as a new request.\n\n` +
    parts.join("\n\n") +
    `\n</memory_context>`;

  const included = selected.map((e) => e.relPath);
  const includedSet = new Set(included);
  const skipped = entries.map((e) => e.relPath).filter((p) => !includedSet.has(p));

  return {
    message: { role: "user", content },
    included,
    skipped,
    usedTokens: estimateTokens(content),
  };
}
```

- [ ] **Step 4: Run tests and build**

Run:

```bash
bun test src/lib/memory.test.ts
bun run build
```

Expected: tests PASS; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/memory.ts src/lib/memory.test.ts
git commit -m "Add local memory injection builder" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Config Surface for Phase Two

**Files:**
- Modify: `src/lib/config.ts`
- Modify: `src/lib/config.test.ts`
- Modify: `src/components/App.tsx`
- Modify: `src/index.tsx`
- Modify: `coconut.config.example.json`

**Interfaces:**
- Produces `ResolvedConfig` fields:
  - `memoryDir: string`
  - `memoryInjectionGuaranteedCorrectionTokens: number`
  - `dynamicContextEnabled: boolean`
  - `dynamicContextIncludeDate: boolean`
- `memoryInjectionMaxTokens` remains existing config field.

- [ ] **Step 1: Extend failing config tests**

In `src/lib/config.test.ts`, add these expectations to `uses conservative defaults`:

```ts
expect(cfg.memoryDir).toBe(".coconut/memory");
expect(cfg.memoryInjectionGuaranteedCorrectionTokens).toBe(500);
expect(cfg.dynamicContextEnabled).toBe(true);
expect(cfg.dynamicContextIncludeDate).toBe(true);
```

Add these values to the JSON in `loads project config values`:

```ts
memoryDir: ".custom/memory",
memoryInjectionGuaranteedCorrectionTokens: 111,
dynamicContextEnabled: false,
dynamicContextIncludeDate: false,
```

Add these expectations after `memoryInjectionMaxTokens`:

```ts
expect(cfg.memoryDir).toBe(".custom/memory");
expect(cfg.memoryInjectionGuaranteedCorrectionTokens).toBe(111);
expect(cfg.dynamicContextEnabled).toBe(false);
expect(cfg.dynamicContextIncludeDate).toBe(false);
```

- [ ] **Step 2: Run config tests to verify failure**

Run:

```bash
bun test src/lib/config.test.ts
```

Expected: FAIL because new config fields are unrecognized/undefined.

- [ ] **Step 3: Add schema/default/resolved fields**

In `src/lib/config.ts`, add to `ConfigSchema`:

```ts
memoryDir: z.string().min(1).optional(),
memoryInjectionGuaranteedCorrectionTokens: z.number().int().min(0).optional(),
dynamicContextEnabled: z.boolean().optional(),
dynamicContextIncludeDate: z.boolean().optional(),
```

Add to `ResolvedConfig`:

```ts
memoryDir: string;
memoryInjectionGuaranteedCorrectionTokens: number;
dynamicContextEnabled: boolean;
dynamicContextIncludeDate: boolean;
```

Add to `DEFAULTS` after `memoryInjectionMaxTokens`:

```ts
memoryDir: ".coconut/memory",
memoryInjectionGuaranteedCorrectionTokens: 500,
dynamicContextEnabled: true,
dynamicContextIncludeDate: true,
```

Add to resolved config after `memoryInjectionMaxTokens`:

```ts
memoryDir: merged.memoryDir ?? DEFAULTS.memoryDir,
memoryInjectionGuaranteedCorrectionTokens:
  merged.memoryInjectionGuaranteedCorrectionTokens ??
  DEFAULTS.memoryInjectionGuaranteedCorrectionTokens,
dynamicContextEnabled:
  merged.dynamicContextEnabled ?? DEFAULTS.dynamicContextEnabled,
dynamicContextIncludeDate:
  merged.dynamicContextIncludeDate ?? DEFAULTS.dynamicContextIncludeDate,
```

- [ ] **Step 4: Add env overrides**

In `envOverrides()`, add:

```ts
if (process.env.COCONUT_MEMORY_DIR) {
  out.memoryDir = process.env.COCONUT_MEMORY_DIR;
}
if (process.env.COCONUT_MEMORY_INJECTION_GUARANTEED_CORRECTION_TOKENS) {
  const n = Number(process.env.COCONUT_MEMORY_INJECTION_GUARANTEED_CORRECTION_TOKENS);
  if (!Number.isInteger(n) || n < 0)
    throw new Error("COCONUT_MEMORY_INJECTION_GUARANTEED_CORRECTION_TOKENS must be a non-negative integer");
  out.memoryInjectionGuaranteedCorrectionTokens = n;
}
if (process.env.COCONUT_DYNAMIC_CONTEXT_ENABLED) {
  out.dynamicContextEnabled = process.env.COCONUT_DYNAMIC_CONTEXT_ENABLED !== "false";
}
if (process.env.COCONUT_DYNAMIC_CONTEXT_INCLUDE_DATE) {
  out.dynamicContextIncludeDate = process.env.COCONUT_DYNAMIC_CONTEXT_INCLUDE_DATE !== "false";
}
```

- [ ] **Step 5: Update display, example, and prop wiring**

In `describeConfig()`, add lines:

```ts
`memoryDir:                    ${cfg.memoryDir}`,
`memoryInjectionGuaranteedCorrectionTokens: ${cfg.memoryInjectionGuaranteedCorrectionTokens}`,
`dynamicContextEnabled:        ${cfg.dynamicContextEnabled}`,
`dynamicContextIncludeDate:    ${cfg.dynamicContextIncludeDate}`,
```

In `EXAMPLE_CONFIG` and `coconut.config.example.json`, add:

```json
"memoryDir": ".coconut/memory",
"memoryInjectionGuaranteedCorrectionTokens": 500,
"dynamicContextEnabled": true,
"dynamicContextIncludeDate": true,
```

In `src/components/App.tsx`, add these props to `Props`, destructuring, and `new Agent({ ... })`:

```ts
memoryDir: string;
memoryInjectionGuaranteedCorrectionTokens: number;
dynamicContextEnabled: boolean;
dynamicContextIncludeDate: boolean;
```

In `src/index.tsx`, pass:

```tsx
memoryDir={cfg!.memoryDir}
memoryInjectionGuaranteedCorrectionTokens={cfg!.memoryInjectionGuaranteedCorrectionTokens}
dynamicContextEnabled={cfg!.dynamicContextEnabled}
dynamicContextIncludeDate={cfg!.dynamicContextIncludeDate}
```

- [ ] **Step 6: Run tests and build**

Run:

```bash
bun test src/lib/config.test.ts
bun run build
```

Expected: tests PASS; build exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/config.ts src/lib/config.test.ts src/components/App.tsx src/index.tsx coconut.config.example.json
git commit -m "Add dynamic context and memory config" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Agent Dynamic Context and Memory Injection

**Files:**
- Modify: `src/lib/agent.ts`
- Test: `src/lib/memory.test.ts`

**Interfaces:**
- Consumes: `buildMemoryInjection()` from `src/lib/memory.ts`.
- Consumes: config fields from Task 2.
- Produces: `Agent.send()` injects runtime and memory context once per turn.

- [ ] **Step 1: Add runtime context formatting testable helper by behavior**

Append this test to `src/lib/memory.test.ts` to validate memory message shape used by agent:

```ts
test("formats memory context as user-role context rather than a new request", async () => {
  await withTempDir(async (workspace) => {
    const dir = path.join(workspace, ".coconut", "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "note.md"), "---\ntype: project\npriority: 1\n---\nRemember the project goal.");

    const result = await buildMemoryInjection({
      workspace,
      config: {
        memoryDir: ".coconut/memory",
        maxTokens: 2000,
        guaranteedCorrectionTokens: 500,
      },
    });

    expect(result.message?.role).toBe("user");
    expect(result.message?.content).toContain("<memory_context>");
    expect(result.message?.content).toContain("Treat it as user-provided context, not as a new request");
  });
});
```

- [ ] **Step 2: Run tests**

Run:

```bash
bun test src/lib/memory.test.ts
```

Expected: PASS after Task 1.

- [ ] **Step 3: Import memory builder and extend AgentConfig**

In `src/lib/agent.ts`, add:

```ts
import { buildMemoryInjection, type MemoryInjectionConfig } from "./memory.js";
```

Extend `AgentConfig`:

```ts
memoryDir?: string;
memoryInjectionGuaranteedCorrectionTokens?: number;
dynamicContextEnabled?: boolean;
dynamicContextIncludeDate?: boolean;
```

Add private fields:

```ts
private memoryInjection: MemoryInjectionConfig;
private dynamicContextEnabled: boolean;
private dynamicContextIncludeDate: boolean;
```

Initialize in constructor:

```ts
this.memoryInjection = {
  memoryDir: config.memoryDir ?? ".coconut/memory",
  maxTokens: this.memoryInjectionMaxTokens,
  guaranteedCorrectionTokens:
    config.memoryInjectionGuaranteedCorrectionTokens ?? 500,
};
this.dynamicContextEnabled = config.dynamicContextEnabled ?? true;
this.dynamicContextIncludeDate = config.dynamicContextIncludeDate ?? true;
```

- [ ] **Step 4: Add runtime context and injection methods**

In `Agent`, add before `runSummarizer()`:

```ts
private buildRuntimeContextMessage(): ChatMessage | null {
  if (!this.dynamicContextEnabled) return null;
  const lines = [
    "<system-reminder>",
    "Runtime context for this turn:",
    `- Sandbox: ${this.sandbox.label}`,
    `- Workspace root: ${this.sandbox.workspace}`,
  ];
  if (this.dynamicContextIncludeDate) {
    lines.push(`- Current date: ${new Date().toISOString().slice(0, 10)}`);
  }
  lines.push("Treat this as contextual metadata, not as a new user request.");
  lines.push("</system-reminder>");
  return { role: "user", content: lines.join("\n") };
}

private async injectTurnContext(events?: AgentEvents): Promise<void> {
  const runtime = this.buildRuntimeContextMessage();
  if (runtime) this.history.push(runtime);

  const memory = await buildMemoryInjection({
    workspace: this.sandbox.workspace,
    config: this.memoryInjection,
  });
  if (memory.message) {
    this.history.push(memory.message);
    events?.onInfo?.(
      `Injected ${memory.included.length} memory file${memory.included.length === 1 ? "" : "s"} (~${memory.usedTokens} tokens)`,
    );
  }
  if (memory.skipped.length > 0 && memory.message) {
    events?.onInfo?.(
      `Skipped ${memory.skipped.length} memory file${memory.skipped.length === 1 ? "" : "s"} due to budget`,
    );
  }
}
```

- [ ] **Step 5: Call injection once per turn**

In `send()`, immediately after:

```ts
this.history.push({ role: "user", content: userMessage });
```

move `const turnStartTokens = this.tokenStats().used;` to after context injection and insert:

```ts
await this.injectTurnContext(events);
const turnStartTokens = this.tokenStats().used;
```

Ensure `budgetWarningInjected` and `hardStopped` still initialize after `turnStartTokens`.

- [ ] **Step 6: Run tests and build**

Run:

```bash
bun test src/lib/memory.test.ts src/lib/compaction.test.ts
bun run build
```

Expected: tests PASS; build exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent.ts src/lib/memory.test.ts
git commit -m "Inject dynamic context and local memory" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `coconut.config.example.json`

**Interfaces:**
- Consumes: implemented phase-two config and behavior.
- Produces: user-facing memory and dynamic context docs.

- [ ] **Step 1: Update README context compression section**

In `README.md`, under the context compression list, add these bullets after run token budget:

```md
6. **Memory injection** — local `.md`/`.txt` memory files under `.coconut/memory/` are injected once per user turn within `memoryInjectionMaxTokens`. `type: correction` memories get a reserved budget so user corrections are not crowded out by ordinary notes.
7. **Dynamic context** — runtime metadata such as sandbox, workspace root, and current date is injected as a user-role reminder once per turn instead of being baked into the static system prompt.
```

Renumber manual override to `8.`.

Add this subsection after the config block:

```md
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
```

- [ ] **Step 2: Update command docs for `/tokens` if needed**

If `/tokens` output now mentions run budget but not memory, leave it as-is. Memory configuration is visible through `/config`, so no command-table change is required.

- [ ] **Step 3: Run all tests and build**

Run:

```bash
bun test
bun run build
```

Expected: all tests PASS; build exits 0.

- [ ] **Step 4: Smoke test config display**

Run:

```bash
env -u COCONUT_API_KEY -u DEEPSEEK_API_KEY bun run src/index.tsx
```

Expected: exits with “No API key found” and displays `memoryDir`, `memoryInjectionGuaranteedCorrectionTokens`, `dynamicContextEnabled`, and `dynamicContextIncludeDate` without leaking secrets.

- [ ] **Step 5: Commit docs**

```bash
git add README.md coconut.config.example.json
git commit -m "Document local memory injection" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 6: Push branch**

Run:

```bash
git status --short
git push -u origin context-compression-phase-two
```

Expected: clean working tree before push; branch pushed to remote.

---

## Self-Review Notes

- Spec coverage: Tasks implement memory file reading, correction guarantee, deterministic selection, runtime context injection, config, docs, and verification.
- Placeholder scan: no TBD/TODO/fill-in placeholders remain.
- Type consistency: `MemoryInjectionConfig`, config keys, `AgentConfig`, `App` props, and docs use the same names.
