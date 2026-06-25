import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildMemoryInjection } from "./memory.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coconut-memory-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildMemoryInjection", () => {
  test("missing memory directory returns no message", async () => {
    await withTempDir(async (workspace) => {
      const result = await buildMemoryInjection({
        workspace,
        config: {
          memoryDir: ".coconut/memory",
          maxTokens: 2000,
          guaranteedCorrectionTokens: 500,
        },
      });

      expect(result.message).toBeNull();
      expect(result.included).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.usedTokens).toBe(0);
    });
  });

  test("selects files deterministically by priority then path", async () => {
    await withTempDir(async (workspace) => {
      const dir = path.join(workspace, ".coconut", "memory");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "b.md"), "---\npriority: 1\ntype: preference\n---\nB body");
      await writeFile(path.join(dir, "a.md"), "---\npriority: 1\ntype: preference\n---\nA body");
      await writeFile(path.join(dir, "z.md"), "---\npriority: 5\ntype: project\n---\nZ body");

      const result = await buildMemoryInjection({
        workspace,
        config: {
          memoryDir: ".coconut/memory",
          maxTokens: 2000,
          guaranteedCorrectionTokens: 500,
        },
      });

      expect(result.included).toEqual([
        ".coconut/memory/z.md",
        ".coconut/memory/a.md",
        ".coconut/memory/b.md",
      ]);
      expect(result.message?.content).toContain("## .coconut/memory/z.md");
      expect(result.message?.content).toContain("## .coconut/memory/a.md");
      expect(result.message?.content).toContain("## .coconut/memory/b.md");
    });
  });

  test("guarantees correction memories before ordinary memories", async () => {
    await withTempDir(async (workspace) => {
      const dir = path.join(workspace, ".coconut", "memory");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "ordinary.md"), "---\npriority: 100\ntype: project\n---\nOrdinary body");
      await writeFile(path.join(dir, "correction.md"), "---\npriority: 0\ntype: correction\n---\nCorrection body");

      const result = await buildMemoryInjection({
        workspace,
        config: {
          memoryDir: ".coconut/memory",
          maxTokens: 2000,
          guaranteedCorrectionTokens: 500,
        },
      });

      expect(result.included[0]).toBe(".coconut/memory/correction.md");
      expect(result.message?.content?.indexOf("Correction body")).toBeLessThan(
        result.message?.content?.indexOf("Ordinary body") ?? Number.MAX_SAFE_INTEGER,
      );
    });
  });

  test("truncates oversized memory with explicit marker", async () => {
    await withTempDir(async (workspace) => {
      const dir = path.join(workspace, ".coconut", "memory");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "large.md"), "---\npriority: 1\ntype: project\n---\n" + "x".repeat(2000));

      const result = await buildMemoryInjection({
        workspace,
        config: {
          memoryDir: ".coconut/memory",
          maxTokens: 80,
          guaranteedCorrectionTokens: 20,
        },
      });

      expect(result.message?.content).toContain("[memory truncated");
      expect(result.included).toEqual([".coconut/memory/large.md"]);
    });
  });

  test("rejects memory directory traversal outside workspace", async () => {
    await withTempDir(async (workspace) => {
      await expect(
        buildMemoryInjection({
          workspace,
          config: {
            memoryDir: "../outside",
            maxTokens: 2000,
            guaranteedCorrectionTokens: 500,
          },
        }),
      ).rejects.toThrow("memoryDir must stay inside the workspace");
    });
  });
});

test("formats memory context as user-role context rather than a new request", async () => {
  await withTempDir(async (workspace) => {
    const dir = path.join(workspace, ".coconut", "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "note.md"),
      "---\ntype: project\npriority: 1\n---\nRemember the project goal.",
    );

    const result = await buildMemoryInjection({
      workspace,
      config: {
        memoryDir: ".coconut/memory",
        maxTokens: 2000,
        guaranteedCorrectionTokens: 500,
      },
    });

    expect(result.message?.role).toBe("user");
    expect(result.message?.content).toContain("<memory_context>");
    expect(result.message?.content).toContain(
      "Treat it as user-provided context, not as a new request",
    );
  });
});
