import React, { useState, useEffect } from "react";
import { Text, Box, useApp, useInput } from "ink";
import { scanAsync, switchToPane } from "../scanner.js";
import type { AgentPane } from "../scanner.js";
import { AgentTable } from "./AgentTable.js";

interface Props {
  interval: number;
}

export function Dashboard({ interval }: Props) {
  const [agents, setAgents] = useState<AgentPane[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { exit } = useApp();

  useEffect(() => {
    scanAsync().then(setAgents);
    const timer = setInterval(() => {
      scanAsync().then(setAgents);
    }, interval * 1000);
    return () => clearInterval(timer);
  }, [interval]);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) => Math.min(i, agents.length - 1) === agents.length - 1 ? 0 : i + 1);
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) => i === 0 ? Math.max(0, agents.length - 1) : i - 1);
    }
    if (key.return && agents[selectedIndex]) {
      switchToPane(agents[selectedIndex].paneId);
    }
  });

  // Clamp selection
  const idx = Math.min(selectedIndex, Math.max(0, agents.length - 1));

  return (
    <Box flexDirection="column">
      <Box paddingLeft={2} gap={1}>
        <Text bold>Agent Dashboard</Text>
        <Text dimColor>(every {interval}s · j/k navigate · enter to jump · q to quit)</Text>
      </Box>
      <Text> </Text>
      <AgentTable agents={agents} selectedIndex={idx} showCursor />
    </Box>
  );
}
