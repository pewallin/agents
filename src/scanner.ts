import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { exec, execAsync } from "./shell.js";
import { getAgentStateEntry, readStateSnapshot } from "./state.js";
import { getMux, detectMultiplexer } from "./multiplexer.js";
import { BACK_ENV, switchBack } from "./back.js";
import type { ModelMetadata, ModelSource, StateSnapshot } from "./state.js";
import type { MuxPaneInfo } from "./multiplexer.js";
import { inferContextFromContent, inferModelFromContent, inferModelMetadataFromContent, runtimeStateFromAgent } from "./scanner-runtime.js";
import { isHookAuthoritativeAgent, mergedContextTokens, resolveModelInfo, stateContext, stateDetail, stateDuration, stateExternalSessionId, stateProvenance, stateTokens, stateWorkspaceCwd } from "./scanner-state-runtime.js";
import { extractLatestCodexOpsFromLogLines, getDetector, reconcileStaleCodexWorkingState, resolveStatusFromContent, shouldTreatCodexWorkingAsIdle } from "./scanner-detection.js";
import { createPreviewSplit, createSplitPane, findSiblingPanes, focusPane, getPaneHeight, getPaneWidth, joinPane, killPane, killPanes, killWindow, ownPaneId, paneExists, patchSnapshotId, resizePaneWidth, restoreWindowLayout, returnPaneToWindow, showPlaceholder, snapshotWindow, swapPanes, switchToPane } from "./pane-ops.js";
import type { SiblingPane, WindowSnapshot } from "./pane-ops.js";
import { buildBranchCache, buildBranchCacheAsync, buildProcessTree, buildProcessTreeAsync, detectAgentProcess, findAgentLeafInTree, findAgentOnTtyProcessInTree, findLeafProcessSync } from "./scanner-discovery.js";
import { extractClaudeRenameTitleFromTranscript, extractLatestCodexSessionTitlesFromIndexLines, loadHistoryForAgent, normalizeHistoryCwd, resolveAgentDisplayTitle } from "./scanner-history.js";
import type { AgentSessionHistoryItem } from "./scanner-history.js";
import type { AgentPane, AgentRuntimeState, AgentStatus } from "./scanner-types.js";
export type { AgentPane, AgentRuntimeState, AgentStatus } from "./scanner-types.js";
export type { AgentSessionHistoryItem } from "./scanner-history.js";
export { extractLatestCodexTokenUsageFromSessionLines, inferContextFromContent, inferModelFromContent, inferModelMetadataFromContent } from "./scanner-runtime.js";
export { extractLatestCodexOpsFromLogLines, getDetector, reconcileStaleCodexWorkingState, shouldTreatCodexWorkingAsIdle } from "./scanner-detection.js";
export { detectAgentProcess } from "./scanner-discovery.js";
export { extractClaudeRenameTitleFromTranscript, extractLatestCodexSessionTitlesFromIndexLines } from "./scanner-history.js";
export { createPreviewSplit, createSplitPane, findSiblingPanes, focusPane, getPaneHeight, getPaneWidth, joinPane, killPane, killPanes, killWindow, ownPaneId, paneExists, patchSnapshotId, resizePaneWidth, restoreWindowLayout, returnPaneToWindow, showPlaceholder, snapshotWindow, swapPanes, switchToPane } from "./pane-ops.js";

export interface AgentSessionHistoryGroup {
  agent: string;
  cwd: string;
  pane?: string;
  tmuxPaneId?: string;
  currentSessionId?: string;
  sessions: AgentSessionHistoryItem[];
}

// ── Per-agent detection ──────────────────────────────────────────────

type HistoryTarget = { cwdRaw: string; pane?: string; tmuxPaneId?: string; currentSessionId?: string };

