import React, { useState, useEffect, useRef, useCallback } from "react";
import { Text, Box, useApp, useInput } from "ink";
import { scanAsync, switchToPane, createPreviewSplit, swapPanes, killPane, showPlaceholder, focusPane, ownPaneId, findSiblingPanes, createSplitPane, paneExists, getPaneWidth, resizePaneWidth } from "../scanner.js";
import type { AgentPane } from "../scanner.js";
import { AgentTable } from "./AgentTable.js";
import { useMouse } from "../mouse.js";
import { loadConfig } from "../config.js";
import type { HelperDef } from "../config.js";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

interface Props {
  interval: number;
}

// ── Persistent helper zones ──────────────────────────────────────────
// Zones are tmux panes created once in the preview layout. Helpers are
// swapped in/out of zones on agent switch — zones themselves are never
// killed until the preview is closed.

interface HelperZone {
  zonePaneId: string;              // persistent pane in the preview layout
  process: string;                 // config process name to match
  occupantPaneId: string | null;   // helper pane currently swapped in
}

interface PreviewState {
  splitPaneId: string;        // agent zone placeholder (sits in agent's original position)
  agentTmuxId: string;        // agent pane (swapped into preview)
  agentName: string;
  agentPane: string;
  agentPaneId: string;
  vertical: boolean;
  windowId: string;
  zones: HelperZone[];        // persistent helper zones (created once)
  helperLayout: string | null; // active layout name, or null for off
}

/** Create the helper zone layout around the agent preview pane.
 *  Zones are empty panes; call populateZones to swap helpers in. */
function createZones(agentTmuxId: string, defs: HelperDef[]): HelperZone[] {
  const zones: HelperZone[] = [];
  const paneMap: Record<string, string> = { agent: agentTmuxId };

  for (const def of defs) {
    const targetId = paneMap[def.of || "agent"] || agentTmuxId;
    const size = def.size || "20%";
    const zonePaneId = createSplitPane(targetId, def.split, size);
    if (!zonePaneId) continue;
    paneMap[def.process] = zonePaneId;
    zones.push({ zonePaneId, process: def.process, occupantPaneId: null });
  }
  return zones;
}

/** Swap matching helper panes from the agent's window into zones.
 *  Only does swaps — call labelZones() after all swaps are done. */
function populateZones(zones: HelperZone[], windowId: string, agentTmuxId: string): void {
  if (!windowId) return;
  const siblings = findSiblingPanes(windowId, agentTmuxId);
  for (const zone of zones) {
    if (zone.occupantPaneId) continue;
    const sibling = siblings.find((s) =>
      s.command.toLowerCase() === zone.process.toLowerCase()
    );
    if (!sibling) continue;
    swapPanes(sibling.tmuxPaneId, zone.zonePaneId);
    zone.occupantPaneId = sibling.tmuxPaneId;
  }
}

/** Swap all helpers back out of zones to their original positions.
 *  Only does swaps — call labelZones() after all swaps are done. */
function depopulateZones(zones: HelperZone[]): void {
  for (const zone of [...zones].reverse()) {
    if (!zone.occupantPaneId) continue;
    if (paneExists(zone.occupantPaneId) && paneExists(zone.zonePaneId)) {
      swapPanes(zone.occupantPaneId, zone.zonePaneId);
    }
    zone.occupantPaneId = null;
  }
}

/** Label all zone placeholders after swaps are complete.
 *  Occupied zones: label the placeholder sitting in the agent's window.
 *  Empty zones: label the zone pane sitting in the dashboard. */
function labelZones(zones: HelperZone[]): void {
  for (const zone of zones) {
    if (!paneExists(zone.zonePaneId)) continue;
    if (zone.occupantPaneId) {
      // After swap: zonePaneId moved to agent's window (has tail -f).
      // Label it as "(in preview)" so the user sees context.
      showPlaceholder(zone.zonePaneId, zone.process, "(in preview)");
    } else {
      showPlaceholder(zone.zonePaneId, zone.process, "(not found)");
    }
  }
}

