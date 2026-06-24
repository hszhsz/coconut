import React from "react";
import { Box, Text } from "ink";
import chalk from "chalk";
import type { DisplayMessage } from "../lib/types.js";

interface Props {
  message: DisplayMessage;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

export default function Message({ message }: Props) {
  switch (message.role) {
    case "user":
      return (
        <Box marginY={0}>
          <Text color="cyan" bold>
            {"› "}
          </Text>
          <Text>{message.content}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginY={0} flexDirection="column">
          <Text>{message.content}</Text>
        </Box>
      );

    case "tool":
      return (
        <Box marginY={0}>
          <Text color="yellow">⚒ </Text>
          <Text color="yellow">{message.toolName}</Text>
          <Text dimColor>{" "}</Text>
          <Text dimColor>{truncate(message.content, 100)}</Text>
        </Box>
      );

    case "tool_result":
      return (
        <Box marginY={0} marginLeft={2}>
          <Text dimColor>
            {message.isError ? chalk.red("✗ ") : chalk.green("✓ ")}
            {truncate(message.content.replace(/\n/g, " "), 120)}
          </Text>
        </Box>
      );

    case "error":
      return (
        <Box marginY={0}>
          <Text color="red">⚠ {message.content}</Text>
        </Box>
      );

    case "info":
      return (
        <Box marginY={0} flexDirection="column">
          {message.content.split("\n").map((line, i) => (
            <Text key={i} color="magenta">
              {line}
            </Text>
          ))}
        </Box>
      );

    default:
      return (
        <Box>
          <Text>{message.content}</Text>
        </Box>
      );
  }
}