function collectHistoryTargets(agentFilter?: string, cwdOverride?: string): Map<string, HistoryTarget[]> {
  const agents = ["claude", "codex", "copilot", "opencode", "pi", "cursor"];
  const wantedAgents = agentFilter ? agents.filter((agent) => agent === agentFilter) : agents;
  const targets = new Map<string, HistoryTarget[]>();
  const stateSnapshot = readStateSnapshot();

  const addTarget = (agent: string, target: HistoryTarget) => {
    if (!wantedAgents.includes(agent)) return;
    const list = targets.get(agent) || [];
    if (!list.some((existing) => existing.cwdRaw === target.cwdRaw)) list.push(target);
    targets.set(agent, list);
  };

  if (cwdOverride) {
    const cwdRaw = normalizeHistoryCwd(cwdOverride);
    for (const agent of wantedAgents) addTarget(agent, { cwdRaw });
    return targets;
  }

  for (const pane of scan()) {
    const agent = pane.agent.toLowerCase();
    const cwdRaw = stateWorkspaceCwd(agent, pane.tmuxPaneId, stateSnapshot) || (pane.cwd ? normalizeHistoryCwd(pane.cwd) : undefined);
    if (!cwdRaw) continue;
    addTarget(agent, {
      cwdRaw,
      pane: pane.pane,
      tmuxPaneId: pane.tmuxPaneId,
      currentSessionId: stateExternalSessionId(agent, pane.tmuxPaneId, stateSnapshot),
    });
  }

  if (targets.size === 0) {
    const cwdRaw = process.cwd();
    for (const agent of wantedAgents) addTarget(agent, { cwdRaw });
  }

  return targets;
}

export function getSessionHistory(opts: { agent?: string; cwd?: string; limit?: number } = {}): AgentSessionHistoryGroup[] {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 5));
  const agentFilter = opts.agent?.toLowerCase();
  const groups: AgentSessionHistoryGroup[] = [];
  const targets = collectHistoryTargets(agentFilter, opts.cwd);

  for (const [agent, agentTargets] of targets.entries()) {
    for (const target of agentTargets) {
      const sessions = loadHistoryForAgent(agent, target.cwdRaw, limit, target.currentSessionId);
      if (sessions.length === 0) continue;
      groups.push({
        agent,
        cwd: target.cwdRaw,
        ...(target.pane ? { pane: target.pane } : {}),
        ...(target.tmuxPaneId ? { tmuxPaneId: target.tmuxPaneId } : {}),
        ...(target.currentSessionId ? { currentSessionId: target.currentSessionId } : {}),
        sessions,
      });
    }
  }

  return groups.sort((a, b) => a.agent.localeCompare(b.agent) || a.cwd.localeCompare(b.cwd));
}

// Map binary names to display names (e.g. if your agent binary differs)
const FRIENDLY_NAMES: Record<string, string> = {};



/** Check if a pane title is meaningful (not a default/command-prefix title). */
function isTitleUseful(title: string): boolean {
  if (!title || title.length === 0) return false;
  // Reject titles that look like "agent:x" command prefixes (e.g., "pi:c")
  if (/^[a-z]+:[a-z]$/i.test(title)) return false;
  return true;
}