/** Swap helpers back and destroy all zone panes.
 *  If protectPaneId is given, its width is preserved after zone destruction. */
function destroyZones(zones: HelperZone[], protectPaneId?: string): void {
  const savedWidth = protectPaneId ? getPaneWidth(protectPaneId) : 0;
  for (const zone of [...zones].reverse()) {
    if (zone.occupantPaneId) {
      if (paneExists(zone.occupantPaneId) && paneExists(zone.zonePaneId)) {
        swapPanes(zone.occupantPaneId, zone.zonePaneId);
      }
      zone.occupantPaneId = null;
    }
    if (paneExists(zone.zonePaneId)) killPane(zone.zonePaneId);
  }
  if (protectPaneId && savedWidth > 0) {
    resizePaneWidth(protectPaneId, savedWidth);
  }
}

// ── Preview state persistence (survives HMR / vite-node restart) ────
const _selfPane = ownPaneId();
const _stateFile = join(tmpdir(), `agents-preview-${_selfPane.replace("%", "")}.json`);

function saveStateToDisk(pv: PreviewState | null): void {
  try {
    if (pv) writeFileSync(_stateFile, JSON.stringify(pv));
    else unlinkSync(_stateFile);
  } catch {}
}

function loadStateFromDisk(): PreviewState | null {
  try {
    const pv: PreviewState = JSON.parse(readFileSync(_stateFile, "utf-8"));
    // Validate that the key panes are still alive
    if (!paneExists(pv.splitPaneId) || !paneExists(pv.agentTmuxId)) {
      unlinkSync(_stateFile);
      return null;
    }
    // Validate zone panes — drop dead ones
    pv.zones = (pv.zones || []).filter((z) => paneExists(z.zonePaneId));
    return pv;
  } catch {
    return null;
  }
}

// In-memory store for current session + HMR (Vite import.meta.hot)
type HotAPI = { data: Record<string, any>; dispose(cb: (data: Record<string, any>) => void): void };
const _hot = (import.meta as any).hot as HotAPI | undefined;
let _hmrDisposing = false;
let _previewStore: PreviewState | null = _hot?.data?.preview ?? loadStateFromDisk();

if (_hot) {
  _hot.dispose((data) => {
    _hmrDisposing = true;
    data.preview = _previewStore;
    saveStateToDisk(_previewStore);
  });
}

