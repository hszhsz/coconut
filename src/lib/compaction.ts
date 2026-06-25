import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ChatMessage } from "./agent.js";

/**
 * Heuristic token estimator.
 * - Non-CJK: ~4 chars/token (standard OpenAI/DeepSeek BPE approximation)
 * - CJK (Chinese/Japanese/Korean): ~2 chars/token
 * Within ~15% of actual count for typical mixed traffic — accurate enough
 * to drive compression decisions without bundling a tokenizer.
 */
export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  const cjk = (s.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const nonCjk = s.length - cjk;
  return Math.ceil(cjk / 2 + nonCjk / 4);
}

const PER_MESSAGE_OVERHEAD = 5;
const PER_TOOL_CALL_OVERHEAD = 5;

export function estimateMessageTokens(m: ChatMessage): number {
  let t = PER_MESSAGE_OVERHEAD;
  if (m.content) t += estimateTokens(m.content);
  if (m.name) t += estimateTokens(m.name);
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      t += PER_TOOL_CALL_OVERHEAD;
      t += estimateTokens(tc.function.name);
      t += estimateTokens(tc.function.arguments);
    }
  }
  return t;
}

export function estimateHistoryTokens(msgs: ChatMessage[]): number {
  let total = 0;
  for (const m of msgs) total += estimateMessageTokens(m);
  return total;
}

/** Token budget summary for UI display. */
export interface TokenStats {
  used: number;
  window: number;
  ratio: number;
}

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

function isToolResultFileRead(
  toolName: string,
  toolInput: unknown,
  outputDir: string,
): boolean {
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
  const tail =
    tailChars > 0
      ? content.slice(Math.max(headChars, content.length - tailChars))
      : "";
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

/**
 * Replace large `role:"tool"` result contents older than `keepRecentToolTurns`
 * user turns ago with a short placeholder. Keeps `tool_call_id` linkage so the
 * conversation stays structurally valid; just drops the bulky payload.
 *
 * "Turn N" = everything from user message N up to (but not including) user
 * message N+1. With `keepRecentToolTurns=2` and 5 user turns, turns 4 & 5 are
 * kept verbatim; tool results in turns 1-3 are placeholdered.
 *
 * This is the cheap first-line technique — no LLM call.
 */
export function clearOldToolResults(
  msgs: ChatMessage[],
  keepRecentToolTurns: number,
): { messages: ChatMessage[]; cleared: number; savedTokens: number } {
  // Walk forward, assigning each message a turn number (starting at 1 on the
  // first user message; messages before any user message are turn 0).
  const totalUserTurns = msgs.reduce(
    (n, m) => n + (m.role === "user" ? 1 : 0),
    0,
  );
  const oldestKeptTurn = Math.max(1, totalUserTurns - keepRecentToolTurns + 1);

  let currentTurn = 0;
  const ageByIndex: boolean[] = new Array(msgs.length).fill(false);
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.role === "user") currentTurn++;
    if (currentTurn < oldestKeptTurn) ageByIndex[i] = true;
  }

  let cleared = 0;
  let savedTokens = 0;
  const PLACEHOLDER = (size: number) =>
    `[older tool result cleared to save context — was ${size} chars]`;

  const out: ChatMessage[] = msgs.map((m, i) => {
    if (!ageByIndex[i]) return m;
    if (m.role !== "tool") return m;
    const content = m.content ?? "";
    // Skip already-cleared, externalized, or trivially small results.
    if (content.startsWith("[older tool result cleared")) return m;
    if (isExternalizedToolResult(content)) return m;
    if (content.length < 200) return m;
    cleared++;
    const before = estimateTokens(content);
    const placeholder = PLACEHOLDER(content.length);
    savedTokens += before - estimateTokens(placeholder);
    return { ...m, content: placeholder };
  });

  return { messages: out, cleared, savedTokens };
}

/**
 * Compact older history into a single LLM-generated summary message,
 * keeping the last `keepRecentTurns` user-turn worth of messages verbatim.
 *
 * The split lands cleanly on user-message boundaries so tool_call/tool_result
 * pairs are never severed.
 */