/** Sanitize pane title: strip spinner chars, control chars, and reject escape sequence leaks. */
function cleanTitle(raw: string): string {
  // Strip braille spinners
  let t = raw.replace(/^[\u2801-\u28FF] */u, "");
  // Strip control characters (except normal whitespace)
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Reject if it looks like a leaked escape sequence (DA response, etc.)
  if (/\x1b\[|[\x00-\x1f]/.test(raw)) return "";
  return t;
}

function friendlyName(name: string): string {
  return FRIENDLY_NAMES[name] ?? name;
}

interface PaneContentSnapshot {
  tail?: string;
  full?: string;
}

function normalizePaneContent(raw: string): string {
  return raw.replace(/\n{3,}/g, "\n\n");
}

function capturePaneTailSync(target: string): string {
  return normalizePaneContent(exec(`tmux capture-pane -t ${JSON.stringify(target)} -p -S -20 2>/dev/null`));
}

async function capturePaneTailAsync(target: string): Promise<string> {
  return normalizePaneContent(await execAsync(`tmux capture-pane -t ${JSON.stringify(target)} -p -S -20 2>/dev/null`));
}

function capturePaneFullSync(target: string): string {
  return exec(`tmux capture-pane -t ${JSON.stringify(target)} -p 2>/dev/null`);
}

async function capturePaneFullAsync(target: string): Promise<string> {
  return execAsync(`tmux capture-pane -t ${JSON.stringify(target)} -p 2>/dev/null`);
}

async function detectStatus(
  paneRef: string,
  title: string,
  windowActivity: number,
  agent: string,
  tmuxPaneId?: string,
  snapshot?: StateSnapshot,
  content?: PaneContentSnapshot,
): Promise<{ status: AgentStatus; detail?: string }> {
  const captureTarget = tmuxPaneId || paneRef;
  const tailContent = content?.tail ?? await capturePaneTailAsync(captureTarget);
  const fullPane = content?.full ?? await capturePaneFullAsync(captureTarget);
  return resolveStatusFromContent(title, windowActivity, agent, tailContent, tmuxPaneId, snapshot, fullPane);
}

// Sync version for CLI commands that don't need async
export function scan(): AgentPane[] {
  if (detectMultiplexer() === "zellij") {
    return processZellijPanes(getMux().listPanes());
  }
  return scanSync();
}

export function runtimeStates(paneIds?: string[]): AgentRuntimeState[] {
  if (!paneIds?.length) {
    return scan().map(runtimeStateFromAgent);
  }

  if (detectMultiplexer() === "zellij") {
    const filter = new Set(paneIds);
    return processZellijPanes(getMux().listPanes())
      .filter((agent) => filter.has(agent.tmuxPaneId))
      .map(runtimeStateFromAgent);
  }

  const raw = exec(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
  );
  if (!raw) return [];

  const paneSet = new Set(paneIds);
  const paneOrder = new Map(paneIds.map((paneId, index) => [paneId, index]));
  const tree = buildProcessTree();
  const stateSnapshot = readStateSnapshot();
  const results: AgentRuntimeState[] = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [pane, pid, title, winname, _fgcmd, wactStr, tty, _paneId, tmuxPaneId] = line.split("§");
    if (!paneSet.has(tmuxPaneId)) continue;

    const session = pane.split(":")[0];
    if (session.startsWith("_agents_")) continue;

    const pidNum = parseInt(pid, 10) || 0;
    const leaf = findAgentLeafInTree(pidNum, tree);
    const ttyMatch = !leaf && tty ? findAgentOnTtyProcessInTree(tty, tree) : null;
    const matchedProcess = leaf ?? ttyMatch;
    if (!matchedProcess) continue;
    const agentName = matchedProcess.agentName;

    const resolvedTitle = isTitleUseful(title) ? title : winname || title;
    const wact = parseInt(wactStr, 10) || 0;
    const usesHookRuntime = isHookAuthoritativeAgent(agentName);
    const tailContent = usesHookRuntime ? "" : capturePaneTailSync(tmuxPaneId);
    const { status, detail } = usesHookRuntime
      ? resolveStatusFromContent(resolvedTitle, wact, agentName, "", tmuxPaneId, stateSnapshot, "")
      : detectStatusSync(pane, resolvedTitle, wact, agentName, tmuxPaneId, stateSnapshot, { tail: tailContent });
    const richDetail = stateDetail(agentName, tmuxPaneId, stateSnapshot);
    const context = stateContext(agentName, tmuxPaneId, stateSnapshot);
    const provenance = stateProvenance(agentName, tmuxPaneId, stateSnapshot);
    const storedTokens = stateTokens(agentName, tmuxPaneId, stateSnapshot);
    const modelInfo = resolveModelInfo(agentName, tmuxPaneId, tailContent, stateSnapshot);
    const tokenInfo = storedTokens.contextTokens !== undefined || storedTokens.contextMax !== undefined
      ? storedTokens
      : mergedContextTokens(
        agentName,
        tmuxPaneId,
        tailContent,
        stateSnapshot,
      );

    results.push({
      session: tmuxPaneId,
      status,
      cpuPercent: matchedProcess.process?.cpuPercent ?? 0,
      memoryMB: matchedProcess.process?.memoryMB ?? 0,
      ...(richDetail || detail ? { detail: richDetail || detail } : {}),
      ...modelInfo,
      ...(context ? { context } : {}),
      ...(tokenInfo.contextTokens !== undefined ? { contextTokens: tokenInfo.contextTokens } : {}),
      ...(tokenInfo.contextMax !== undefined ? { contextMax: tokenInfo.contextMax } : {}),
      ...provenance,
    });
  }

  results.sort((a, b) => (paneOrder.get(a.session) ?? Number.MAX_SAFE_INTEGER) - (paneOrder.get(b.session) ?? Number.MAX_SAFE_INTEGER));
  return results;
}

