#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import App from "./components/App.js";

// DeepSeek by default. Override with COCONUT_API_KEY / COCONUT_BASE_URL / COCONUT_MODEL.
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
  console.error(
    "  Override with COCONUT_MODEL / COCONUT_BASE_URL if needed.",
  );
  console.error("");
  process.exit(1);
}

render(<App apiKey={apiKey} baseURL={baseURL} model={model} />);
