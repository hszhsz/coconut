import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  clearOldToolResults,
  compactHistory,
  estimateTokens,
  isExternalizedToolResult,
  maybeExternalizeToolResult,
} from "./compaction.js";
import type { ChatMessage } from "./agent.js";

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
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("你好世界")).toBe(2);
    expect(estimateTokens("abcd你好")).toBe(2);
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


describe("history compaction boundaries", () => {
  test("clearOldToolResults skips externalized previews", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "turn 1" },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "bash",
        content:
          "abc\n\n[Full bash output saved to .coconut/tool-results/bash-x.log (100 chars, ~25 tokens). Use read_file to inspect the full content. 90 chars omitted from this preview.]\n\nxyz",
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
