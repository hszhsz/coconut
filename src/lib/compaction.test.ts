import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  estimateTokens,
  isExternalizedToolResult,
  maybeExternalizeToolResult,
} from "./compaction.js";

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
