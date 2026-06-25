import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useStdin } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import Message from "./Message.js";
import { Agent } from "../lib/agent.js";
import { allTools } from "../tools/index.js";
import type { DisplayMessage } from "../lib/types.js";
import type { Sandbox } from "../lib/sandbox.js";

interface Props {
  apiKey: string;
  baseURL: string;
  model: string;
  sandbox: Sandbox;
  systemOverride: string | null;
  maxTokens: number;
  temperature: number;
  maxIterations: number;
  contextWindow: number;
  compressionThreshold: number;
  keepRecentTurns: number;
  toolOutputExternalizeMinChars: number;
  toolOutputPreviewHeadChars: number;
  toolOutputPreviewTailChars: number;
  toolOutputDir: string;
  tokenBudgetMax: number;
  tokenBudgetWarnRatio: number;
  tokenBudgetHardRatio: number;
  memoryInjectionMaxTokens: number;
  configDescription: string;
}

let nextId = 0;
const mkId = () => `m${++nextId}`;

export default function App({
  apiKey,
  baseURL,
  model,
  sandbox,
  systemOverride,
  maxTokens,
  temperature,
  maxIterations,
  contextWindow,
  compressionThreshold,
  keepRecentTurns,
  toolOutputExternalizeMinChars,
  toolOutputPreviewHeadChars,
  toolOutputPreviewTailChars,
  toolOutputDir,
  tokenBudgetMax,
  tokenBudgetWarnRatio,
  tokenBudgetHardRatio,
  memoryInjectionMaxTokens,
  configDescription,
}: Props) {
  const { exit } = useApp();
  const { stdin, setRawMode } = useStdin();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState<{ used: number; window: number }>({
    used: 0,
    window: contextWindow,
  });
  const [agent] = useState(
    () =>
      new Agent({
        apiKey,
        baseURL,
        model,
        tools: allTools,
        sandbox,
        systemOverride,
        maxTokens,
        temperature,
        maxIterations,
        contextWindow,
        compressionThreshold,
        keepRecentTurns,
        toolOutputExternalizeMinChars,
        toolOutputPreviewHeadChars,
        toolOutputPreviewTailChars,
        toolOutputDir,
        tokenBudgetMax,
        tokenBudgetWarnRatio,
        tokenBudgetHardRatio,
        memoryInjectionMaxTokens,
      }),
  );

  useEffect(() => {
    if (setRawMode) setRawMode(true);
  }, [setRawMode]);

  // Handle Ctrl+C
  useEffect(() => {
    const onData = (data: Buffer) => {
      const s = data.toString();
      if (s === "") {
        exit();
      }
    };
    stdin?.on("data", onData);
    return () => {
      stdin?.off("data", onData);
    };
  }, [stdin, exit]);

  const append = useCallback((msg: Omit<DisplayMessage, "id">) => {
    setMessages((prev) => [...prev, { ...msg, id: mkId() }]);
  }, []);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || busy) return;

      // Slash commands
      if (trimmed === "/clear") {
        agent.reset();
        setMessages([]);
        setTokens(agent.tokenStats());
        setInput("");
        return;
      }
      if (trimmed === "/exit" || trimmed === "/quit") {
        exit();
        return;
      }
      if (trimmed === "/help") {
        append({
          role: "info",
          content:
            "Commands: /config, /sandbox, /tokens (show usage), /compact (force-compress now), /clear (reset chat), /exit, /help. Otherwise, just type your request.",
        });
        setInput("");
        return;
      }
      if (trimmed === "/sandbox") {
        append({
          role: "info",
          content: `Sandbox: ${sandbox.label}\nWorkspace: ${sandbox.workspace}`,
        });
        setInput("");
        return;
      }
      if (trimmed === "/config") {
        append({ role: "info", content: configDescription });
        setInput("");
        return;
      }
      if (trimmed === "/tokens") {
        const s = agent.tokenStats();
        const pct = (s.ratio * 100).toFixed(1);
        append({
          role: "info",
          content: `Tokens: ${s.used.toLocaleString()} / ${s.window.toLocaleString()} (${pct}%)\nAuto-compact triggers at ${(compressionThreshold * 100).toFixed(0)}%\nRun budget: ${tokenBudgetMax.toLocaleString()} tokens (warn ${(tokenBudgetWarnRatio * 100).toFixed(0)}%, hard ${(tokenBudgetHardRatio * 100).toFixed(0)}%)`,
        });
        setInput("");
        return;
      }
      if (trimmed === "/compact") {
        setInput("");
        setBusy(true);
        try {
          const r = await agent.maybeCompact("force", (m) =>
            append({ role: "info", content: m }),
          );
          append({
            role: "info",
            content: `Compacted: ${r.before.toLocaleString()} → ${r.after.toLocaleString()} tokens (-${r.savedTokens.toLocaleString()})`,
          });
          setTokens(agent.tokenStats());
        } catch (e: any) {
          append({ role: "error", content: `Compaction failed: ${e?.message ?? e}` });
        } finally {
          setBusy(false);
        }
        return;
      }

      append({ role: "user", content: trimmed });
      setInput("");
      setBusy(true);

      let textBuffer = "";
      const flushText = () => {
        if (textBuffer.trim()) {
          append({ role: "assistant", content: textBuffer.trim() });
          textBuffer = "";
        }
      };

      await agent.send(trimmed, {
        onText: (t) => {
          textBuffer += t;
        },
        onToolUse: (name, input) => {
          flushText();
          const inputPreview = JSON.stringify(input);
          append({
            role: "tool",
            toolName: name,
            content: inputPreview,
          });
        },
        onToolResult: (name, result, isError) => {
          append({
            role: "tool_result",
            content: result,
            isError,
          });
        },
        onInfo: (msg) => {
          flushText();
          append({ role: "info", content: msg });
        },
        onDone: () => {
          flushText();
          setTokens(agent.tokenStats());
          setBusy(false);
        },
        onError: (err) => {
          flushText();
          append({ role: "error", content: err.message });
          setTokens(agent.tokenStats());
          setBusy(false);
        },
      });
    },
    [
      agent,
      busy,
      append,
      exit,
      sandbox,
      configDescription,
      compressionThreshold,
      tokenBudgetMax,
      tokenBudgetWarnRatio,
      tokenBudgetHardRatio,
    ],
  );

  // Color the token meter by usage band.
  const ratio = tokens.window > 0 ? tokens.used / tokens.window : 0;
  const meterColor =
    ratio >= compressionThreshold
      ? "red"
      : ratio >= compressionThreshold * 0.85
        ? "yellow"
        : "green";
  const meterLabel = `${(tokens.used / 1000).toFixed(1)}K / ${(tokens.window / 1000).toFixed(0)}K (${(ratio * 100).toFixed(0)}%)`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        flexDirection="column"
        marginBottom={1}
        borderStyle="round"
        borderColor="magenta"
        paddingX={1}
      >
        <Text color="magenta" bold>
          🥥 Coconut
        </Text>
        <Box>
          <Text dimColor>
            model: {model} · sandbox: {sandbox.label} · tokens:{" "}
          </Text>
          <Text color={meterColor}>{meterLabel}</Text>
          <Text dimColor> · /help for commands</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
      </Box>

      {busy && (
        <Box marginY={1}>
          <Spinner label="Thinking..." />
        </Box>
      )}

      {!busy && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
        >
          <Text color="cyan">{"› "}</Text>
          <TextInput
            placeholder="Ask Coconut anything... (Ctrl+C to exit)"
            defaultValue={input}
            onSubmit={handleSubmit}
          />
        </Box>
      )}
    </Box>
  );
}
