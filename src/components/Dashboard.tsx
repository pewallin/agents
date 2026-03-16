import React, { useState, useEffect, useRef, useCallback } from "react";
import { Text, Box, useApp, useInput } from "ink";
import { scanAsync, switchToPane, createPreviewSplit, swapPanes, killPane, killWindow, showPlaceholder, focusPane, ownPaneId, findSiblingPanes, createSplitPane, paneExists, getPaneWidth, resizePaneWidth, filterAgents } from "../scanner.js";
import type { AgentPane } from "../scanner.js";
import { AgentTable } from "./AgentTable.js";
import { useMouse } from "../mouse.js";
import { loadConfig, getProfileNames, resolveProfile } from "../config.js";
import type { HelperDef } from "../config.js";
import { createWorkspace } from "../workspace.js";
import { createGrid, destroyGrid, type GridState, type GridAgent } from "../grid.js";
import { writeFileSync, readFileSync, unlinkSync, existsSync, statSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";

interface Props {
  interval: number;
}

const AGENT_COLORS: Record<string, string> = {
  claude: "#d08770", copilot: "#81a1c1", opencode: "#6882a8", pi: "#b48ead",
};
function agentColor(name: string): string { return AGENT_COLORS[name] || "#88c0d0"; }

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

// ── Grid state (not persisted across HMR — too complex) ─────────────
let _gridStore: GridState | null = null;

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
  const gridRef = useRef<GridState | null>(_gridStore);
  const [gridActive, setGridActive] = useState(!!_gridStore);
  const selfPaneId = useRef<string>(null!);
  if (!selfPaneId.current) selfPaneId.current = ownPaneId();
  const selfWindowId = useRef<string>(null!);
  if (!selfWindowId.current) {
    try { selfWindowId.current = execSync(`tmux display-message -t ${process.env.TMUX_PANE || ""} -p '#{session_name}:#{window_index}'`, { encoding: "utf-8" }).trim(); } catch { selfWindowId.current = ""; }
  }
  const savedWidth = useRef(0);
  const scanSeq = useRef(0);
  const liveIndex = useRef(0);       // tracks selectedIndex synchronously for rapid keypresses
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Multi-step new-agent wizard: profile → session → cwd → create
  type WizardState =
    | { step: "profile"; profiles: string[]; selected: number; inheritedCwd: string; inheritedSession: string }
    | { step: "session"; profile: string; sessions: string[]; selected: number; inheritedCwd: string }
    | { step: "cwd"; profile: string; session: string; cwdInput: string; cwdValid: boolean };
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [showKeys, setShowKeys] = useState(true);
  const [confirmKill, setConfirmKill] = useState<AgentPane | null>(null);
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

      const pv = previewRef.current;
      const gs = gridRef.current;
      const list = filterAgents(
        scanned,
        selfPaneId.current,
        selfWindowId.current,
        pv ? { agentTmuxId: pv.agentTmuxId, splitPaneId: pv.splitPaneId, agentPane: pv.agentPane, agentPaneId: pv.agentPaneId } : null,
        gs ? { agents: gs.agents, placeholderIds: gs.placeholderIds } : null,
      );
      setAgents(list);

      // Auto-rebuild grid if agents changed (new agent added, agent exited)
      {
        const curGrid = gridRef.current;
        if (curGrid) {
          const scope = (curGrid as any)._scope as string | undefined;
          const gridAgentIds = new Set(curGrid.agents.map((a) => a.tmuxPaneId));
          const currentAgents = list
            .filter((a) => !scope || a.pane.startsWith(scope + ":"))
            .map((a) => a.tmuxPaneId);
          const currentSet = new Set(currentAgents);
          const hasNew = currentAgents.some((id) => !gridAgentIds.has(id));
          const hasGone = curGrid.agents.some((a) => !currentSet.has(a.tmuxPaneId));
          if (hasNew || hasGone) {
            const self = selfPaneId.current;
            const termCols = paneWidth || 120;
            const dashboardCols = Math.max(48, Math.min(65, Math.floor(termCols * 0.28)));
            const newGridAgents = list
              .filter((a) => !scope || a.pane.startsWith(scope + ":"))
              .slice(0, 12)
              .map((a) => ({ tmuxPaneId: a.tmuxPaneId, agent: a.agent, pane: a.pane }));
            destroyGrid(curGrid);
            if (newGridAgents.length >= 1) {
              const newGs = createGrid(newGridAgents, self, true, dashboardCols);
              if (newGs) (newGs as any)._scope = scope;
              gridRef.current = newGs;
              _gridStore = newGs;
              setGridActive(!!newGs);
            } else {
              gridRef.current = null;
              _gridStore = null;
              setGridActive(false);
            }
          }
        }
      }
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
      // Grid teardown
      const gs = gridRef.current;
      if (gs) {
        destroyGrid(gs);
        gridRef.current = null;
        _gridStore = null;
      }
      // Preview teardown
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

  const helperLayouts = useRef<Record<string, HelperDef[]>>(null!);
  if (!helperLayouts.current) helperLayouts.current = loadConfig().helpers;
  const helperLayoutNames = useRef<string[]>(null!);
  if (!helperLayoutNames.current) helperLayoutNames.current = Object.keys(helperLayouts.current);

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

  const closeGrid = useCallback(() => {
    const gs = gridRef.current;
    if (!gs) return;
    destroyGrid(gs);
    gridRef.current = null;
    _gridStore = null;
    setGridActive(false);
    syncPaneWidth();
    doScan();
  }, [syncPaneWidth, doScan]);

  const openGrid = useCallback((scope?: string) => {
    // Close existing preview/helpers first
    restorePreview();

    // Filter agents by tmux session scope (if provided)
    let gridAgents: GridAgent[] = agents
      .filter((a) => !scope || a.pane.startsWith(scope + ":"))
      .map((a) => ({ tmuxPaneId: a.tmuxPaneId, agent: a.agent, pane: a.pane }));

    if (gridAgents.length < 1) return;
    if (gridAgents.length > 12) gridAgents = gridAgents.slice(0, 12);

    const self = selfPaneId.current;
    const termCols = process.stdout.columns || 120;
    const dashboardCols = Math.max(48, Math.min(65, Math.floor(termCols * 0.28)));

    const gs = createGrid(gridAgents, self, true, dashboardCols);
    if (!gs) return;

    // Stash scope for g↔G toggle detection
    (gs as any)._scope = scope;
    gridRef.current = gs;
    _gridStore = gs;
    setGridActive(true);
    syncPaneWidth();
    doScan();
  }, [agents, restorePreview, syncPaneWidth, doScan]);

  /** Focus an agent in grid mode. If scoped and agent is in a different session, rebuild grid. */
  const gridSelectAgent = useCallback((agent: AgentPane) => {
    const gs = gridRef.current;
    if (!gs) return;
    const scope = (gs as any)._scope as string | undefined;
    if (scope) {
      const agentSession = agent.pane.split(":")[0];
      if (agentSession !== scope) {
        closeGrid();
        openGrid(agentSession);
        // Focus after rebuild — the agent pane is now in the new grid
        setTimeout(() => focusPane(agent.tmuxPaneId), 50);
        return;
      }
    }
    // Same session (or unscoped) — just focus the pane in the grid
    focusPane(agent.tmuxPaneId);
  }, [closeGrid, openGrid]);

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
    if (compact) {
      // Row 1 = ◀ expand icon (event.y is 1-based)
      if (event.y <= 1) {
        const self = selfPaneId.current;
        if (savedWidth.current) {
          resizePaneWidth(self, savedWidth.current);
          savedWidth.current = 0;
          syncPaneWidth();
          setTimeout(() => setCompact(false), 50);
        }
        return;
      }
      const agentRow = event.y - 2;
      if (agentRow < 0 || agentRow >= agents.length) return;
      setSelectedIndex(agentRow);
      liveIndex.current = agentRow;
      const agent = agents[agentRow];
      if (agent) {
        if (gridRef.current) gridSelectAgent(agent);
        else openPreviewAndFocus(agent, true);
      }
      return;
    }
    // Row 1 = "Agent Dashboard" header — click to collapse sidebar
    if (event.y <= 1 && previewRef.current && !savedWidth.current) {
      const self = selfPaneId.current;
      process.stdout.write("\x1b[2J\x1b[H");
      savedWidth.current = getPaneWidth(self);
      resizePaneWidth(self, 5);
      process.stdout.columns = 5;
      setPaneWidth(5);
      setCompact(true);
      return;
    }
    const agentRow = event.y - 4;
    if (agentRow < 0 || agentRow >= agents.length) return;

    setSelectedIndex(agentRow);
    const agent = agents[agentRow];
    if (!agent) return;

    if (gridRef.current) gridSelectAgent(agent);
    else openPreviewAndFocus(agent, true);
  }, [agents, compact, openPreviewAndFocus, gridSelectAgent]));

  // Advance wizard from profile step → session or cwd step
  const wizardAfterProfile = useCallback((profile: string, inheritedCwd: string, inheritedSession: string) => {
    let sessions: string[] = [];
    try { sessions = execSync("tmux list-sessions -F '#{session_name}'", { encoding: "utf-8" }).trim().split("\n").filter(Boolean); } catch {}
    if (sessions.length > 1) {
      const selIdx = Math.max(0, sessions.indexOf(inheritedSession));
      setWizard({ step: "session", profile, sessions, selected: selIdx, inheritedCwd });
    } else {
      const session = sessions[0] || inheritedSession;
      wizardAfterSession(profile, session, inheritedCwd);
    }
  }, []);

  const wizardAfterSession = useCallback((profile: string, session: string, inheritedCwd: string) => {
    const valid = !!inheritedCwd && existsSync(inheritedCwd) && statSync(inheritedCwd).isDirectory();
    setWizard({ step: "cwd", profile, session, cwdInput: inheritedCwd, cwdValid: valid });
  }, []);

  const validateCwd = useCallback((path: string): boolean => {
    try {
      return !!path && existsSync(path) && statSync(path).isDirectory();
    } catch { return false; }
  }, []);

  useInput((input, key) => {
    // ── Kill confirmation ──
    if (confirmKill) {
      if (input === "y" || input === "Y") {
        const agent = confirmKill;
        setConfirmKill(null);
        // If in grid view, remove from grid
        const gs = gridRef.current;
        if (gs && gs.agents.some((a) => a.tmuxPaneId === agent.tmuxPaneId)) {
          const self = selfPaneId.current;
          const termCols = process.stdout.columns || 120;
          const dashboardCols = Math.max(48, Math.min(65, Math.floor(termCols * 0.28)));
          const remaining = gs.agents.filter((a) => a.tmuxPaneId !== agent.tmuxPaneId);
          const scope = (gs as any)._scope;
          destroyGrid(gs);
          killWindow(agent.windowId || agent.paneId);
          if (remaining.length >= 1) {
            const newGs = createGrid(remaining, self, true, dashboardCols);
            if (newGs) (newGs as any)._scope = scope;
            gridRef.current = newGs;
            _gridStore = newGs;
            setGridActive(!!newGs);
          } else {
            gridRef.current = null;
            _gridStore = null;
            setGridActive(false);
          }
          syncPaneWidth();
          doScan();
          return;
        }
        // If in preview
        const pv = previewRef.current;
        if (pv && pv.agentTmuxId === agent.tmuxPaneId) {
          if (pv.zones.length) destroyZones(pv.zones);
          if (paneExists(pv.splitPaneId)) killPane(pv.splitPaneId);
          setPreview(null);
        }
        killWindow(agent.windowId || agent.paneId);
        doScan();
        return;
      }
      setConfirmKill(null);
      return;
    }

    // ── New-agent wizard ──
    if (wizard) {
      if (key.escape) { setWizard(null); return; }

      if (wizard.step === "profile") {
        if (input === "j" || key.downArrow) {
          setWizard({ ...wizard, selected: Math.min(wizard.selected + 1, wizard.profiles.length - 1) });
          return;
        }
        if (input === "k" || key.upArrow) {
          setWizard({ ...wizard, selected: Math.max(wizard.selected - 1, 0) });
          return;
        }
        if (key.return) {
          wizardAfterProfile(wizard.profiles[wizard.selected], wizard.inheritedCwd, wizard.inheritedSession);
          return;
        }
        return;
      }

      if (wizard.step === "session") {
        if (input === "j" || key.downArrow) {
          setWizard({ ...wizard, selected: Math.min(wizard.selected + 1, wizard.sessions.length - 1) });
          return;
        }
        if (input === "k" || key.upArrow) {
          setWizard({ ...wizard, selected: Math.max(wizard.selected - 1, 0) });
          return;
        }
        if (key.return) {
          wizardAfterSession(wizard.profile, wizard.sessions[wizard.selected], wizard.inheritedCwd);
          return;
        }
        return;
      }

      if (wizard.step === "cwd") {
        if (key.return && wizard.cwdValid) {
          const { profile, session, cwdInput } = wizard;
          setWizard(null);
          createWorkspace(undefined, undefined, undefined, { profile, cwd: cwdInput || undefined, tmuxSession: session || undefined });
          return;
        }
        if (key.backspace || key.delete) {
          const next = wizard.cwdInput.slice(0, -1);
          setWizard({ ...wizard, cwdInput: next, cwdValid: validateCwd(next) });
          return;
        }
        if (key.tab) {
          const { cwdInput } = wizard;
          try {
            const dir = cwdInput.endsWith("/") ? cwdInput : dirname(cwdInput);
            const prefix = cwdInput.endsWith("/") ? "" : basename(cwdInput);
            const entries = readdirSync(dir).filter((e: string) => e.startsWith(prefix) && !e.startsWith("."));
            const dirs = entries.filter((e: string) => { try { return statSync(join(dir, e)).isDirectory(); } catch { return false; } });
            if (dirs.length === 1) {
              const completed = join(dir, dirs[0]) + "/";
              setWizard({ ...wizard, cwdInput: completed, cwdValid: validateCwd(completed) });
            } else if (dirs.length > 1) {
              let common = dirs[0];
              for (const d of dirs) {
                while (!d.startsWith(common)) common = common.slice(0, -1);
              }
              if (common.length > prefix.length) {
                const completed = join(dir, common);
                setWizard({ ...wizard, cwdInput: completed, cwdValid: validateCwd(completed) });
              }
            }
          } catch {}
          return;
        }
        if (input && !key.ctrl && !key.meta && input.length === 1) {
          const next = wizard.cwdInput + input;
          setWizard({ ...wizard, cwdInput: next, cwdValid: validateCwd(next) });
          return;
        }
        return;
      }
      return;
    }

    if (key.escape) {
      if (gridRef.current) { closeGrid(); return; }
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) {
      if (gridRef.current) closeGrid();
      restorePreview();
      exit();
      return;
    }
    if (input === "j" || key.downArrow) {
      const i = Math.min(liveIndex.current, Math.max(0, agents.length - 1));
      const next = i >= agents.length - 1 ? 0 : i + 1;
      liveIndex.current = next;
      setSelectedIndex(next);
      if (agents[next]) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const agent = agents[next];
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          if (gridRef.current) gridSelectAgent(agent);
          else if (previewRef.current) switchPreview(agent);
          doScan();
        }, 400);
      }
    }
    if (input === "k" || key.upArrow) {
      const i = liveIndex.current;
      const next = i <= 0 ? Math.max(0, agents.length - 1) : i - 1;
      liveIndex.current = next;
      setSelectedIndex(next);
      if (agents[next]) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        const agent = agents[next];
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          if (gridRef.current) gridSelectAgent(agent);
          else if (previewRef.current) switchPreview(agent);
          doScan();
        }, 400);
      }
    }
    if (key.tab) {
      if (agents[idx]) {
        if (gridRef.current) {
          gridSelectAgent(agents[idx]);
        } else {
          openPreviewAndFocus(agents[idx], true);
        }
      }
      return;
    }
    if (input === "p" || input === "P") {
      if (gridRef.current) closeGrid();
      if (previewRef.current) {
        restorePreview();
      } else if (agents[idx]) {
        openPreview(agents[idx], input === "p");
      }
      return;
    }
    if (input === "s" || input === "f") {
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
    if (input === "g" || input === "G") {
      const scoped = input === "g";
      const scope = scoped && agents[idx] ? agents[idx].pane.split(":")[0] : undefined;

      const gs = gridRef.current;
      if (gs) {
        // Already in grid — check if we're switching scope
        const currentScope = (gs as any)._scope as string | undefined;
        if ((scoped && currentScope === scope) || (!scoped && !currentScope)) {
          // Same scope — toggle off
          closeGrid();
        } else {
          // Different scope — rebuild with new scope
          closeGrid();
          openGrid(scope);
        }
      } else {
        openGrid(scope);
      }
      return;
    }
    if (input === "n") {
      const profiles = getProfileNames();
      if (!profiles.length) return;
      let cwd = "";
      let inheritedSession = "";
      const sel = agents[idx];
      if (sel) {
        try { cwd = execSync(`tmux display-message -t ${sel.tmuxPaneId} -p '#{pane_current_path}'`, { encoding: "utf-8" }).trim(); } catch {}
        try { inheritedSession = execSync(`tmux display-message -t ${sel.tmuxPaneId} -p '#{session_name}'`, { encoding: "utf-8" }).trim(); } catch {}
      }
      if (profiles.length === 1) {
        wizardAfterProfile(profiles[0], cwd, inheritedSession);
      } else {
        setWizard({ step: "profile", profiles, selected: 0, inheritedCwd: cwd, inheritedSession });
      }
      return;
    }
    if (input === "x") {
      const agent = agents[idx];
      if (agent) setConfirmKill(agent);
      return;
    }
    // Space bar: same as tab
    if (input === " ") {
      if (agents[idx]) {
        if (gridRef.current) {
          gridSelectAgent(agents[idx]);
        } else {
          openPreviewAndFocus(agents[idx], true);
        }
      }
      return;
    }
    if (input === "?") {
      setShowKeys((v) => !v);
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
          <Text color="#6b7385"> «»</Text>
          {agents.map((agent, i) => {
            const sel = i === idx;
            const icon = agent.status === "attention" ? "⚠" : agent.status === "question" ? "?" : agent.status === "working" ? "●" : agent.status === "stalled" ? "◐" : "○";
            const iconColor = agent.status === "attention" ? "red" : agent.status === "question" ? "yellow" : agent.status === "working" ? "green" : agent.status === "stalled" ? "yellow" : undefined;
            const ac = agentColor(agent.agent);
            return (
              <Text key={agent.tmuxPaneId}>
                <Text color={ac} bold={sel}>{sel ? "›" : " "}{i + 1}</Text>
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
            {confirmKill ? (
              <Box flexDirection="column">
                <Text wrap="truncate" color="red">Kill workspace <Text bold>{confirmKill.pane}</Text>?</Text>
                <Text dimColor wrap="truncate">y · any key to cancel</Text>
              </Box>
            ) : wizard ? (
              <Box flexDirection="column">
                {wizard.step === "profile" && (<>
                  <Text dimColor wrap="truncate">New agent — select profile:</Text>
                  {wizard.profiles.map((name, i) => (
                    <Text key={name}>
                      <Text color={i === wizard.selected ? "cyan" : undefined} bold={i === wizard.selected}>{i === wizard.selected ? " › " : "   "}{name}</Text>
                      <Text dimColor> {resolveProfile(name).command}</Text>
                    </Text>
                  ))}
                </>)}
                {wizard.step === "session" && (<>
                  <Text dimColor wrap="truncate">New agent — select tmux session:</Text>
                  {wizard.sessions.map((name, i) => (
                    <Text key={name}>
                      <Text color={i === wizard.selected ? "cyan" : undefined} bold={i === wizard.selected}>{i === wizard.selected ? " › " : "   "}{name}</Text>
                    </Text>
                  ))}
                </>)}
                {wizard.step === "cwd" && (<>
                  <Text dimColor wrap="truncate">New agent — working directory:</Text>
                  <Text>   <Text color={wizard.cwdValid ? "green" : "red"}>{wizard.cwdInput || "(empty)"}</Text><Text color="gray">▏</Text></Text>
                  {!wizard.cwdValid && wizard.cwdInput ? <Text color="red">   path not found</Text> : null}
                  <Text dimColor>   tab to complete</Text>
                </>)}
                <Text dimColor wrap="truncate">enter · esc</Text>
              </Box>
            ) : (
              <Box flexDirection="column">
                {agents[idx] ? (() => {
                  const a = agents[idx];
                  const ac = agentColor(a.agent);
                  const statusIcon = a.status === "attention" ? "⚠" : a.status === "question" ? "❓" : a.status === "working" ? "●" : a.status === "stalled" ? "◐" : "○";
                  const statusColor = a.status === "attention" ? "red" : a.status === "question" ? "yellow" : a.status === "working" ? "green" : a.status === "stalled" ? "yellow" : undefined;
                  return (
                    <Box flexDirection="column">
                      <Text wrap="truncate">
                        {previewing && previewRef.current ? (previewRef.current.vertical ? "▶ " : "▼ ") : ""}
                        <Text bold color={ac}>{a.agent}</Text>
                        <Text color={statusColor} dimColor={!statusColor}> {statusIcon} {a.status}</Text>
                        {a.detail ? <Text color="#7b8494"> ({a.detail})</Text> : null}
                        {gridActive ? <Text color="#7b8494"> [grid]</Text> : null}
                        {previewRef.current?.helperLayout ? <Text color="#7b8494"> [{previewRef.current.helperLayout}]</Text> : null}
                      </Text>
                      <Text wrap="truncate" color="#7b8494">⌘ {a.pane}</Text>
                      {a.title ? <Text wrap="truncate" color="#7b8494">◇ {a.title}</Text> : null}
                      {a.cwd ? <Text wrap="truncate" color="#7b8494">⌂ {a.cwd}</Text> : null}
                    </Box>
                  );
                })() : null}
                <Text> </Text>
                {showKeys ? (
                  <Box flexDirection="column" borderStyle="round" borderColor="#3b4252" paddingLeft={1} paddingRight={1}>
                    <Text wrap="truncate"><Text color="#6b7385">enter</Text> <Text color="#565e6e">jump to agent</Text></Text>
                    <Text wrap="truncate"><Text color="#6b7385">tab</Text>   <Text color="#565e6e">preview</Text></Text>
                    <Text wrap="truncate"><Text color="#6b7385">p/P</Text>   <Text color="#565e6e">toggle preview</Text></Text>
                    <Text wrap="truncate"><Text color="#6b7385">g/G</Text>   <Text color="#565e6e">grid view</Text></Text>
                    <Text wrap="truncate"><Text color="#6b7385">s</Text>     <Text color="#565e6e">toggle sidebar</Text></Text>
                    <Text wrap="truncate"><Text color="#6b7385">h</Text>     <Text color="#565e6e">cycle helper layouts</Text></Text>
                    <Text wrap="truncate"><Text color="#6b7385">n</Text>     <Text color="#565e6e">new agent workspace</Text></Text>
                    <Text wrap="truncate"><Text color="#6b7385">x</Text>     <Text color="#565e6e">kill workspace</Text></Text>
                    <Text wrap="truncate"><Text color="#6b7385">q</Text>     <Text color="#565e6e">quit</Text>  <Text color="#565e6e">· ? hide</Text></Text>
                  </Box>
                ) : (
                  <Text wrap="truncate" color="#565e6e">? keys</Text>
                )}
              </Box>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
