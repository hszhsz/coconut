export type Role = "user" | "assistant" | "system";

export interface DisplayMessage {
  id: string;
  role: Role | "tool" | "tool_result" | "error";
  content: string;
  toolName?: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (input: any) => Promise<string>;
}
