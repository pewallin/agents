import React from "react";
import { Text, Box } from "ink";
import type { AgentPane, AgentStatus } from "../scanner.js";

function StatusBadge({ status, detail }: { status: AgentStatus; detail?: string }) {
  const suffix = detail ? ` (${detail})` : "";
  switch (status) {
    case "working":
      return <Text color="green">● working{suffix}</Text>;
    case "stalled":
      return <Text color="yellow">◐ stalled?{suffix}</Text>;
    case "waiting":
      return <Text dimColor>○ waiting{suffix}</Text>;
    case "idle":
      return <Text dimColor>○ idle{suffix}</Text>;
  }
}

interface Props {
  agents: AgentPane[];
  selectedIndex?: number;
  showCursor?: boolean;
}

export function AgentTable({ agents, selectedIndex, showCursor }: Props) {
  if (agents.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>No agent panes found</Text>
      </Box>
    );
  }

  // Calculate column widths with caps to prevent wrapping
  const MAX_PANE = 28;
  const MAX_TITLE = 26;
  const maxPane = Math.min(MAX_PANE, Math.max(4, ...agents.map((a) => a.pane.length)));
  const maxTitle = Math.min(MAX_TITLE, Math.max(5, ...agents.map((a) => a.title.length)));
  const maxAgent = Math.max(5, ...agents.map((a) => a.agent.length));

  return (
    <Box flexDirection="column">
      <Box paddingLeft={2} gap={2}>
        {showCursor && <Text>  </Text>}
        <Text bold>{pad("PANE", maxPane)}</Text>
        <Text bold>{pad("TITLE", maxTitle)}</Text>
        <Text bold>{pad("AGENT", maxAgent)}</Text>
        <Text bold>STATUS</Text>
      </Box>
      {agents.map((agent, i) => {
        const selected = showCursor && i === selectedIndex;
        return (
          <Box key={agent.pane} paddingLeft={2} gap={2}>
            {showCursor && (
              <Text color="cyan" bold={selected}>
                {selected ? "›" : " "}
              </Text>
            )}
            <Text inverse={selected}>{pad(agent.pane, maxPane)}</Text>
            <Text inverse={selected}>{pad(agent.title, maxTitle)}</Text>
            <Text color="cyan" inverse={selected}>
              {pad(agent.agent, maxAgent)}
            </Text>
            <StatusBadge status={agent.status} detail={agent.detail} />
          </Box>
        );
      })}
    </Box>
  );
}

function pad(str: string, len: number): string {
  const truncated = str.length > len ? str.slice(0, len - 1) + "…" : str;
  return truncated + " ".repeat(Math.max(0, len - truncated.length));
}
