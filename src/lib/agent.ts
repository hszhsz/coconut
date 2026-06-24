import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "./types.js";
import { allTools, toolMap } from "../tools/index.js";

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

export interface AgentEvents {
  onText: (text: string) => void;
  onToolUse: (name: string, input: any) => void;
  onToolResult: (name: string, result: string, isError: boolean) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export class Agent {
  private client: Anthropic;
  private model: string;
  private history: MessageParam[] = [];

  constructor(apiKey: string, model = "claude-sonnet-4-6") {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  getHistoryLength() {
    return this.history.length;
  }

  reset() {
    this.history = [];
  }

  async send(userMessage: string, events: AgentEvents): Promise<void> {
    this.history.push({ role: "user", content: userMessage });

    try {
      // Agentic loop
      while (true) {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          tools: allTools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
          messages: this.history,
        });

        // Emit text blocks
        for (const block of response.content) {
          if (block.type === "text") {
            events.onText(block.text);
          } else if (block.type === "tool_use") {
            events.onToolUse(block.name, block.input);
          }
        }

        // Append assistant response to history
        this.history.push({ role: "assistant", content: response.content });

        if (response.stop_reason === "end_turn") {
          break;
        }

        if (response.stop_reason === "tool_use") {
          // Execute tools, then loop
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            const tool = toolMap.get(block.name);
            if (!tool) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `Unknown tool: ${block.name}`,
                is_error: true,
              });
              events.onToolResult(
                block.name,
                `Unknown tool: ${block.name}`,
                true,
              );
              continue;
            }
            try {
              const result = await tool.execute(block.input);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: result,
              });
              events.onToolResult(block.name, result, false);
            } catch (e: any) {
              const msg = e?.message || String(e);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `Error: ${msg}`,
                is_error: true,
              });
              events.onToolResult(block.name, msg, true);
            }
          }
          this.history.push({ role: "user", content: toolResults });
          continue;
        }

        // Other stop reasons (max_tokens, refusal, etc.)
        events.onText(`\n[stop_reason: ${response.stop_reason}]`);
        break;
      }

      events.onDone();
    } catch (e: any) {
      events.onError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