export async function compactHistory(opts: {
  messages: ChatMessage[];
  keepRecentTurns: number;
  summarize: (conversationText: string) => Promise<string>;
}): Promise<{
  messages: ChatMessage[];
  summary: string;
  savedTokens: number;
  removed: number;
}> {
  const { messages, keepRecentTurns, summarize } = opts;

  // Collect indices of user messages, newest first.
  const userIndicesFromEnd: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") userIndicesFromEnd.push(i);
  }

  // Need strictly more than keepRecentTurns user turns to have something
  // worth summarizing.
  if (userIndicesFromEnd.length <= keepRecentTurns) {
    return { messages, summary: "", savedTokens: 0, removed: 0 };
  }

  // Split at the K-th-from-last user message. Everything from that index
  // onward stays verbatim; everything before is the "old" part to summarize.
  const splitAt = userIndicesFromEnd[keepRecentTurns - 1]!;
  if (splitAt === 0) {
    return { messages, summary: "", savedTokens: 0, removed: 0 };
  }

  const oldPart = messages.slice(0, splitAt);
  const recentPart = messages.slice(splitAt);

  // Render `oldPart` as text the summarizer can read.
  const conversationText = oldPart.map(formatForSummary).join("\n\n");

  const summary = await summarize(conversationText);

  const summaryMsg: ChatMessage = {
    role: "user",
    content:
      `<previous_conversation_summary>\n${summary}\n</previous_conversation_summary>\n\n` +
      `The above summarizes earlier turns of this conversation that were compacted to save context. Treat it as context, not as a new request.`,
  };

  const oldTokens = estimateHistoryTokens(oldPart);
  const newTokens = estimateMessageTokens(summaryMsg);

  return {
    messages: [summaryMsg, ...recentPart],
    summary,
    savedTokens: Math.max(0, oldTokens - newTokens),
    removed: oldPart.length,
  };
}

function formatForSummary(m: ChatMessage): string {
  const content = (m.content ?? "").trim();
  switch (m.role) {
    case "user":
      return `[user]: ${content}`;
    case "assistant": {
      const parts: string[] = [];
      if (content) parts.push(`[assistant]: ${content}`);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          parts.push(
            `  → call tool \`${tc.function.name}(${truncate(tc.function.arguments, 200)})\``,
          );
        }
      }
      return parts.join("\n") || "[assistant]: (empty)";
    }
    case "tool":
      return `[tool: ${m.name ?? "?"}]:\n${indent(truncate(content, 1200), "  ")}`;
    case "system":
      return `[system]: ${content}`;
    default:
      return `[${m.role}]: ${content}`;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `... [truncated ${s.length - n} chars]`;
}

function indent(s: string, prefix: string): string {
  return s
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

export const SUMMARIZATION_SYSTEM_PROMPT = `You are compressing a conversation between a user and a coding assistant so the assistant can continue working without losing context.

Produce a dense, structured summary covering:

1. **Goal** — what the user is trying to accomplish (overall, not just the last message)
2. **Files & symbols** — paths, function/class names, line numbers that have been read, modified, or referenced
3. **Decisions & approaches tried** — including failed attempts and the reasons they failed
4. **Current state** — what's been done, what's in progress, what's pending
5. **User preferences** — any style, naming, or tooling preferences expressed
6. **Externalized tool outputs** — saved .coconut/tool-results paths that may still matter, with why they matter

Use markdown bullet points. Be specific — preserve exact names, paths, and identifiers. Drop pleasantries, meta-commentary, and verbose tool outputs that aren't load-bearing. Keep under 600 words.

Do not include any text outside the summary.`;

export interface ToolResultRetentionStats {
  removedFiles: number;
  remainingFiles: number;
  remainingBytes: number;
}

/**
 * Bound the externalized tool-result directory by file count and total bytes.
 * Oldest files (by mtime) are removed first until both limits are satisfied.
 * Missing directory is a no-op. Only operates inside the workspace.
 */
export async function pruneToolResults(opts: {
  workspace: string;
  outputDir: string;
  maxFiles: number;
  maxBytes: number;
}): Promise<ToolResultRetentionStats> {
  const { workspace, outputDir, maxFiles, maxBytes } = opts;
  const root = path.resolve(workspace);
  const relDir = outputDir.replace(/^\/+/, "");
  const absDir = path.resolve(root, relDir);
  if (absDir !== root && !absDir.startsWith(root + path.sep)) {
    throw new Error(`toolOutputDir ${outputDir} resolves outside the workspace`);
  }

  let dirents;
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return { removedFiles: 0, remainingFiles: 0, remainingBytes: 0 };
    }
    throw e;
  }

  const files: { abs: string; size: number; mtimeMs: number }[] = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const abs = path.join(absDir, d.name);
    try {
      const st = await fs.stat(abs);
      files.push({ abs, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* skip unreadable file */
    }
  }

  // Oldest first.
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalBytes = files.reduce((n, f) => n + f.size, 0);
  let count = files.length;
  let removedFiles = 0;

  for (const f of files) {
    if (count <= maxFiles && totalBytes <= maxBytes) break;
    try {
      await fs.rm(f.abs);
      removedFiles++;
      count--;
      totalBytes -= f.size;
    } catch {
      /* skip undeletable file */
    }
  }

  return {
    removedFiles,
    remainingFiles: count,
    remainingBytes: totalBytes,
  };
}
