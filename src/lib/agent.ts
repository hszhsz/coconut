import type { ToolDefinition } from "./types.js";

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
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface AgentConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  tools: ToolDefinition[];
}

const SYSTEM_PROMPT = `You are Coconut, a concise coding agent running in the user's terminal.

You have access to tools for reading, writing, editing files, listing directories, and running shell commands. The working directory is the user's current project.

Guidelines:
- Be direct. Skip preambles like "I'll help you with...".
- Use tools to gather context before answering — read files, list directories, run commands.
- For code changes, make the edit then briefly state what you did.
- Prefer edit_file for targeted changes; write_file for new files.
- When the user asks a question, answer it; only modify files when asked.
- Keep responses short. Markdown is okay but no excessive formatting.

Current working directory: ${process.cwd()}`;

export class Agent {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private tools: ToolDefinition[];
  private toolMap: Map<string, ToolDefinition>;
  private history: ChatMessage[] = [];

  constructor(config: AgentConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL.replace(/\/+$/, "");
    this.model = config.model;
    this.tools = config.tools;
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]));
  }

  reset() {
    this.history = [];
  }

  getHistoryLength() {
    return this.history.length;
  }

  private async chatComplete(messages: ChatMessage[]): Promise<ChatResponse> {
    const body = {
      model: this.model,
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
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
      temperature: 0.3,
      max_tokens: 4096,
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

    try {
      // Agentic tool-use loop
      // Cap iterations as a safety net
      for (let iter = 0; iter < 15; iter++) {
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
            const result = await tool.execute(input);
            events.onToolResult(name, result, false);
            this.history.push({
              role: "tool",
              tool_call_id: call.id,
              name,
              content: result,
            });
          } catch (e: any) {
            const msg = e?.message || String(e);
            events.onToolResult(name, msg, true);
            this.history.push({
              role: "tool",
              tool_call_id: call.id,
              name,
              content: `Error: ${msg}`,
            });
          }
        }
        // Loop: let the model react to tool results
      }

      events.onDone();
    } catch (e: any) {
      events.onError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
