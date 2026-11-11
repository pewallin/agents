import { existsSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { exec, gitBranch } from "./shell.js";
import { getAgentStateEntry, readStateSnapshot, rebindStateSnapshotToExternalSession } from "./state.js";
import type { ModelMetadata, ModelSource, StateSnapshot } from "./state.js";
import { inferContextFromContent, inferModelFromContent, inferModelMetadataFromContent, runtimeStateFromAgent } from "./scanner-runtime.js";
import { mergedContextTokens, resolveModelInfo, stateContext, stateDetail, stateExternalSessionId, stateIntent, stateProvenance, stateResponsePreview, stateTokens, stateWorkspaceCwd } from "./scanner-state-runtime.js";
import { resolveStatusFromContent } from "./scanner-detection.js";
import { buildBranchCache, buildProcessTree, detectAgentProcess, findAgentLeafInTree, findAgentOnTtyProcessInTree, findLeafProcessSync, findOpenCodexSessionIds, findPrimaryAgentForReporterInTree } from "./scanner-discovery.js";
import type { AgentLeafProcess } from "./scanner-discovery.js";
import { extractClaudeRenameTitleFromTranscript, extractLatestCodexSessionTitlesFromIndexLines, loadHistoryForAgent, normalizeHistoryCwd, resolveAgentDisplayTitle } from "./scanner-history.js";
import type { AgentSessionHistoryItem } from "./scanner-history.js";
import type { AgentPane, AgentRuntimeState, AgentStatus } from "./scanner-types.js";
export type { AgentPane, AgentRuntimeState, AgentStatus } from "./scanner-types.js";
export type { AgentSessionHistoryItem } from "./scanner-history.js";
export { extractLatestCodexTokenUsageFromSessionLines, extractLatestCodexTokenUsageSampleFromSessionLines, inferContextFromContent, inferModelFromContent, inferModelMetadataFromContent } from "./scanner-runtime.js";
export { codexStreamDisconnectStatus, extractLatestCodexOpEntriesFromLogLines, extractLatestCodexOpsFromLogLines, extractLatestCodexStreamDisconnectEntriesFromLogLines, getDetector, reconcileStaleCodexWorkingState, shouldTreatCodexWorkingAsIdle } from "./scanner-detection.js";
export { detectAgentProcess, extractOpenCodexSessionIds } from "./scanner-discovery.js";
export { extractClaudeRenameTitleFromTranscript, extractLatestCodexSessionTitlesFromIndexLines } from "./scanner-history.js";
export { switchToPane } from "./pane-ops.js";

export interface AgentSessionHistoryGroup {
  agent: string;
  cwd: string;
  pane?: string;
  tmuxPaneId?: string;
  currentSessionId?: string;
  limit: number;
  hasMore: boolean;
  sessions: AgentSessionHistoryItem[];
}

// ── Per-agent detection ──────────────────────────────────────────────

type HistoryTarget = { cwdRaw: string; pane?: string; tmuxPaneId?: string; currentSessionId?: string; currentTitle?: string };

function processArgv(args?: string): string[] {
  return (args || "").trim().split(/\s+/).filter(Boolean);
}

function processTokenBasename(token: string): string {
  return basename(token.replace(/^['"]+|['"]+$/g, "")).replace(/^-/, "").toLowerCase();
}

function processTokenAgentName(token: string): string {
  const normalized = processTokenBasename(token);
  if (normalized === "kiro-cli" || normalized === "kiro-cli-chat") return "kiro";
  return normalized;
}

export function externalSessionIdFromProcessArgs(agent: string, args?: string): string | undefined {
  const argv = processArgv(args);
  const agentIndex = argv.findIndex((token) => processTokenAgentName(token) === agent.toLowerCase());
  if (agentIndex < 0) return undefined;
  const agentArgs = argv.slice(agentIndex + 1);

  switch (agent.toLowerCase()) {
    case "codex": {
      const resumeIndex = agentArgs.indexOf("resume");
      if (resumeIndex < 0) return undefined;
      const tail = agentArgs.slice(resumeIndex + 1);
      for (let i = 0; i < tail.length; i += 1) {
        const arg = tail[i];
        if (arg === "--last") continue;
        if (arg === "--") return tail[i + 1];
        if (arg === "-c" || arg === "--config") {
          i += 1;
          continue;
        }
        if (arg.startsWith("--config=") || arg.startsWith("-c=")) continue;
        if (arg.startsWith("-")) continue;
        return arg;
      }
      return undefined;
    }
    case "opencode": {
      const sessionIndex = agentArgs.indexOf("--session");
      const target = sessionIndex >= 0 ? agentArgs[sessionIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    case "pi": {
      const sessionArg = agentArgs.find((arg) => arg.startsWith("--session="));
      if (sessionArg) return sessionArg.slice("--session=".length) || undefined;
      const sessionIndex = agentArgs.indexOf("--session");
      const target = sessionIndex >= 0 ? agentArgs[sessionIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    case "copilot": {
      const resumeArg = agentArgs.find((arg) => arg.startsWith("--resume="));
      if (resumeArg) return resumeArg.slice("--resume=".length) || undefined;
      const resumeIndex = agentArgs.indexOf("--resume");
      const target = resumeIndex >= 0 ? agentArgs[resumeIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    case "claude": {
      const resumeIndex = agentArgs.indexOf("--resume");
      const target = resumeIndex >= 0 ? agentArgs[resumeIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    case "kiro": {
      const resumeIdArg = agentArgs.find((arg) => arg.startsWith("--resume-id="));
      if (resumeIdArg) return resumeIdArg.slice("--resume-id=".length) || undefined;
      const resumeIdIndex = agentArgs.indexOf("--resume-id");
      const target = resumeIdIndex >= 0 ? agentArgs[resumeIdIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    default:
      return undefined;
  }
}

export function resolveAgentExternalSessionId(input: {
  observedProcessSessionId?: string;
  processSessionId?: string;
  stateSessionId?: string;
}): string | undefined {
  return input.stateSessionId || input.observedProcessSessionId || input.processSessionId;
}

export function resolveTmuxAgentProcess(
  matchedProcess: AgentLeafProcess | null,
  commandContentKind?: string,
  commandLaunch?: string,
  hasActiveRuntimeEvidence = false,
  allowMetadataFallback = true,
): AgentLeafProcess | null {
  if (matchedProcess) return matchedProcess;
  if (!allowMetadataFallback || !hasActiveRuntimeEvidence || commandContentKind !== "agent" || !commandLaunch) return null;
  const agentName = detectAgentProcess("", commandLaunch);
  return agentName ? { agentName, process: null } : null;
}

export function hasActiveTmuxMetadataRuntimeEvidence(
  commandLaunch: string | undefined,
  tmuxPaneId: string,
  stateSnapshot: StateSnapshot,
  agentsUUID?: string,
  paneDead?: string,
  workspaceRenderMode?: string,
): boolean {
  // AgentsNext web surfaces keep a live, UUID-owned shell pane while the agent
  // runs outside the pane process tree. The URL render mode distinguishes that
  // surface from a shell pane carrying stale launch metadata. CLI-created panes
  // have no UUID, and an exited app-launched terminal agent has pane_dead=1.
  if (!commandLaunch || !agentsUUID || paneDead !== "0" || workspaceRenderMode !== "url") return false;
  const agentName = detectAgentProcess("", commandLaunch);
  if (!agentName) return false;
  const externalSessionId = externalSessionIdFromProcessArgs(agentName, commandLaunch);
  if (!externalSessionId) return false;
  const state = getAgentStateEntry(agentName, tmuxPaneId, stateSnapshot);
  return state?.state !== "idle"
    && state?.externalSessionId === externalSessionId;
}

const TMUX_SCAN_FIELD_SEPARATOR = "\u001f";
const TMUX_SCAN_RECORD_SEPARATOR = "\u001e";
const TMUX_SCAN_FORMAT = [
  "#{session_name}:#{window_name}.#{pane_index}",
  "#{pane_pid}",
  "#{pane_title}",
  "#{window_name}",
  "#{pane_current_command}",
  "#{window_activity}",
  "#{pane_tty}",
  "#{session_name}:#{window_index}",
  "#{pane_id}",
  "#{pane_current_path}",
  "#{@agents_command_content_kind}",
  "#{@agents_command_launch}",
  "#{@agents_uuid}",
  "#{pane_dead}",
  "#{@agents_workspace_render}",
].join(TMUX_SCAN_FIELD_SEPARATOR) + TMUX_SCAN_RECORD_SEPARATOR;

export function parseTmuxScanRecords(raw: string): string[][] {
  return raw
    .split(TMUX_SCAN_RECORD_SEPARATOR)
    .filter(Boolean)
    .map((record) => record.replace(/^\r?\n/, "").split(TMUX_SCAN_FIELD_SEPARATOR));
}

export function matchesHistoryPaneFilter(
  pane: Pick<AgentPane, "pane" | "paneId" | "tmuxPaneId" | "windowId">,
  paneFilter: string,
): boolean {
  const normalized = paneFilter.trim();
  if (!normalized) return false;

  const identifiers = [pane.tmuxPaneId, pane.pane, pane.paneId, pane.windowId].filter(
    (value): value is string => !!value,
  );
  if (identifiers.includes(normalized)) return true;

  return identifiers.some((identifier) => {
    if (identifier.includes(":")) return false;
    return normalized.endsWith(`:${identifier}`);
  });
}

function collectHistoryTargets(agentFilter?: string, cwdOverride?: string, paneFilter?: string): Map<string, HistoryTarget[]> {
  const agents = ["claude", "codex", "copilot", "opencode", "pi", "cursor", "kiro"];
  const wantedAgents = agentFilter ? agents.filter((agent) => agent === agentFilter) : agents;
  const targets = new Map<string, HistoryTarget[]>();
  const stateSnapshot = readStateSnapshot();

  const addTarget = (agent: string, target: HistoryTarget) => {
    if (!wantedAgents.includes(agent)) return;
    const list = targets.get(agent) || [];
    const exists = list.some((existing) => {
      if (target.tmuxPaneId || existing.tmuxPaneId) return existing.tmuxPaneId === target.tmuxPaneId;
      return existing.cwdRaw === target.cwdRaw;
    });
    if (!exists) list.push(target);
    targets.set(agent, list);
  };

  if (paneFilter) {
    for (const pane of scan()) {
      if (!matchesHistoryPaneFilter(pane, paneFilter)) continue;
      const agent = pane.agent.toLowerCase();
      const cwdRaw = stateWorkspaceCwd(agent, pane.tmuxPaneId, stateSnapshot) || (pane.cwd ? normalizeHistoryCwd(pane.cwd) : undefined);
      if (!cwdRaw) continue;
      for (const historyAgent of wantedAgents) {
        if (historyAgent === agent) {
          addTarget(historyAgent, {
            cwdRaw,
            pane: pane.pane,
            tmuxPaneId: pane.tmuxPaneId,
            currentSessionId: pane.externalSessionId || stateExternalSessionId(agent, pane.tmuxPaneId, stateSnapshot),
            currentTitle: pane.title,
          });
        } else {
          addTarget(historyAgent, { cwdRaw });
        }
      }
    }
    return targets;
  }

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
      currentSessionId: pane.externalSessionId || stateExternalSessionId(agent, pane.tmuxPaneId, stateSnapshot),
      currentTitle: pane.title,
    });
  }

  if (targets.size === 0) {
    const cwdRaw = process.cwd();
    for (const agent of wantedAgents) addTarget(agent, { cwdRaw });
  }

  return targets;
}

export function getSessionHistory(opts: { agent?: string; cwd?: string; pane?: string; limit?: number } = {}): AgentSessionHistoryGroup[] {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 5));
  const agentFilter = opts.agent?.toLowerCase();
  const groups: AgentSessionHistoryGroup[] = [];
  const targets = collectHistoryTargets(agentFilter, opts.cwd, opts.pane);

  for (const [agent, agentTargets] of targets.entries()) {
    for (const target of agentTargets) {
      const loadedSessions = loadHistoryForAgent(agent, target.cwdRaw, limit + 1, target.currentSessionId, target.currentTitle);
      const hasMore = loadedSessions.length > limit;
      const sessions = loadedSessions.slice(0, limit);
      if (sessions.length === 0) continue;
      groups.push({
        agent,
        cwd: target.cwdRaw,
        ...(target.pane ? { pane: target.pane } : {}),
        ...(target.tmuxPaneId ? { tmuxPaneId: target.tmuxPaneId } : {}),
        ...(target.currentSessionId ? { currentSessionId: target.currentSessionId } : {}),
        limit,
        hasMore,
        sessions,
      });
    }
  }

  return groups.sort((a, b) => a.agent.localeCompare(b.agent) || a.cwd.localeCompare(b.cwd));
}

// Map binary names to display names (e.g. if your agent binary differs)
const FRIENDLY_NAMES: Record<string, string> = {};



/** Check if a pane title is meaningful (not a default/command-prefix title). */
function isTitleUseful(title: string | null | undefined): boolean {
  const normalizedTitle = cleanTitle(title);
  if (!normalizedTitle || normalizedTitle.length === 0) return false;
  // Reject titles that look like "agent:x" command prefixes (e.g., "pi:c")
  if (/^[a-z]+:[a-z]$/i.test(normalizedTitle)) return false;
  return true;
}

/** Sanitize pane title: strip spinner chars, control chars, and reject escape sequence leaks. */
function cleanTitle(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  // Strip braille spinners
  let t = raw.replace(/^[\u2801-\u28FF] */u, "");
  // Strip control characters (except normal whitespace)
  t = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Reject if it looks like a leaked escape sequence (DA response, etc.)
  if (/\x1b\[|[\x00-\x1f]/.test(raw)) return "";
  return t;
}

function resolvedPaneTitle(title: string | null | undefined, winname: string | null | undefined): string {
  const rawTitle = typeof title === "string" ? title : "";
  if (isTitleUseful(rawTitle)) return rawTitle;
  return (typeof winname === "string" && winname.length > 0) ? winname : rawTitle;
}

function friendlyName(name: string): string {
  return FRIENDLY_NAMES[name] ?? name;
}

export function resolveAgentIntentTitle(paneTitle: string, displayTitle?: string, cwdRaw?: string): string | undefined {
  const normalizedPaneTitle = cleanTitle(paneTitle).trim();
  if (!isTitleUseful(normalizedPaneTitle)) return undefined;
  if (displayTitle && normalizedPaneTitle === displayTitle.trim()) return undefined;
  if (cwdRaw && displayTitle && normalizedPaneTitle.toLowerCase() === basename(cwdRaw).trim().toLowerCase()) return undefined;
  return normalizedPaneTitle;
}

// Sync version for CLI commands that don't need async
export function scan(options: { requireProcess?: boolean; excludeProcessIDs?: number[]; reporterProcessID?: number } = {}): AgentPane[] {
  return scanSync(options);
}

export function runtimeStates(paneIds?: string[]): AgentRuntimeState[] {
  if (!paneIds?.length) {
    return scan().map(runtimeStateFromAgent);
  }

  const raw = exec(
    `tmux list-panes -a -F '${TMUX_SCAN_FORMAT}' 2>/dev/null`
  );
  if (!raw) return [];

  const paneSet = new Set(paneIds);
  const paneOrder = new Map(paneIds.map((paneId, index) => [paneId, index]));
  const tree = buildProcessTree();
  const stateSnapshot = readStateSnapshot();
  const results: AgentRuntimeState[] = [];
  const resolvedPaneIds = new Set<string>();

  for (const fields of parseTmuxScanRecords(raw)) {
    const [pane, pid, title, winname, _fgcmd, wactStr, tty, _paneId, tmuxPaneId, _cwdRaw, commandContentKind, commandLaunch, agentsUUID, paneDead, workspaceRenderMode] = fields;
    if (!paneSet.has(tmuxPaneId) || resolvedPaneIds.has(tmuxPaneId)) continue;

    const session = pane.split(":")[0];
    if (session.startsWith("_agents_")) continue;

    const pidNum = parseInt(pid, 10) || 0;
    const leaf = findAgentLeafInTree(pidNum, tree);
    const ttyMatch = !leaf && tty ? findAgentOnTtyProcessInTree(tty, tree) : null;
    const matchedProcess = resolveTmuxAgentProcess(
      leaf ?? ttyMatch,
      commandContentKind,
      commandLaunch,
      hasActiveTmuxMetadataRuntimeEvidence(commandLaunch, tmuxPaneId, stateSnapshot, agentsUUID, paneDead, workspaceRenderMode),
    );
    if (!matchedProcess) continue;
    resolvedPaneIds.add(tmuxPaneId);
    const agentName = matchedProcess.agentName;

    const observedExternalSessionId = resolveAgentExternalSessionId({
      processSessionId: externalSessionIdFromProcessArgs(agentName, matchedProcess.process?.args ?? commandLaunch),
    });
    if (observedExternalSessionId) {
      rebindStateSnapshotToExternalSession(stateSnapshot, agentName, tmuxPaneId, observedExternalSessionId);
    }
    // The session the agent runs now, as its hooks or its command line name it: the coordination
    // supervisor records each one a worker runs (tasks/<task>/sessions.jsonl).
    const externalSessionId = resolveAgentExternalSessionId({
      stateSessionId: stateExternalSessionId(agentName, tmuxPaneId, stateSnapshot),
      processSessionId: observedExternalSessionId,
    });

    const resolvedTitle = resolvedPaneTitle(title, winname);
    const intent = stateIntent(agentName, tmuxPaneId, stateSnapshot)
      || resolveAgentIntentTitle(resolvedTitle);
    const responsePreview = stateResponsePreview(agentName, tmuxPaneId, stateSnapshot);
    const wact = parseInt(wactStr, 10) || 0;
    const content = "";
    const { status, detail } = resolveStatusFromContent(resolvedTitle, wact, agentName, content, tmuxPaneId, stateSnapshot);
    const richDetail = stateDetail(agentName, tmuxPaneId, stateSnapshot);
    const context = stateContext(agentName, tmuxPaneId, stateSnapshot);
    const provenance = stateProvenance(agentName, tmuxPaneId, stateSnapshot);
    const storedTokens = stateTokens(agentName, tmuxPaneId, stateSnapshot);
    const modelInfo = resolveModelInfo(agentName, tmuxPaneId, content, stateSnapshot);
    const tokenInfo = storedTokens.contextTokens !== undefined || storedTokens.contextMax !== undefined
      ? storedTokens
      : mergedContextTokens(agentName, tmuxPaneId, content, stateSnapshot);

    results.push({
      session: tmuxPaneId,
      agent: agentName,
      ...(externalSessionId ? { externalSessionId } : {}),
      status,
      cpuPercent: matchedProcess.process?.cpuPercent ?? 0,
      memoryMB: matchedProcess.process?.memoryMB ?? 0,
      ...(intent ? { intent } : {}),
      ...(responsePreview ? { responsePreview } : {}),
      ...(richDetail || detail ? { detail: richDetail || detail } : {}),
      ...modelInfo,
      ...(context ? { context } : {}),
      ...(tokenInfo.contextTokens !== undefined ? { contextTokens: tokenInfo.contextTokens } : {}),
      ...(tokenInfo.contextMax !== undefined ? { contextMax: tokenInfo.contextMax } : {}),
      ...(tokenInfo.spend !== undefined ? { spend: tokenInfo.spend, ...(tokenInfo.spendUnit ? { spendUnit: tokenInfo.spendUnit } : {}) } : {}),
      ...provenance,
    });
  }

  results.sort((a, b) => (paneOrder.get(a.session) ?? Number.MAX_SAFE_INTEGER) - (paneOrder.get(b.session) ?? Number.MAX_SAFE_INTEGER));
  return results;
}

function scanSync(options: { requireProcess?: boolean; excludeProcessIDs?: number[]; reporterProcessID?: number } = {}): AgentPane[] {
  const raw = exec(
    `tmux list-panes -a -F '${TMUX_SCAN_FORMAT}' 2>/dev/null`
  );
  if (!raw) return [];

  // Build process tree once — replaces per-pane pgrep/ps calls
  const tree = buildProcessTree();
  const excludedProcessIDs = new Set(options.excludeProcessIDs ?? []);
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
    processPid?: number;
    processArgs?: string;
    cpuPercent: number;
    memoryMB: number;
  };
  const agentPanes: ParsedPane[] = [];
  const uniqueCwds = new Set<string>();

  for (const fields of parseTmuxScanRecords(raw)) {
    const [pane, pid, title, winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId, cwdRaw, commandContentKind, commandLaunch, agentsUUID, paneDead, workspaceRenderMode] = fields;

    const session = pane.split(":")[0];
    if (session.startsWith("_agents_")) continue;

    const pidNum = parseInt(pid, 10) || 0;
    const leaf = options.reporterProcessID
      ? findPrimaryAgentForReporterInTree(pidNum, options.reporterProcessID, tree)
      : findAgentLeafInTree(pidNum, tree, excludedProcessIDs);
    const ttyMatch = !options.reporterProcessID && !leaf && tty
      ? findAgentOnTtyProcessInTree(tty, tree, excludedProcessIDs)
      : null;
    const matchedProcess = resolveTmuxAgentProcess(
      leaf ?? ttyMatch,
      commandContentKind,
      commandLaunch,
      hasActiveTmuxMetadataRuntimeEvidence(commandLaunch, tmuxPaneId, stateSnapshot, agentsUUID, paneDead, workspaceRenderMode),
      !options.requireProcess,
    );
    if (!matchedProcess) continue;
    const agentName = matchedProcess.agentName;

    // Use window_name as fallback when pane_title is unhelpful
    // (e.g., "pi:c" from agents that don't set a useful terminal title)
    const resolvedTitle = resolvedPaneTitle(title, winname);
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
      processPid: matchedProcess.process?.pid,
      processArgs: matchedProcess.process?.args ?? commandLaunch,
      cpuPercent: matchedProcess.process?.cpuPercent ?? 0,
      memoryMB: matchedProcess.process?.memoryMB ?? 0,
    });
    if (cwdRaw) uniqueCwds.add(cwdRaw);
  }

  // Batch git branch lookup — single shell invocation for all unique cwds
  const branchCache = buildBranchCache(uniqueCwds);
  const openCodexSessionIds = findOpenCodexSessionIds(
    agentPanes
      .filter((pane) => pane.agentName === "codex")
      .flatMap((pane) => pane.processPid ? [pane.processPid] : []),
  );

  // Pass 2: detect status and build results
  const results: AgentPane[] = [];
  for (const p of agentPanes) {
    const wact = parseInt(p.wactStr, 10) || 0;
    const content = "";
    const observedExternalSessionId = resolveAgentExternalSessionId({
      observedProcessSessionId: p.processPid ? openCodexSessionIds.get(p.processPid) : undefined,
      processSessionId: externalSessionIdFromProcessArgs(p.agentName, p.processArgs),
    });
    if (observedExternalSessionId) {
      rebindStateSnapshotToExternalSession(stateSnapshot, p.agentName, p.tmuxPaneId, observedExternalSessionId);
    }
    const { status, detail } = resolveStatusFromContent(p.title, wact, p.agentName, content, p.tmuxPaneId, stateSnapshot);
    const richDetail = stateDetail(p.agentName, p.tmuxPaneId, stateSnapshot);
    const finalDetail = richDetail || detail;
    const paneShort = p.pane.replace(/\.\d+$/, "");
    const titleClean = cleanTitle(p.title);
    const cwd = p.cwdRaw?.replace(homedir(), "~") || undefined;
    const branch = branchCache.get(p.cwdRaw);
    const externalSessionId = resolveAgentExternalSessionId({
      observedProcessSessionId: observedExternalSessionId,
      stateSessionId: stateExternalSessionId(p.agentName, p.tmuxPaneId, stateSnapshot),
    });
    const modelInfo = resolveModelInfo(p.agentName, p.tmuxPaneId, content, stateSnapshot);
    const tokenInfo = mergedContextTokens(p.agentName, p.tmuxPaneId, content, stateSnapshot);
    const provenance = stateProvenance(p.agentName, p.tmuxPaneId, stateSnapshot);
    const displayTitle = resolveAgentDisplayTitle(p.agentName, p.cwdRaw, externalSessionId, titleClean);
    const intent = stateIntent(p.agentName, p.tmuxPaneId, stateSnapshot)
      || resolveAgentIntentTitle(p.title, displayTitle, p.cwdRaw);
    const responsePreview = stateResponsePreview(p.agentName, p.tmuxPaneId, stateSnapshot);

    results.push({
      pane: paneShort,
      paneId: p.paneId,
      tmuxPaneId: p.tmuxPaneId,
      title: displayTitle,
      ...(intent ? { intent } : {}),
      ...(responsePreview ? { responsePreview } : {}),
      agent: friendlyName(p.agentName),
      status,
      cpuPercent: p.cpuPercent,
      memoryMB: p.memoryMB,
      detail: finalDetail,
      ...modelInfo,
      ...(externalSessionId ? { externalSessionId } : {}),
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