// ── Zellij scan path ────────────────────────────────────────────────
// Single implementation used by both sync and async entry points.

function processZellijPanes(panes: MuxPaneInfo[]): AgentPane[] {
  const mux = getMux();
  const results: AgentPane[] = [];
  const stateSnapshot = readStateSnapshot();

  for (const p of panes) {
    let agentName: string | null = null;

    if (p.pid) {
      // Check the PID itself first — in zellij the returned PID is often
      // the agent process directly (not a shell), and its children may be
      // non-agent subprocesses (e.g. caffeinate, node).
      agentName = detectAgentProcess("", exec(`ps -p ${p.pid} -o args= 2>/dev/null`));
      if (!agentName) {
        const leafCmd = findLeafProcessSync(String(p.pid));
        if (leafCmd) agentName = leafCmd;
      }
    }

    // Fallback: check the command string from zellij (may include args)
    if (!agentName && p.command) {
      agentName = detectAgentProcess("", p.command);
    }

    if (!agentName) continue;

    const usesHookRuntime = isHookAuthoritativeAgent(agentName);
    const content = usesHookRuntime ? "" : mux.getPaneContent(p.id, 20);
    const { status, detail } = resolveStatusFromContent(p.title, 0, agentName, content, p.id, stateSnapshot, content);

    const paneRef = `${p.session}:${p.tab}`;
    const titleClean = cleanTitle(p.title);

    const zellijCwd = p.cwd?.replace(homedir(), "~") || undefined;
    const externalSessionId = stateExternalSessionId(agentName, p.id, stateSnapshot);
    const zellijBranch = p.cwd ? exec(`git -C ${JSON.stringify(p.cwd)} rev-parse --abbrev-ref HEAD 2>/dev/null`) || undefined : undefined;

    // Prefer rich detail from state (e.g. "reading main.ts") over bare duration
    const richDetail = stateDetail(agentName, p.id, stateSnapshot);
    const finalDetail = richDetail || detail;
    const modelInfo = resolveModelInfo(agentName, p.id, content, stateSnapshot);
    const tokenInfo = mergedContextTokens(agentName, p.id, content, stateSnapshot);
    const provenance = stateProvenance(agentName, p.id, stateSnapshot);

    results.push({
      pane: paneRef,
      paneId: paneRef,
      tmuxPaneId: p.id,
      title: resolveAgentDisplayTitle(agentName, p.cwd, externalSessionId, titleClean),
      agent: friendlyName(agentName),
      status,
      cpuPercent: 0,
      memoryMB: 0,
      detail: finalDetail,
      ...modelInfo,
      windowId: paneRef,
      cwd: zellijCwd,
      branch: zellijBranch,
      context: stateContext(agentName, p.id, stateSnapshot),
      ...tokenInfo,
      ...provenance,
    });
  }

  results.sort((a, b) => a.pane.localeCompare(b.pane));
  return results;
}

