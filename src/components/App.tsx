import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useStdin } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import Message from "./Message.js";
import { Agent } from "../lib/agent.js";
import type { DisplayMessage } from "../lib/types.js";

interface Props {
  apiKey: string;
  model: string;
}

let nextId = 0;
const mkId = () => `m${++nextId}`;

export default function App({ apiKey, model }: Props) {
  const { exit } = useApp();
  const { stdin, setRawMode } = useStdin();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [agent] = useState(() => new Agent(apiKey, model));

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
        setInput("");
        return;
      }
      if (trimmed === "/exit" || trimmed === "/quit") {
        exit();
        return;
      }
      if (trimmed === "/help") {
        append({
          role: "assistant",
          content:
            "Commands: /clear (reset chat), /exit (quit), /help. Otherwise, just type your request.",
        });
        setInput("");
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
        onDone: () => {
          flushText();
          setBusy(false);
        },
        onError: (err) => {
          flushText();
          append({ role: "error", content: err.message });
          setBusy(false);
        },
      });
    },
    [agent, busy, append, exit],
  );

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
        <Text dimColor>
          A minimal coding agent · model: {model} · /help for commands
        </Text>
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
