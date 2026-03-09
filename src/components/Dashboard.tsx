import React, { useState, useEffect, useRef, useCallback } from "react";
import { Text, Box, useApp, useInput } from "ink";
import { scanAsync, switchToPane, createPreviewSplit, swapPanes, killPane, showPlaceholder } from "../scanner.js";
import type { AgentPane } from "../scanner.js";
import { AgentTable } from "./AgentTable.js";

interface Props {
  interval: number;
}

interface PreviewState {
  splitPaneId: string;        // %N of placeholder pane (at agent's original spot)
  agentTmuxId: string;        // %N of agent pane (now in preview split)
  agentName: string;
  agentPane: string;
  frozenAgent: AgentPane;     // snapshot of agent data from before swap
}

export function Dashboard({ interval }: Props) {
  const [agents, setAgents] = useState<AgentPane[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const previewRef = useRef<PreviewState | null>(null);
  const { exit } = useApp();

  const doScan = useCallback(() => {
    const pv = previewRef.current;
    // Exclude placeholder pane and the swapped agent pane from scan
    // (they're in wrong positions during preview)
    const exclude = pv ? new Set([pv.splitPaneId, pv.agentTmuxId]) : undefined;
    scanAsync(exclude).then((scanned) => {
      if (pv) {
        // Re-insert the frozen agent data at its sorted position
        const merged = [...scanned, pv.frozenAgent];
        merged.sort((a, b) => a.pane.localeCompare(b.pane));
        setAgents(merged);
      } else {
        setAgents(scanned);
      }
    });
  }, []);

  const restorePreview = useCallback(() => {
    const pv = previewRef.current;
    if (!pv) return;
    swapPanes(pv.agentTmuxId, pv.splitPaneId);
    killPane(pv.splitPaneId);
    previewRef.current = null;
    setPreviewing(false);
  }, []);

  useEffect(() => {
    const cleanup = () => {
      const pv = previewRef.current;
      if (!pv) return;
      swapPanes(pv.agentTmuxId, pv.splitPaneId);
      killPane(pv.splitPaneId);
      previewRef.current = null;
    };
    process.on("exit", cleanup);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    return () => {
      cleanup();
      process.off("exit", cleanup);
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
    };
  }, []);

  useEffect(() => {
    doScan();
    const timer = setInterval(doScan, interval * 1000);
    return () => clearInterval(timer);
  }, [interval, doScan]);

  const idx = Math.min(selectedIndex, Math.max(0, agents.length - 1));

  const openPreview = useCallback((agent: AgentPane) => {
    const splitId = createPreviewSplit(65);
    if (!splitId) return;
    swapPanes(agent.tmuxPaneId, splitId);
    showPlaceholder(splitId, agent.agent, agent.pane);
    previewRef.current = {
      splitPaneId: splitId,
      agentTmuxId: agent.tmuxPaneId,
      agentName: agent.agent,
      agentPane: agent.pane,
      frozenAgent: { ...agent },
    };
    setPreviewing(true);
  }, []);

  const switchPreview = useCallback((agent: AgentPane) => {
    const pv = previewRef.current;
    if (!pv) return;
    swapPanes(pv.agentTmuxId, pv.splitPaneId);
    swapPanes(agent.tmuxPaneId, pv.splitPaneId);
    showPlaceholder(pv.splitPaneId, agent.agent, agent.pane);
    previewRef.current = {
      ...pv,
      agentTmuxId: agent.tmuxPaneId,
      agentName: agent.agent,
      agentPane: agent.pane,
      frozenAgent: { ...agent },
    };
  }, []);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      restorePreview();
      exit();
      return;
    }
    if (input === "j" || key.downArrow) {
      setSelectedIndex((i) => {
        const next = Math.min(i, agents.length - 1) === agents.length - 1 ? 0 : i + 1;
        if (previewRef.current && agents[next]) {
          switchPreview(agents[next]);
        }
        return next;
      });
    }
    if (input === "k" || key.upArrow) {
      setSelectedIndex((i) => {
        const next = i === 0 ? Math.max(0, agents.length - 1) : i - 1;
        if (previewRef.current && agents[next]) {
          switchPreview(agents[next]);
        }
        return next;
      });
    }
    if (input === "p") {
      if (previewRef.current) {
        restorePreview();
      } else if (agents[idx]) {
        openPreview(agents[idx]);
      }
      return;
    }
    if (key.return && agents[idx]) {
      restorePreview();
      switchToPane(agents[idx].paneId);
    }
  });

  const contentLines = 2 + agents.length + 1;
  const termRows = process.stdout.rows || 24;
  const spacerLines = previewing ? Math.max(0, termRows - contentLines - 1) : 0;

  return (
    <Box flexDirection="column">
      <Box paddingLeft={2} gap={1}>
        <Text bold>Agent Dashboard</Text>
        <Text dimColor>(every {interval}s · j/k · enter jump · p preview · q quit)</Text>
      </Box>
      <Text> </Text>
      <AgentTable agents={agents} selectedIndex={idx} showCursor />
      {previewing && previewRef.current && (
        <>
          {spacerLines > 0 && <Text>{"\n".repeat(spacerLines - 1)}</Text>}
          <Box paddingLeft={2}>
            <Text dimColor>▼ Preview: {previewRef.current.agentName} — {previewRef.current.agentPane}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