export function Dashboard({ interval }: Props) {
  const [agents, setAgents] = useState<AgentPane[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewing, setPreviewing] = useState(!!_previewStore);
  const [compact, setCompact] = useState(false);
  const [paneWidth, setPaneWidth] = useState(() => {
    const w = getPaneWidth(ownPaneId());
    // Sync process.stdout.columns with actual tmux pane width — the PTY size
    // often doesn't match after tmux rearranges panes (no SIGWINCH sent).
    if (w > 0) process.stdout.columns = w;
    return w || process.stdout.columns || 80;
  });
  const previewRef = useRef<PreviewState | null>(_previewStore);
  const selfPaneId = useRef(ownPaneId());
  const selfWindowId = useRef(
    (() => { try { return execSync(`tmux display-message -t ${process.env.TMUX_PANE || ""} -p '#{session_name}:#{window_index}'`, { encoding: "utf-8" }).trim(); } catch { return ""; } })()
  );
  const savedWidth = useRef(0);
  const scanSeq = useRef(0);
  const liveIndex = useRef(0);       // tracks selectedIndex synchronously for rapid keypresses
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { exit } = useApp();

  /** Sync pane width from tmux into both React state and process.stdout.columns.
   *  process.stdout.columns must be correct so Ink's layout engine clips properly. */
  const syncPaneWidth = useCallback(() => {
    const w = getPaneWidth(selfPaneId.current);
    if (w > 0) {
      process.stdout.columns = w;
      setPaneWidth(w);
    }
  }, []);

  // Intercept resize events: SIGWINCH updates process.stdout.columns from the PTY,
  // which is often stale in tmux. Override with the actual tmux pane width so Ink's
  // layout engine always uses the correct value.
  useEffect(() => {
    const onResize = () => {
      const w = getPaneWidth(selfPaneId.current);
      if (w > 0) {
        process.stdout.columns = w;
        setPaneWidth(w);
      }
    };
    process.stdout.prependListener("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  const doScan = useCallback(() => {
    syncPaneWidth();

    const seq = ++scanSeq.current;
    scanAsync().then((scanned) => {
      // Discard stale results — a newer scan was started (e.g. after switchPreview)
      if (seq !== scanSeq.current) return;

      const self = selfPaneId.current;
      const selfWin = selfWindowId.current;
      let list = scanned.filter((a) => a.tmuxPaneId !== self && a.windowId !== selfWin);

      const pv = previewRef.current;
      if (pv) {
        // After swapPanes, tmux pane IDs follow the process (not the position).
        // agentTmuxId is still the agent — it's now physically in the dashboard
        // window, so the self-window filter above removed it. Find it in the
        // unfiltered scan to re-add with its original pane name.
        const swapped = scanned.find((a) => a.tmuxPaneId === pv.agentTmuxId);
        list = list.filter(
          (a) => a.tmuxPaneId !== pv.agentTmuxId && a.tmuxPaneId !== pv.splitPaneId
        );
        if (swapped) {
          list.push({ ...swapped, pane: pv.agentPane, paneId: pv.agentPaneId });
        }
      }
      list.sort((a, b) => a.pane.localeCompare(b.pane));
      setAgents(list);
    });
  }, []);

  const setPreview = useCallback((pv: PreviewState | null) => {
    previewRef.current = pv;
    _previewStore = pv;
    saveStateToDisk(pv);
    setPreviewing(!!pv);
  }, []);

  const restorePreview = useCallback(() => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    const pv = previewRef.current;
    if (!pv) return;
    if (savedWidth.current) {
      resizePaneWidth(selfPaneId.current, savedWidth.current);
      savedWidth.current = 0;
      setTimeout(() => setCompact(false), 50);
    }
    if (pv.zones.length) destroyZones(pv.zones);
    if (paneExists(pv.agentTmuxId) && paneExists(pv.splitPaneId)) {
      swapPanes(pv.agentTmuxId, pv.splitPaneId);
    }
    if (paneExists(pv.splitPaneId)) killPane(pv.splitPaneId);
    syncPaneWidth();
    setPreview(null);
  }, [setPreview, syncPaneWidth]);

  useEffect(() => {
    _hmrDisposing = false;
    const teardown = () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      const pv = previewRef.current;
      if (!pv) return;
      if (pv.zones.length) destroyZones(pv.zones);
      if (paneExists(pv.agentTmuxId) && paneExists(pv.splitPaneId)) {
        swapPanes(pv.agentTmuxId, pv.splitPaneId);
      }
      if (paneExists(pv.splitPaneId)) killPane(pv.splitPaneId);
      previewRef.current = null;
      _previewStore = null;
      saveStateToDisk(null);
    };
    const onExit = () => { if (!_hmrDisposing) teardown(); };
    const onQuitSignal = () => { teardown(); process.exit(0); };
    // SIGTERM: vite-node restart — preserve panes, save state, exit quietly
    const onRestart = () => {
      saveStateToDisk(previewRef.current);
      process.exit(0);
    };
    process.on("exit", onExit);
    process.on("SIGINT", onQuitSignal);
    process.on("SIGTERM", onRestart);
    process.on("SIGHUP", onQuitSignal);
    return () => {
      if (!_hmrDisposing) teardown();
      process.off("exit", onExit);
      process.off("SIGINT", onQuitSignal);
      process.off("SIGTERM", onRestart);
      process.off("SIGHUP", onQuitSignal);
    };
  }, []);

  useEffect(() => {
    doScan();
    const timer = setInterval(doScan, interval * 1000);
    return () => clearInterval(timer);
  }, [interval, doScan]);

  const idx = Math.min(selectedIndex, Math.max(0, agents.length - 1));
  liveIndex.current = idx; // keep in sync after React state settles / list resizes

  const helperLayouts = useRef(loadConfig().helpers);
  const helperLayoutNames = useRef(Object.keys(helperLayouts.current));

  const openPreview = useCallback((agent: AgentPane, forceVertical: boolean = false, layout: string | null = null) => {
    const dashboardRows = 9 + agents.length;
    const termRows = process.stdout.rows || 24;
    const vertical = forceVertical || termRows < dashboardRows + 10;
    const termCols = process.stdout.columns || 120;
    const dashboardCols = Math.max(48, Math.min(65, Math.floor(termCols * 0.28)));
    const splitId = createPreviewSplit(vertical ? dashboardCols : dashboardRows, vertical);
    if (!splitId) return;

    // Sync process.stdout.columns immediately after split so any SIGWINCH-triggered
    // re-render by Ink already sees the correct width.
    syncPaneWidth();
    // Clear screen so Ink's cursor tracking isn't confused by old output
    // wrapping at the new (narrower) pane width.
    process.stdout.write("\x1b[2J\x1b[H");

    // Set preview ref BEFORE swapping so async scan filter takes effect immediately
    const pv: PreviewState = {
      splitPaneId: splitId,
      agentTmuxId: agent.tmuxPaneId,
      agentName: agent.agent,
      agentPane: agent.pane,
      agentPaneId: agent.paneId,
      vertical,
      windowId: agent.windowId || "",
      zones: [],
      helperLayout: layout,
    };
    previewRef.current = pv;
    _previewStore = pv;

    swapPanes(agent.tmuxPaneId, splitId);
    showPlaceholder(splitId, agent.agent, agent.pane);

    // Create persistent zones and optionally populate them
    const defs = layout ? helperLayouts.current[layout] : null;
    const zones = defs?.length ? createZones(agent.tmuxPaneId, defs) : [];
    if (zones.length && agent.windowId) {
      populateZones(zones, agent.windowId, agent.tmuxPaneId);
    }
    if (zones.length) labelZones(zones);

    setPreview({ ...pv, zones });
  }, [agents.length, setPreview]);

  const switchingRef = useRef(false);

  const switchPreview = useCallback((agent: AgentPane) => {
    const pv = previewRef.current;
    if (!pv) return;
    if (agent.tmuxPaneId === pv.agentTmuxId) return;
    if (switchingRef.current) return;
    switchingRef.current = true;

    const sameWindow = pv.windowId && agent.windowId === pv.windowId;

    try {
      if (sameWindow && pv.zones.some((z) => z.occupantPaneId)) {
        // Same window: helpers stay in zones, just swap the agent
        swapPanes(pv.agentTmuxId, pv.splitPaneId);
        swapPanes(agent.tmuxPaneId, pv.splitPaneId);
        showPlaceholder(pv.splitPaneId, agent.agent, agent.pane);
        setPreview({
          ...pv,
          agentTmuxId: agent.tmuxPaneId,
          agentName: agent.agent,
          agentPane: agent.pane,
          agentPaneId: agent.paneId,
        });
      } else {
        // Different window (or no occupied zones): depopulate, swap agents, repopulate
        depopulateZones(pv.zones);
        swapPanes(pv.agentTmuxId, pv.splitPaneId);
        swapPanes(agent.tmuxPaneId, pv.splitPaneId);
        showPlaceholder(pv.splitPaneId, agent.agent, agent.pane);
        if (pv.helperLayout && agent.windowId) {
          populateZones(pv.zones, agent.windowId, agent.tmuxPaneId);
        }
        if (pv.zones.length) labelZones(pv.zones);
        setPreview({
          ...pv,
          agentTmuxId: agent.tmuxPaneId,
          agentName: agent.agent,
          agentPane: agent.pane,
          agentPaneId: agent.paneId,
          windowId: agent.windowId || "",
        });
      }
    } finally {
      switchingRef.current = false;
    }
  }, [setPreview]);

  const focusPreviewPane = useCallback(() => {
    const pv = previewRef.current;
    if (pv) {
      focusPane(pv.agentTmuxId);
    }
  }, []);

  const openPreviewAndFocus = useCallback((agent: AgentPane, forceVertical: boolean = false, layout: string | null = null) => {
    if (previewRef.current) {
      switchPreview(agent);
    } else {
      openPreview(agent, forceVertical, layout);
    }
    doScan(); // invalidate any stale in-flight scan and refresh
    setTimeout(() => {
      const pv = previewRef.current;
      if (pv) focusPane(pv.agentTmuxId);
    }, 50);
  }, [openPreview, switchPreview]);

  useMouse(useCallback((event) => {
    if (event.button !== 0) return;
    const agentRow = compact ? event.y - 1 : event.y - 4;
    if (agentRow < 0 || agentRow >= agents.length) return;

    setSelectedIndex(agentRow);
    const agent = agents[agentRow];
    if (!agent) return;

    openPreviewAndFocus(agent, true);
  }, [agents, openPreviewAndFocus]));

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      restorePreview();
      exit();
      return;
    }
    if (input === "j" || key.downArrow) {
      const i = Math.min(liveIndex.current, Math.max(0, agents.length - 1));
      const next = i >= agents.length - 1 ? 0 : i + 1;
      liveIndex.current = next;
      setSelectedIndex(next);
      if (previewRef.current && agents[next]) {
        // Debounce the tmux swap so rapid scrolling doesn't thrash panes
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const agent = agents[next];
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          switchPreview(agent);
          doScan();
        }, 400);
      }
    }
    if (input === "k" || key.upArrow) {
      const i = liveIndex.current;
      const next = i <= 0 ? Math.max(0, agents.length - 1) : i - 1;
      liveIndex.current = next;
      setSelectedIndex(next);
      if (previewRef.current && agents[next]) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const agent = agents[next];
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          switchPreview(agent);
          doScan();
        }, 400);
      }
    }
    if (key.tab) {
      if (agents[idx]) {
        const defaultLayout = helperLayoutNames.current[0] || null;
        openPreviewAndFocus(agents[idx], true, defaultLayout);
        // Enter fullscreen after opening preview
        if (!savedWidth.current) {
          const self = selfPaneId.current;
          process.stdout.write("\x1b[2J\x1b[H");
          savedWidth.current = getPaneWidth(self);
          resizePaneWidth(self, 5);
          process.stdout.columns = 5;
          setPaneWidth(5);
          setCompact(true);
          const pv = previewRef.current;
          if (pv?.zones.length && pv.helperLayout) {
            destroyZones(pv.zones, self);
            const defs = helperLayouts.current[pv.helperLayout] || [];
            const zones = defs.length ? createZones(pv.agentTmuxId, defs) : [];
            if (zones.length && pv.windowId) {
              populateZones(zones, pv.windowId, pv.agentTmuxId);
              labelZones(zones);
            }
            setPreview({ ...pv, zones });
          }
        }
      }
      return;
    }
    if (input === "p" || input === "P") {
      if (previewRef.current) {
        restorePreview();
      } else if (agents[idx]) {
        openPreview(agents[idx], input === "P");
      }
      return;
    }
    if (input === "f") {
      const pv = previewRef.current;
      if (!pv) return;
      const self = selfPaneId.current;
      // Clear screen to prevent ghost lines when switching render modes
      process.stdout.write("\x1b[2J\x1b[H");
      if (savedWidth.current) {
        resizePaneWidth(self, savedWidth.current);
        savedWidth.current = 0;
        syncPaneWidth();
        setTimeout(() => setCompact(false), 50);
      } else {
        savedWidth.current = getPaneWidth(self);
        resizePaneWidth(self, 5);
        process.stdout.columns = 5;
        setPaneWidth(5);
        setCompact(true);
      }
      // Reapply zone proportions after resize
      if (pv.zones.length && pv.helperLayout) {
        destroyZones(pv.zones, self);
        const defs = helperLayouts.current[pv.helperLayout] || [];
        const zones = defs.length ? createZones(pv.agentTmuxId, defs) : [];
        if (zones.length && pv.windowId) {
          populateZones(zones, pv.windowId, pv.agentTmuxId);
          labelZones(zones);
        }
        setPreview({ ...pv, zones });
      }
      return;
    }
    if (input === "h") {
      const pv = previewRef.current;
      if (!pv) return;
      const names = helperLayoutNames.current;
      if (!names.length) return;

      // Cycle: off → first layout → second layout → ... → off
      const curIdx = pv.helperLayout ? names.indexOf(pv.helperLayout) : -1;
      const nextIdx = curIdx + 1; // -1+1=0 (first layout), last+1=names.length (off)
      const nextLayout = nextIdx < names.length ? names[nextIdx] : null;

      // Tear down current zones
      if (pv.zones.length) destroyZones(pv.zones, selfPaneId.current);

      if (nextLayout && pv.windowId) {
        // Create new layout
        const defs = helperLayouts.current[nextLayout] || [];
        const zones = defs.length ? createZones(pv.agentTmuxId, defs) : [];
        if (zones.length) {
          populateZones(zones, pv.windowId, pv.agentTmuxId);
          labelZones(zones);
        }
        setPreview({ ...pv, zones, helperLayout: nextLayout });
      } else {
        setPreview({ ...pv, zones: [], helperLayout: null });
      }
      return;
    }
    if (key.return && agents[idx]) {
      restorePreview();
      switchToPane(agents[idx].paneId, agents[idx].tmuxPaneId);
    }
  });

  return (
    <Box flexDirection="column">
      {compact ? (
        <>
          {agents.map((agent, i) => {
            const sel = i === idx;
            const icon = agent.status === "attention" ? "⚠" : agent.status === "question" ? "?" : agent.status === "working" ? "●" : agent.status === "stalled" ? "◐" : "○";
            const iconColor = agent.status === "attention" ? "red" : agent.status === "question" ? "yellow" : agent.status === "working" ? "green" : agent.status === "stalled" ? "yellow" : undefined;
            return (
              <Text key={agent.tmuxPaneId}>
                <Text color={sel ? "cyan" : "gray"} bold={sel}>{sel ? "›" : " "}{i + 1}</Text>
                <Text> </Text>
                <Text color={iconColor} dimColor={!iconColor}>{icon}</Text>
              </Text>
            );
          })}
        </>
      ) : (
        <>
          <Box paddingLeft={2}>
            <Text bold>Agent Dashboard</Text>
          </Box>
          <Text> </Text>
          <AgentTable agents={agents} selectedIndex={idx} showCursor />
          <Text> </Text>
          <Box paddingLeft={2} columnGap={1} overflowX="hidden">
            <Text dimColor wrap="truncate">enter · tab · p/P · h · f · q</Text>
          </Box>
          <Box paddingLeft={2} overflowX="hidden">
            {previewing && previewRef.current ? (
              <Text dimColor wrap="truncate">{previewRef.current.vertical ? "▶" : "▼"} {previewRef.current.agentName}{previewRef.current.helperLayout ? ` [${previewRef.current.helperLayout}]` : ""}</Text>
            ) : (
              <Text> </Text>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
