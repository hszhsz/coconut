import type { ChatMessage } from "./agent.js";

/**
 * Heuristic token estimator.
 * - Non-CJK: ~4 chars/token (standard OpenAI/DeepSeek BPE approximation)
 * - CJK (Chinese/Japanese/Korean): ~1 char/token
 * Within ~15% of actual count for typical mixed traffic — accurate enough
 * to drive compression decisions without bundling a tokenizer.
 */
export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  const cjk = (s.match(/[一-鿿぀-ヿ가-힯]/g) || [])
    .length;
  const nonCjk = s.length - cjk;
  return Math.ceil(cjk + nonCjk / 4);
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
    // Skip already-cleared or trivially small results.
    if (content.startsWith("[older tool result cleared")) return m;
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

Use markdown bullet points. Be specific — preserve exact names, paths, and identifiers. Drop pleasantries, meta-commentary, and verbose tool outputs that aren't load-bearing. Keep under 600 words.

Do not include any text outside the summary.`;