function scanSync(): AgentPane[] {
  const raw = exec(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
  );
  if (!raw) return [];

  // Build process tree once — replaces per-pane pgrep/ps calls
  const tree = buildProcessTree();
  const stateSnapshot = readStateSnapshot();
  // Pass 1: identify agent panes and collect unique cwds
  type ParsedPane = {
    pane: string;
    pid: string;
    title: string;
    wactStr: string;
    tty: string;
    paneId: string;
    tmuxPaneId: string;
    cwdRaw: string;
    agentName: string;
    cpuPercent: number;
    memoryMB: number;
  };
  const agentPanes: ParsedPane[] = [];
  const uniqueCwds = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [pane, pid, title, winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId, cwdRaw] = line.split("§");

    const session = pane.split(":")[0];
    if (session.startsWith("_agents_")) continue;

    const pidNum = parseInt(pid, 10) || 0;
    const leaf = findAgentLeafInTree(pidNum, tree);
    const ttyMatch = !leaf && tty ? findAgentOnTtyProcessInTree(tty, tree) : null;
    const matchedProcess = leaf ?? ttyMatch;
    if (!matchedProcess) continue;
    const agentName = matchedProcess.agentName;

    // Use window_name as fallback when pane_title is unhelpful
    // (e.g., "pi:c" from agents that don't set a useful terminal title)
    const resolvedTitle = isTitleUseful(title) ? title : winname || title;
    agentPanes.push({
      pane,
      pid,
      title: resolvedTitle,
      wactStr,
      tty,
      paneId,
      tmuxPaneId,
      cwdRaw,
      agentName,
      cpuPercent: matchedProcess.process?.cpuPercent ?? 0,
      memoryMB: matchedProcess.process?.memoryMB ?? 0,
    });
    if (cwdRaw) uniqueCwds.add(cwdRaw);
  }

  // Batch git branch lookup — single shell invocation for all unique cwds
  const branchCache = buildBranchCache(uniqueCwds);

  // Pass 2: detect status and build results
  const results: AgentPane[] = [];
  for (const p of agentPanes) {
    const wact = parseInt(p.wactStr, 10) || 0;
    const usesHookRuntime = isHookAuthoritativeAgent(p.agentName);
    const tailContent = usesHookRuntime ? "" : capturePaneTailSync(p.tmuxPaneId);
    const { status, detail } = usesHookRuntime
      ? resolveStatusFromContent(p.title, wact, p.agentName, "", p.tmuxPaneId, stateSnapshot, "")
      : detectStatusSync(p.pane, p.title, wact, p.agentName, p.tmuxPaneId, stateSnapshot, { tail: tailContent });
    const richDetail = stateDetail(p.agentName, p.tmuxPaneId, stateSnapshot);
    const finalDetail = richDetail || detail;
    const paneShort = p.pane.replace(/\.\d+$/, "");
    const titleClean = cleanTitle(p.title);
    const cwd = p.cwdRaw?.replace(homedir(), "~") || undefined;
    const branch = branchCache.get(p.cwdRaw);
    const externalSessionId = stateExternalSessionId(p.agentName, p.tmuxPaneId, stateSnapshot);
    const modelInfo = resolveModelInfo(p.agentName, p.tmuxPaneId, tailContent, stateSnapshot);
    const tokenInfo = mergedContextTokens(p.agentName, p.tmuxPaneId, tailContent, stateSnapshot);
    const provenance = stateProvenance(p.agentName, p.tmuxPaneId, stateSnapshot);

    results.push({
      pane: paneShort,
      paneId: p.paneId,
      tmuxPaneId: p.tmuxPaneId,
      title: resolveAgentDisplayTitle(p.agentName, p.cwdRaw, externalSessionId, titleClean),
      agent: friendlyName(p.agentName),
      status,
      cpuPercent: p.cpuPercent,
      memoryMB: p.memoryMB,
      detail: finalDetail,
      ...modelInfo,
      windowId: p.paneId,
      cwd,
      branch,
      context: stateContext(p.agentName, p.tmuxPaneId, stateSnapshot),
      ...tokenInfo,
      ...provenance,
    } as AgentPane);
  }

  results.sort((a, b) => a.pane.localeCompare(b.pane) || a.tmuxPaneId.localeCompare(b.tmuxPaneId));
  return results;
}

