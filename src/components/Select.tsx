import React, { useState } from "react";
import { Text, Box, useApp, useInput } from "ink";
import { switchToPane } from "../scanner.js";
import type { AgentPane } from "../scanner.js";
import { AgentTable } from "./AgentTable.js";
import { detectMultiplexer } from "../multiplexer.js";

interface Props {
  agents: AgentPane[];
}

export function Select({ agents }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();
  const canJump = !!detectMultiplexer();

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) =>
        i >= agents.length - 1 ? 0 : i + 1
      );
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) =>
        i === 0 ? agents.length - 1 : i - 1
      );
    }
    if (key.return && canJump && agents[selectedIndex]) {
      switchToPane(agents[selectedIndex].paneId, agents[selectedIndex].tmuxPaneId);
      exit();
    }
  });

  if (agents.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>No agent panes found</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <AgentTable agents={agents} selectedIndex={selectedIndex} showCursor />
      <Box paddingLeft={2} marginTop={1}>
        <Text dimColor>
          {canJump
            ? "j/k navigate · enter to jump · q to quit"
            : "j/k navigate · run inside tmux/zellij to jump · q to quit"}
        </Text>
      </Box>
    </Box>
  );
}
