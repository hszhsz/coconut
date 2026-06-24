import type { ToolDefinition } from "../lib/types.js";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file from the sandbox workspace. Returns the file contents as a string. Use this to inspect source code, config files, etc.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the file, relative to the workspace root (or absolute, but must be inside the workspace).",
      },
    },
    required: ["path"],
  },
  execute: async ({ path: p }: { path: string }, sandbox) => {
    const content = await sandbox.readFile(p);
    const lines = content.split("\n");
    if (lines.length > 2000) {
      return (
        lines.slice(0, 2000).join("\n") +
        `\n\n[... truncated: file has ${lines.length} lines, showing first 2000]`
      );
    }
    return content;
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file in the sandbox workspace. Creates parent directories if needed. Overwrites existing files.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path to the file to write.",
      },
      content: {
        type: "string",
        description: "The content to write to the file.",
      },
    },
    required: ["path", "content"],
  },
  execute: async (
    { path: p, content }: { path: string; content: string },
    sandbox,
  ) => {
    await sandbox.writeFile(p, content);
    return `Wrote ${content.length} characters to ${p}`;
  },
};

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description:
    "List files and directories in a workspace path. Returns a newline-separated list. Defaults to the workspace root.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative directory path. Defaults to '.'.",
      },
    },
  },
  execute: async ({ path: p = "." }: { path?: string }, sandbox) => {
    const entries = await sandbox.readDir(p);
    return entries.join("\n") || "(empty)";
  },
};

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command inside the sandbox. Returns combined stdout and stderr with the exit code. Use for builds, tests, git, package management. Avoid long-running or interactive commands (30s timeout).",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
    },
    required: ["command"],
  },
  execute: async ({ command }: { command: string }, sandbox) => {
    const res = await sandbox.exec(command, {
      timeoutMs: 30_000,
      maxOutputBytes: 8192,
    });
    const trailer = res.truncated ? "\n[... output truncated]" : "";
    return `[exit ${res.exitCode}]\n${res.output || "(no output)"}${trailer}`;
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Replace an exact string in a file with a new string. The old_string must appear exactly once in the file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path to the file." },
      old_string: {
        type: "string",
        description: "Exact string to find (must be unique in file).",
      },
      new_string: {
        type: "string",
        description: "String to replace it with.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: async (
    {
      path: p,
      old_string,
      new_string,
    }: { path: string; old_string: string; new_string: string },
    sandbox,
  ) => {
    const content = await sandbox.readFile(p);
    const count = content.split(old_string).length - 1;
    if (count === 0) {
      throw new Error(`old_string not found in ${p}`);
    }
    if (count > 1) {
      throw new Error(
        `old_string appears ${count} times in ${p}; must be unique`,
      );
    }
    const updated = content.replace(old_string, new_string);
    await sandbox.writeFile(p, updated);
    return `Edited ${p}`;
  },
};

export const allTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  bashTool,
  editFileTool,
];

export const toolMap = new Map(allTools.map((t) => [t.name, t]));