function detectStatusSync(
  paneRef: string,
  title: string,
  windowActivity: number,
  agent: string,
  tmuxPaneId?: string,
  snapshot?: StateSnapshot,
  contentSnapshot?: PaneContentSnapshot,
): { status: AgentStatus; detail?: string } {
  const captureTarget = tmuxPaneId || paneRef;
  const tailContent = contentSnapshot?.tail ?? capturePaneTailSync(captureTarget);
  const fullPane = contentSnapshot?.full ?? capturePaneFullSync(captureTarget);
  return resolveStatusFromContent(title, windowActivity, agent, tailContent, tmuxPaneId, snapshot, fullPane);
}

// Async version for watch mode — doesn't block the Ink render loop
export async function scanAsync(): Promise<AgentPane[]> {
  if (detectMultiplexer() === "zellij") {
    // Zellij scan uses sync subprocess calls (zellij pipe doesn't work
    // reliably with async exec — the process hangs until timeout).
    // Use the same code path as scan() for consistency.
    return processZellijPanes(getMux().listPanes());
  }
  const raw = await execAsync(
    `tmux list-panes -a -F '#{session_name}:#{window_name}.#{pane_index}§#{pane_pid}§#{pane_title}§#{window_name}§#{pane_current_command}§#{window_activity}§#{pane_tty}§#{session_name}:#{window_index}§#{pane_id}§#{pane_current_path}' 2>/dev/null`
  );
  if (!raw) return [];

  const lines = raw.split("\n").filter(Boolean);
  const tree = await buildProcessTreeAsync();
  const stateSnapshot = readStateSnapshot();
  type ParsedPane = {
    pane: string;
    title: string;
    wactStr: string;
    paneId: string;
    tmuxPaneId: string;
    cwdRaw: string;
    agentName: string;
    cpuPercent: number;
    memoryMB: number;
  };
  const agentPanes: ParsedPane[] = [];
  const uniqueCwds = new Set<string>();

  for (const line of lines) {
    const [pane, pid, title, winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId, cwdRaw] = line.split("§");
    const session = pane.split(":")[0];
    if (session.startsWith("_agents_")) continue;

    const pidNum = parseInt(pid, 10) || 0;
    const leaf = findAgentLeafInTree(pidNum, tree);
    const ttyMatch = !leaf && tty ? findAgentOnTtyProcessInTree(tty, tree) : null;
    const matchedProcess = leaf ?? ttyMatch;
    if (!matchedProcess) continue;
    const agentName = matchedProcess.agentName;

    const resolvedTitle = isTitleUseful(title) ? title : winname || title;
    agentPanes.push({
      pane,
      title: resolvedTitle,
      wactStr,
      paneId,
      tmuxPaneId,
      cwdRaw,
      agentName,
      cpuPercent: matchedProcess.process?.cpuPercent ?? 0,
      memoryMB: matchedProcess.process?.memoryMB ?? 0,
    });
    if (cwdRaw) uniqueCwds.add(cwdRaw);
  }

  const branchCache = await buildBranchCacheAsync(uniqueCwds);

  const promises = agentPanes.map(async (p) => {
    const wact = parseInt(p.wactStr, 10) || 0;
    const usesHookRuntime = isHookAuthoritativeAgent(p.agentName);
    const tailContent = usesHookRuntime ? "" : await capturePaneTailAsync(p.tmuxPaneId);
    const { status, detail } = usesHookRuntime
      ? resolveStatusFromContent(p.title, wact, p.agentName, "", p.tmuxPaneId, stateSnapshot, "")
      : await detectStatus(p.pane, p.title, wact, p.agentName, p.tmuxPaneId, stateSnapshot, { tail: tailContent });
    const richDetail = stateDetail(p.agentName, p.tmuxPaneId, stateSnapshot);
    const finalDetail = richDetail || detail;
    const paneShort = p.pane.replace(/\.\d+$/, "");
    const titleClean = cleanTitle(p.title);
    const cwd = p.cwdRaw?.replace(homedir(), "~") || undefined;
    const branch = branchCache.get(p.cwdRaw);
    const externalSessionId = stateExternalSessionId(p.agentName, p.tmuxPaneId, stateSnapshot);
    const modelInfo = resolveModelInfo(p.agentName, p.tmuxPaneId, tailContent, stateSnapshot);
    const tokenInfo = mergedContextTokens(p.agentName, p.tmuxPaneId, tailContent, stateSnapshot);
    const provenance = stateProvenance(p.agentName, p.tmuxPaneId, stateSnapshot);

    return {
      pane: paneShort,
      paneId: p.paneId,
      tmuxPaneId: p.tmuxPaneId,
      title: resolveAgentDisplayTitle(p.agentName, p.cwdRaw, externalSessionId, titleClean),
      agent: friendlyName(p.agentName),
      status,
      cpuPercent: p.cpuPercent,
      memoryMB: p.memoryMB,
      detail: finalDetail,
      ...modelInfo,
      windowId: p.paneId,
      cwd,
      branch,
      context: stateContext(p.agentName, p.tmuxPaneId, stateSnapshot),
      ...tokenInfo,
      ...provenance,
    } as AgentPane;
  });

  const results = (await Promise.all(promises)).filter((r): r is AgentPane => r !== null);

  results.sort((a, b) => a.pane.localeCompare(b.pane) || a.tmuxPaneId.localeCompare(b.tmuxPaneId));
  return results;
}

