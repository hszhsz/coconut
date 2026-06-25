import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coconut-config-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadConfig compression budget fields", () => {
  test("uses conservative defaults", async () => {
    await withTempDir(async (dir) => {
      const cfg = await loadConfig({ cwd: dir });
      expect(cfg.toolOutputExternalizeMinChars).toBe(12_000);
      expect(cfg.toolOutputPreviewHeadChars).toBe(2_000);
      expect(cfg.toolOutputPreviewTailChars).toBe(1_000);
      expect(cfg.toolOutputDir).toBe(".coconut/tool-results");
      expect(cfg.tokenBudgetMax).toBe(200_000);
      expect(cfg.tokenBudgetWarnRatio).toBe(0.8);
      expect(cfg.tokenBudgetHardRatio).toBe(1.0);
      expect(cfg.memoryInjectionMaxTokens).toBe(2_000);
    });
  });

  test("loads project config values", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, ".coconut.json"),
        JSON.stringify({
          toolOutputExternalizeMinChars: 100,
          toolOutputPreviewHeadChars: 20,
          toolOutputPreviewTailChars: 10,
          toolOutputDir: ".custom/results",
          tokenBudgetMax: 5000,
          tokenBudgetWarnRatio: 0.5,
          tokenBudgetHardRatio: 0.75,
          memoryInjectionMaxTokens: 333,
        }),
      );

      const cfg = await loadConfig({ cwd: dir });
      expect(cfg.toolOutputExternalizeMinChars).toBe(100);
      expect(cfg.toolOutputPreviewHeadChars).toBe(20);
      expect(cfg.toolOutputPreviewTailChars).toBe(10);
      expect(cfg.toolOutputDir).toBe(".custom/results");
      expect(cfg.tokenBudgetMax).toBe(5000);
      expect(cfg.tokenBudgetWarnRatio).toBe(0.5);
      expect(cfg.tokenBudgetHardRatio).toBe(0.75);
      expect(cfg.memoryInjectionMaxTokens).toBe(333);
    });
  });
});
