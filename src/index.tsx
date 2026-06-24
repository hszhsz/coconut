#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import path from "node:path";
import App from "./components/App.js";
import { createSandbox, type Sandbox } from "./lib/sandbox.js";

// LLM config — DeepSeek by default.
const apiKey = process.env.COCONUT_API_KEY || process.env.DEEPSEEK_API_KEY;
const baseURL =
  process.env.COCONUT_BASE_URL ||
  process.env.DEEPSEEK_BASE_URL ||
  "https://api.deepseek.com/v1";
const model = process.env.COCONUT_MODEL || "deepseek-v4-pro";

if (!apiKey) {
  console.error(
    "\x1b[31m✗ No API key found.\x1b[0m Set DEEPSEEK_API_KEY (or COCONUT_API_KEY).",
  );
  console.error("");
  console.error("  Example:");
  console.error("    export DEEPSEEK_API_KEY=sk-...");
  console.error("");
  console.error(
    "  Defaults: model=deepseek-v4-pro  base_url=https://api.deepseek.com/v1",
  );
  console.error("  Override with COCONUT_MODEL / COCONUT_BASE_URL if needed.");
  console.error("");
  process.exit(1);
}

// Sandbox config — `local` by default, `docker` for an isolated container.
const rawKind = (process.env.COCONUT_SANDBOX || "local").toLowerCase();
if (rawKind !== "local" && rawKind !== "docker") {
  console.error(
    `\x1b[31m✗ COCONUT_SANDBOX must be "local" or "docker" (got: "${rawKind}")\x1b[0m`,
  );
  process.exit(1);
}
const sandboxKind = rawKind as "local" | "docker";

const workspace = path.resolve(process.env.COCONUT_WORKSPACE || process.cwd());

const rawNetwork = (process.env.COCONUT_SANDBOX_NETWORK || "bridge").toLowerCase();
if (rawNetwork !== "bridge" && rawNetwork !== "none") {
  console.error(
    `\x1b[31m✗ COCONUT_SANDBOX_NETWORK must be "bridge" or "none" (got: "${rawNetwork}")\x1b[0m`,
  );
  process.exit(1);
}

const sandbox: Sandbox = createSandbox({
  kind: sandboxKind,
  workspace,
  image: process.env.COCONUT_SANDBOX_IMAGE,
  network: rawNetwork as "bridge" | "none",
});

// Cleanup once on exit. Signal handlers run before `process.exit`; the
// in-sandbox synchronous-exit fallback in sandbox.ts catches anything else.
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
    <App apiKey={apiKey!} baseURL={baseURL} model={model} sandbox={sandbox} />,
  );
  // When Ink exits (e.g. user typed /exit or Ctrl+C handled by useApp),
  // dispose the sandbox and exit cleanly.
  await instance.waitUntilExit();
  await sandbox.dispose().catch(() => {});
  process.exit(0);
}

main();
