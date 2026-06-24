#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import App from "./components/App.js";

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error("\x1b[31m✗ ANTHROPIC_API_KEY environment variable is not set.\x1b[0m");
  console.error("");
  console.error("  Set it with:");
  console.error("    export ANTHROPIC_API_KEY=sk-ant-...");
  console.error("");
  process.exit(1);
}

const model = process.env.COCONUT_MODEL || "claude-sonnet-4-6";

render(<App apiKey={apiKey} model={model} />);
