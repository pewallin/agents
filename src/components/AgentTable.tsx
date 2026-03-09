import React from "react";
import { Text, Box } from "ink";
import type { AgentPane, AgentStatus } from "../scanner.js";

function StatusBadge({ status, detail }: { status: AgentStatus; detail?: string }) {
  const suffix = detail ? ` (${detail})` : "";
  switch (status) {
    case "approval":
      return <Text color="red" bold>⚠ approval</Text>;
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
  const maxPane = Math.min(MAX_PANE, Math.max(4, ...agents.map((a) => visualWidth(a.pane))));
  const maxTitle = Math.min(MAX_TITLE, Math.max(5, ...agents.map((a) => visualWidth(a.title))));
  const maxAgent = Math.max(5, ...agents.map((a) => visualWidth(a.agent)));

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
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {pad(agent.pane, maxPane)}
            </Text>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {pad(agent.title, maxTitle)}
            </Text>
            <Text color="cyan" bold={selected}>
              {pad(agent.agent, maxAgent)}
            </Text>
            <StatusBadge status={agent.status} detail={agent.detail} />
          </Box>
        );
      })}
    </Box>
  );
}

// Estimate visual width: wide/emoji chars take 2 columns
function visualWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    // Surrogate-pair emoji, CJK, fullwidth, and miscellaneous symbols
    if (cp > 0xffff || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6)) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function pad(str: string, len: number): string {
  const vw = visualWidth(str);
  if (vw > len) {
    // Truncate by visual width
    let w = 0;
    let i = 0;
    for (const ch of str) {
      const cw = visualWidth(ch);
      if (w + cw >= len) break;
      w += cw;
      i += ch.length;
    }
    const truncated = str.slice(0, i) + "…";
    return truncated + " ".repeat(Math.max(0, len - visualWidth(truncated)));
  }
  return str + " ".repeat(Math.max(0, len - vw));
}
