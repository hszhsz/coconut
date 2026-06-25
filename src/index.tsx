#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import App from "./components/App.js";
import { createSandbox, type Sandbox } from "./lib/sandbox.js";
import { loadConfig, describeConfig } from "./lib/config.js";

let cfg;
try {
  cfg = await loadConfig();
} catch (e: any) {
  console.error(`\x1b[31m✗ ${e?.message ?? e}\x1b[0m`);
  process.exit(1);
}

if (!cfg.apiKey) {
  console.error(
    "\x1b[31m✗ No API key found.\x1b[0m Set DEEPSEEK_API_KEY (or COCONUT_API_KEY), or put `\"apiKey\": \"...\"` in your config file.",
  );
  console.error("");
  console.error("  Examples:");
  console.error("    export DEEPSEEK_API_KEY=sk-...");
  console.error(
    "    # or: ~/.config/coconut/config.json  → { \"apiKey\": \"sk-...\" }",
  );
  console.error("");
  console.error(`  ${describeConfig(cfg).replace(/\n/g, "\n  ")}`);
  console.error("");
  process.exit(1);
}

const sandbox: Sandbox = createSandbox({
  kind: cfg.sandbox.kind,
  workspace: cfg.sandbox.workspace,
  image: cfg.sandbox.image,
  network: cfg.sandbox.network,
});

let cleaningUp = false;
async function cleanup(code = 0) {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    await sandbox.dispose();
  } catch {
    /* best effort */
  }
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));
process.on("uncaughtException", async (err) => {
  console.error("\x1b[31m✗ Uncaught error:\x1b[0m", err);
  await sandbox.dispose().catch(() => {});
  process.exit(1);
});

async function main() {
  try {
    await sandbox.init((msg) => {
      // eslint-disable-next-line no-console
      console.log(`\x1b[2m· ${msg}\x1b[0m`);
    });
  } catch (e: any) {
    console.error(
      `\x1b[31m✗ Failed to initialize sandbox:\x1b[0m ${e?.message ?? e}`,
    );
    process.exit(1);
  }

  const instance = render(
    <App
      apiKey={cfg!.apiKey!}
      baseURL={cfg!.baseURL}
      model={cfg!.model}
      sandbox={sandbox}
      systemOverride={cfg!.system}
      maxTokens={cfg!.maxTokens}
      temperature={cfg!.temperature}
      maxIterations={cfg!.maxIterations}
      contextWindow={cfg!.contextWindow}
      compressionThreshold={cfg!.compressionThreshold}
      keepRecentTurns={cfg!.keepRecentTurns}
      toolOutputExternalizeMinChars={cfg!.toolOutputExternalizeMinChars}
      toolOutputPreviewHeadChars={cfg!.toolOutputPreviewHeadChars}
      toolOutputPreviewTailChars={cfg!.toolOutputPreviewTailChars}
      toolOutputDir={cfg!.toolOutputDir}
      tokenBudgetMax={cfg!.tokenBudgetMax}
      tokenBudgetWarnRatio={cfg!.tokenBudgetWarnRatio}
      tokenBudgetHardRatio={cfg!.tokenBudgetHardRatio}
      memoryInjectionMaxTokens={cfg!.memoryInjectionMaxTokens}
      memoryDir={cfg!.memoryDir}
      memoryInjectionGuaranteedCorrectionTokens={cfg!.memoryInjectionGuaranteedCorrectionTokens}
      dynamicContextEnabled={cfg!.dynamicContextEnabled}
      dynamicContextIncludeDate={cfg!.dynamicContextIncludeDate}
      configDescription={describeConfig(cfg!)}
    />,
  );
  await instance.waitUntilExit();
  await sandbox.dispose().catch(() => {});
  process.exit(0);
}

main();
