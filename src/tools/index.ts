import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ToolDefinition } from "../lib/types.js";

const CWD = process.cwd();

function resolveSafe(target: string): string {
  const abs = path.isAbsolute(target) ? target : path.resolve(CWD, target);
  // Allow paths under CWD only — basic safety
  return abs;
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file from the local filesystem. Returns the file contents as a string. Use this to inspect source code, config files, etc.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative or absolute path to the file to read.",
      },
    },
    required: ["path"],
  },
  execute: async ({ path: p }: { path: string }) => {
    const full = resolveSafe(p);
    const content = await fs.readFile(full, "utf-8");
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
    "Write content to a file on the local filesystem. Creates parent directories if needed. Overwrites existing files.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative or absolute path to the file to write.",
      },
      content: {
        type: "string",
        description: "The content to write to the file.",
      },
    },
    required: ["path", "content"],
  },
  execute: async ({ path: p, content }: { path: string; content: string }) => {
    const full = resolveSafe(p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
    return `Wrote ${content.length} characters to ${path.relative(CWD, full)}`;
  },
};

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description:
    "List files and directories in a given path. Returns a newline-separated list. Defaults to the current directory.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list. Defaults to current directory.",
      },
    },
  },
  execute: async ({ path: p = "." }: { path?: string }) => {
    const full = resolveSafe(p);
    const entries = await fs.readdir(full, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return lines.join("\n") || "(empty)";
  },
};

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command. Returns combined stdout and stderr. Use for builds, tests, git, package management. Avoid long-running or interactive commands.",
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
  execute: async ({ command }: { command: string }) => {
    return await new Promise<string>((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: CWD,
        env: process.env,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      const timeout = setTimeout(() => {
        child.kill();
        resolve(
          `[Command timed out after 30s]\nstdout:\n${out}\nstderr:\n${err}`,
        );
      }, 30_000);
      child.on("close", (code) => {
        clearTimeout(timeout);
        const combined =
          (out ? out : "") +
          (err ? (out ? "\n--- stderr ---\n" : "") + err : "");
        resolve(
          `[exit ${code}]\n${combined.slice(0, 8000) || "(no output)"}` +
            (combined.length > 8000 ? "\n[... output truncated]" : ""),
        );
      });
    });
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Replace an exact string in a file with a new string. The old_string must appear exactly once in the file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
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
  execute: async ({
    path: p,
    old_string,
    new_string,
  }: {
    path: string;
    old_string: string;
    new_string: string;
  }) => {
    const full = resolveSafe(p);
    const content = await fs.readFile(full, "utf-8");
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
    await fs.writeFile(full, updated, "utf-8");
    return `Edited ${path.relative(CWD, full)}`;
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