// ── Scan result filtering ────────────────────────────────────────────

export interface PreviewFilter {
  agentTmuxId: string;
  splitPaneId: string;
  agentPane: string;
  agentPaneId: string;
}

export interface GridFilter {
  agents: { tmuxPaneId: string; pane: string; paneId?: string; windowId?: string }[];
  placeholderIds: string[];
}

/**
 * Filter scan results for the dashboard:
 * 1. Remove the dashboard's own pane and window
 * 2. Re-add previewed/gridded agents with their original pane names
 *
 * Pure function — no side effects, easy to test.
 */
export function filterAgents(
  scanned: AgentPane[],
  selfPaneId: string,
  selfWindowId: string,
  preview?: PreviewFilter | null,
  grid?: GridFilter | null,
): AgentPane[] {
  // 1. Remove self
  let list = scanned.filter((a) => a.tmuxPaneId !== selfPaneId && a.windowId !== selfWindowId);

  // 2. Preview: agent pane is swapped into dashboard window, re-add with original name
  if (preview) {
    const swapped = scanned.find((a) => a.tmuxPaneId === preview.agentTmuxId);
    list = list.filter(
      (a) => a.tmuxPaneId !== preview.agentTmuxId && a.tmuxPaneId !== preview.splitPaneId
    );
    if (swapped) {
      list.push({ ...swapped, pane: preview.agentPane, paneId: preview.agentPaneId });
    }
  }

  // 3. Grid: agents are swapped into dashboard window, re-add with original names
  if (grid) {
    const gridPaneIds = new Set(grid.agents.map((a) => a.tmuxPaneId));
    const placeholderIds = new Set(grid.placeholderIds);
    list = list.filter((a) => !gridPaneIds.has(a.tmuxPaneId) && !placeholderIds.has(a.tmuxPaneId));
    for (const ga of grid.agents) {
      const found = scanned.find((a) => a.tmuxPaneId === ga.tmuxPaneId);
      if (found) {
        list.push({
          ...found,
          pane: ga.pane,
          paneId: ga.paneId || found.paneId,
          windowId: ga.windowId || found.windowId,
        });
      }
    }
  }

  list.sort((a, b) => a.pane.localeCompare(b.pane));
  return list;
}
