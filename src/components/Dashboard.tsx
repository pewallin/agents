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
  agentPane: string;          // original pane display name
  agentPaneId: string;        // original paneId (session:window_index)
}

export function Dashboard({ interval }: Props) {
  const [agents, setAgents] = useState<AgentPane[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const previewRef = useRef<PreviewState | null>(null);
  const { exit } = useApp();

  const doScan = useCallback(() => {
    scanAsync().then((scanned) => {
      const pv = previewRef.current;
      if (pv) {
        // The swapped agent appears at the preview split position and
        // the placeholder may ghost-detect at the original position.
        // Filter both out, then re-inject the agent with its original location.
        const swapped = scanned.find((a) => a.tmuxPaneId === pv.agentTmuxId);
        const filtered = scanned.filter(
          (a) => a.tmuxPaneId !== pv.agentTmuxId && a.tmuxPaneId !== pv.splitPaneId
        );
        if (swapped) {
          filtered.push({ ...swapped, pane: pv.agentPane, paneId: pv.agentPaneId });
        }
        filtered.sort((a, b) => a.pane.localeCompare(b.pane));
        setAgents(filtered);
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
    const onSignal = () => {
      cleanup();
      process.exit(0);
    };
    process.on("exit", cleanup);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    return () => {
      cleanup();
      process.off("exit", cleanup);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
    };
  }, []);

  useEffect(() => {
    doScan();
    const timer = setInterval(doScan, interval * 1000);
    return () => clearInterval(timer);
  }, [interval, doScan]);

  const idx = Math.min(selectedIndex, Math.max(0, agents.length - 1));

  const openPreview = useCallback((agent: AgentPane, forceVertical: boolean = false) => {
    const dashboardRows = 9 + agents.length;
    const termRows = process.stdout.rows || 24;
    // Use vertical split if forced (Shift+P) or if not enough room for horizontal
    const vertical = forceVertical || termRows < dashboardRows + 10;
    const splitId = createPreviewSplit(dashboardRows, vertical);
    if (!splitId) return;
    swapPanes(agent.tmuxPaneId, splitId);
    showPlaceholder(splitId, agent.agent, agent.pane);
    previewRef.current = {
      splitPaneId: splitId,
      agentTmuxId: agent.tmuxPaneId,
      agentName: agent.agent,
      agentPane: agent.pane,
      agentPaneId: agent.paneId,
    };
    setPreviewing(true);
  }, [agents.length]);

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
      agentPaneId: agent.paneId,
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
    if (input === "p" || input === "P") {
      if (previewRef.current) {
        restorePreview();
      } else if (agents[idx]) {
        openPreview(agents[idx], input === "P");
      }
      return;
    }
    if (key.return && agents[idx]) {
      restorePreview();
      switchToPane(agents[idx].paneId);
    }
  });

  return (
    <Box flexDirection="column">
      <Box paddingLeft={2} gap={1}>
        <Text bold>Agent Dashboard</Text>
        <Text dimColor>(every {interval}s · j/k · enter jump · p/P preview · q quit)</Text>
      </Box>
      <Text> </Text>
      <AgentTable agents={agents} selectedIndex={idx} showCursor />
      {previewing && previewRef.current && (
        <>
          <Text> </Text>
          <Box paddingLeft={2}>
            <Text dimColor>▼ Preview: {previewRef.current.agentName} — {previewRef.current.agentPane}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
