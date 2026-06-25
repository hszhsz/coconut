import type { ToolDefinition } from "./types.js";
import type { Sandbox } from "./sandbox.js";
import { buildMemoryInjection, type MemoryInjectionConfig } from "./memory.js";
import {
  estimateHistoryTokens,
  clearOldToolResults,
  compactHistory,
  maybeExternalizeToolResult,
  SUMMARIZATION_SYSTEM_PROMPT,
  type TokenStats,
  type ToolOutputBudgetConfig,
} from "./compaction.js";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | string;
}

export interface ChatResponse {
  id: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface AgentEvents {
  onText: (text: string) => void;
  onToolUse: (name: string, input: any) => void;
  onToolResult: (name: string, result: string, isError: boolean) => void;
  onInfo?: (msg: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface AgentConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  tools: ToolDefinition[];
  sandbox: Sandbox;
  systemOverride?: string | null;
  maxTokens?: number;
  temperature?: number;
  maxIterations?: number;
  contextWindow?: number;
  compressionThreshold?: number;
  keepRecentTurns?: number;
  toolOutputExternalizeMinChars?: number;
  toolOutputPreviewHeadChars?: number;
  toolOutputPreviewTailChars?: number;
  toolOutputDir?: string;
  tokenBudgetMax?: number;
  tokenBudgetWarnRatio?: number;
  tokenBudgetHardRatio?: number;
  memoryInjectionMaxTokens?: number;
  memoryDir?: string;
  memoryInjectionGuaranteedCorrectionTokens?: number;
  dynamicContextEnabled?: boolean;
  dynamicContextIncludeDate?: boolean;
}

const SYSTEM_PROMPT_TEMPLATE = (workspace: string, sandboxLabel: string) =>
  `You are Coconut, a concise coding agent running in the user's terminal.

You have access to tools for reading, writing, editing files, listing directories, and running shell commands. All file and shell operations execute inside a sandboxed workspace — you cannot reach the host outside it.

Sandbox: ${sandboxLabel}
Workspace root: ${workspace}

Guidelines:
- Be direct. Skip preambles like "I'll help you with...".
- Use tools to gather context before answering — read files, list directories, run commands.
- For code changes, make the edit then briefly state what you did.
- Prefer edit_file for targeted changes; write_file for new files.
- Use workspace-relative paths in tool calls (e.g. "src/index.ts"), not absolute host paths.
- When the user asks a question, answer it; only modify files when asked.
- Keep responses short. Markdown is okay but no excessive formatting.`;

export class Agent {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private tools: ToolDefinition[];
  private toolMap: Map<string, ToolDefinition>;
  private sandbox: Sandbox;
  private systemPrompt: string;
  private maxTokens: number;
  private temperature: number;
  private maxIterations: number;
  private contextWindow: number;
  private compressionThreshold: number;
  private keepRecentTurns: number;
  private toolOutputBudget: ToolOutputBudgetConfig;
  private tokenBudgetMax: number;
  private tokenBudgetWarnRatio: number;
  private tokenBudgetHardRatio: number;
  private memoryInjectionMaxTokens: number;
  private memoryInjection: MemoryInjectionConfig;
  private dynamicContextEnabled: boolean;
  private dynamicContextIncludeDate: boolean;
  private history: ChatMessage[] = [];

  constructor(config: AgentConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL.replace(/\/+$/, "");
    this.model = config.model;
    this.tools = config.tools;
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]));
    this.sandbox = config.sandbox;
    let prompt = SYSTEM_PROMPT_TEMPLATE(
      config.sandbox.workspace,
      config.sandbox.label,
    );
    if (config.systemOverride && config.systemOverride.trim()) {
      prompt += `\n\nAdditional instructions:\n${config.systemOverride.trim()}`;
    }
    this.systemPrompt = prompt;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.3;
    this.maxIterations = config.maxIterations ?? 15;
    this.contextWindow = config.contextWindow ?? 64_000;
    this.compressionThreshold = config.compressionThreshold ?? 0.7;
    this.keepRecentTurns = config.keepRecentTurns ?? 4;
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
    this.memoryInjection = {
      memoryDir: config.memoryDir ?? ".coconut/memory",
      maxTokens: this.memoryInjectionMaxTokens,
      guaranteedCorrectionTokens:
        config.memoryInjectionGuaranteedCorrectionTokens ?? 500,
    };
    this.dynamicContextEnabled = config.dynamicContextEnabled ?? true;
    this.dynamicContextIncludeDate = config.dynamicContextIncludeDate ?? true;
  }

  reset() {
    this.history = [];
  }

  getHistoryLength() {
    return this.history.length;
  }

  /** Token usage snapshot for UI display. Includes system prompt + history. */
  tokenStats(): TokenStats {
    const used =
      estimateHistoryTokens(this.history) +
      estimateHistoryTokens([
        { role: "system", content: this.systemPrompt },
      ]);
    return { used, window: this.contextWindow, ratio: used / this.contextWindow };
  }

  /**
   * Run the layered compression pipeline if needed.
   *
   *   Stage 1 (cheap, lossy):    clear bulky old tool_result payloads
   *   Stage 2 (expensive, lossy): LLM-summarize the older half of history
   *
   * `mode`:
   *   - "auto":   only run if usage ≥ threshold (called every turn)
   *   - "force":  always run both stages (called by /compact)
   */
  async maybeCompact(
    mode: "auto" | "force",
    onProgress?: (msg: string) => void,
  ): Promise<{
    triggered: boolean;
    toolResultsCleared: number;
    historyCompacted: boolean;
    savedTokens: number;
    before: number;
    after: number;
  }> {
    const beforeStats = this.tokenStats();
    if (mode === "auto" && beforeStats.ratio < this.compressionThreshold) {
      return {
        triggered: false,
        toolResultsCleared: 0,
        historyCompacted: false,
        savedTokens: 0,
        before: beforeStats.used,
        after: beforeStats.used,
      };
    }

    let savedTokens = 0;

    // Stage 1: clear old tool results.
    const cleared = clearOldToolResults(this.history, this.keepRecentTurns);
    if (cleared.cleared > 0) {
      this.history = cleared.messages;
      savedTokens += cleared.savedTokens;
      onProgress?.(
        `Cleared ${cleared.cleared} old tool result${cleared.cleared === 1 ? "" : "s"} (~${cleared.savedTokens} tokens)`,
      );
    }

    // If under threshold now (auto) or always (force), continue to stage 2.
    const midStats = this.tokenStats();
    const needStage2 =
      mode === "force" || midStats.ratio >= this.compressionThreshold;

    let historyCompacted = false;
    if (needStage2) {
      onProgress?.("Summarizing older conversation…");
      const compacted = await compactHistory({
        messages: this.history,
        keepRecentTurns: this.keepRecentTurns,
        summarize: (text) => this.runSummarizer(text),
      });
      if (compacted.removed > 0) {
        this.history = compacted.messages;
        savedTokens += compacted.savedTokens;
        historyCompacted = true;
        onProgress?.(
          `Compacted ${compacted.removed} message${compacted.removed === 1 ? "" : "s"} into summary (~${compacted.savedTokens} tokens saved)`,
        );
      }
    }

    const afterStats = this.tokenStats();
    return {
      triggered: true,
      toolResultsCleared: cleared.cleared,
      historyCompacted,
      savedTokens,
      before: beforeStats.used,
      after: afterStats.used,
    };
  }

  private estimatedRunTokens(startTokens: number): number {
    return Math.max(0, this.tokenStats().used - startTokens);
  }

  private shouldWarnBudget(startTokens: number): boolean {
    return (
      this.estimatedRunTokens(startTokens) >=
      this.tokenBudgetMax * this.tokenBudgetWarnRatio
    );
  }

  private shouldHardStopBudget(startTokens: number): boolean {
    return (
      this.estimatedRunTokens(startTokens) >=
      this.tokenBudgetMax * this.tokenBudgetHardRatio
    );
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
      const tail =
        this.toolOutputBudget.previewTailChars > 0
          ? result.slice(
              Math.max(
                this.toolOutputBudget.previewHeadChars,
                result.length - this.toolOutputBudget.previewTailChars,
              ),
            )
          : "";
      const omitted = Math.max(0, result.length - head.length - tail.length);
      const note = `[Tool output persistence failed: ${e?.message ?? e}. Showing bounded preview; ${omitted} chars omitted.]`;
      return tail ? `${head}\n\n${note}\n\n${tail}` : `${head}\n\n${note}`;
    }
  }

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

  /** Single-shot completion used by the compaction step. No tools, no history. */
  private async runSummarizer(conversationText: string): Promise<string> {
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Summarize the following conversation excerpt so the assistant can keep working:\n\n${conversationText}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Summarizer call failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as ChatResponse;
    const content = json.choices[0]?.message.content?.trim();
    if (!content) throw new Error("Empty summary from model");
    return content;
  }

  private async chatComplete(messages: ChatMessage[]): Promise<ChatResponse> {
    const body = {
      model: this.model,
      messages: [
        { role: "system" as const, content: this.systemPrompt },
        ...messages,
      ],
      tools: this.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
      tool_choice: "auto",
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `LLM API error ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    return (await res.json()) as ChatResponse;
  }

  async send(userMessage: string, events: AgentEvents): Promise<void> {
    this.history.push({ role: "user", content: userMessage });
    await this.injectTurnContext(events);
    const turnStartTokens = this.tokenStats().used;
    let budgetWarningInjected = false;
    let hardStopped = false;
    void this.memoryInjectionMaxTokens;

    try {
      // Check budget *before* the model call. If we're over threshold,
      // run the compression pipeline first so the upcoming request fits.
      const compactResult = await this.maybeCompact("auto", (m) =>
        events.onInfo?.(m),
      );
      if (compactResult.triggered) {
        events.onInfo?.(
          `Context compressed: ${compactResult.before.toLocaleString()} → ${compactResult.after.toLocaleString()} tokens`,
        );
      }

      // Agentic tool-use loop
      // Cap iterations as a safety net
      for (let iter = 0; iter < this.maxIterations; iter++) {
        if (this.shouldHardStopBudget(turnStartTokens)) {
          hardStopped = true;
          events.onInfo?.(
            "Token budget hard stop reached; asking for a final answer without more tool calls.",
          );
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
            this.history.push({
              role: "assistant",
              content: choice.message.content ?? "",
            });
          }
          break;
        }

        if (!budgetWarningInjected && this.shouldWarnBudget(turnStartTokens)) {
          budgetWarningInjected = true;
          this.history.push(this.budgetWarningMessage());
          events.onInfo?.("Token budget warning injected; asking Coconut to converge.");
        }

        const response = await this.chatComplete(this.history);
        const choice = response.choices[0];
        if (!choice) {
          throw new Error("Empty response from LLM");
        }
        const { message, finish_reason } = choice;

        // Emit assistant text (if any)
        if (message.content && message.content.trim()) {
          events.onText(message.content);
        }

        // Append assistant turn to history
        this.history.push({
          role: "assistant",
          content: message.content ?? "",
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        });

        const toolCalls = message.tool_calls ?? [];

        if (toolCalls.length === 0) {
          // No tools requested → done with this turn
          if (finish_reason === "length") {
            events.onText("\n[output truncated: hit max_tokens]");
          }
          break;
        }

        // Execute each tool call
        for (const call of toolCalls) {
          const name = call.function.name;
          let input: any = {};
          try {
            input = call.function.arguments
              ? JSON.parse(call.function.arguments)
              : {};
          } catch {
            input = { _raw: call.function.arguments };
          }

          events.onToolUse(name, input);

          const tool = this.toolMap.get(name);
          if (!tool) {
            const msg = `Unknown tool: ${name}`;
            events.onToolResult(name, msg, true);
            this.history.push({
              role: "tool",
              tool_call_id: call.id,
              name,
              content: msg,
            });
            continue;
          }

          try {
            const result = await tool.execute(input, this.sandbox);
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
          } catch (e: any) {
            const msg = e?.message || String(e);
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
          }
        }
        // Loop: let the model react to tool results
      }

      if (hardStopped) {
        events.onInfo?.(
          "Stopped additional tool work because the run token budget was exhausted.",
        );
      }
      events.onDone();
    } catch (e: any) {
      events.onError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
