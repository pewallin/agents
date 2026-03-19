import React from "react";
import { Text, Box } from "ink";
import type { AgentPane, AgentStatus } from "../scanner.js";

const AGENT_COLORS: Record<string, string> = {
  claude: "#d08770", copilot: "#81a1c1", opencode: "#6882a8", pi: "#b48ead",
};
function agentColor(name: string): string { return AGENT_COLORS[name] || "#88c0d0"; }

function StatusBadge({ status, detail }: { status: AgentStatus; detail?: string }) {
  const suffix = detail ? ` (${detail})` : "";
  switch (status) {
    case "attention":
      return <Text color="red" bold>⚠ attention</Text>;
    case "question":
      return <Text color="yellow" bold>❓ question</Text>;
    case "working":
      return <Text color="green">● working{suffix}</Text>;
    case "stalled":
      return <Text color="yellow">◐ stalled?{suffix}</Text>;
    case "idle":
      return <Text dimColor>○ idle{suffix}</Text>;
  }
}

interface Props {
  agents: AgentPane[];
  selectedIndex?: number;
  showCursor?: boolean;
  summaryView?: boolean;
}

export function AgentTable({ agents, selectedIndex, showCursor, summaryView }: Props) {
  if (agents.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>No agent panes found</Text>
      </Box>
    );
  }

  // process.stdout.columns is kept in sync with the actual tmux pane width
  // by Dashboard's resize interceptor (prependListener on 'resize').
  const termCols = process.stdout.columns || 80;

  // Measure ideal data widths (capped)
  const paneData = Math.min(28, Math.max(4, ...agents.map((a) => visualWidth(a.pane))));
  const titleData = Math.min(26, Math.max(5, ...agents.map((a) => visualWidth(a.title))));
  const agentData = Math.max(5, ...agents.map((a) => visualWidth(a.agent)));
  const statusData = 15; // enough for "● working (xyz)"

  // Overhead: paddingLeft(2) + cursor(1 if shown) + gap(2) between each child
  const cursorCols = showCursor ? 1 : 0;
  const gapsFull = (showCursor ? 4 : 3) * 2;   // with title column
  const gapsCompact = (showCursor ? 3 : 2) * 2; // without title column
  const fixedFull = 2 + cursorCols + gapsFull + agentData + statusData;
  const fixedCompact = 2 + cursorCols + gapsCompact + agentData + statusData;

  let showTitle = true;
  let maxPane = paneData;
  let maxTitle = titleData;

  if (fixedFull + paneData + titleData > termCols) {
    // Shrink title first
    const availForTitle = termCols - fixedFull - paneData;
    if (availForTitle >= 8) {
      maxTitle = availForTitle;
    } else {
      // Drop title, give all remaining to pane
      showTitle = false;
      maxPane = Math.max(4, Math.min(paneData, termCols - fixedCompact));
    }
  }

  return (
    <Box flexDirection="column" overflowX="hidden">
      <Box paddingLeft={2} gap={2} overflowX="hidden">
        {showCursor && <Text>  </Text>}
        <Text color="#6b7385">{pad("PANE", maxPane)}</Text>
        {showTitle && <Text color="#6b7385">{pad("TITLE", maxTitle)}</Text>}
        <Text color="#6b7385">{pad("AGENT", agentData)}</Text>
        <Text color="#6b7385">STATUS</Text>
      </Box>
      {agents.map((agent, i) => {
        const selected = showCursor && i === selectedIndex;
        const cursorIndent = showCursor ? 3 : 0; // cursor col + gap
        return (
          <Box key={agent.tmuxPaneId} flexDirection="column" overflowX="hidden">
            <Box paddingLeft={2} gap={2} overflowX="hidden">
              {showCursor && (
                <Text color="cyan" bold={selected}>
                  {selected ? "›" : " "}
                </Text>
              )}
              <Text bold={selected}>
                {pad(agent.pane, maxPane)}
              </Text>
              {showTitle && (
                <Text bold={selected}>
                  {pad(agent.title, maxTitle)}
                </Text>
              )}
              <Text color={agentColor(agent.agent)} bold={selected}>
                {pad(agent.agent, agentData)}
              </Text>
              <StatusBadge status={agent.status} detail={agent.detail} />
            </Box>
            {summaryView && (agent.context || agent.cwd) && (
              <Box flexDirection="column" paddingLeft={2 + cursorIndent} overflowX="hidden">
                {agent.context && (
                  <Text dimColor wrap="truncate">  {agent.context}</Text>
                )}
                {agent.cwd && (
                  <Text color="#6b7385" wrap="truncate">  {agent.cwd}</Text>
                )}
              </Box>
            )}
            {summaryView && <Box height={1} />}
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
