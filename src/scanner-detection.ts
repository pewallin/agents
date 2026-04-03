import { createHash } from "crypto";
import { existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { exec } from "./shell.js";
import { getAgentState, getAgentStateEntry, recordCleanupObservation, reportState, upsertStateSnapshotEntry } from "./state.js";
import { stateDuration, stateExternalSessionId } from "./scanner-state-runtime.js";
import type { StateSnapshot } from "./state.js";
import type { AgentStatus } from "./scanner-types.js";

export interface AgentDetector {
  isWorking(content: string, title: string, tmuxPaneId?: string): boolean;
  isIdle(content: string, title: string, tmuxPaneId?: string): boolean;
  isApproval(content: string, tmuxPaneId?: string): boolean;
  isQuestion(content: string, tmuxPaneId?: string): boolean;
}

const codexLogPath = join(homedir(), ".codex", "log", "codex-tui.log");
let codexOpCache: { mtimeMs: number; latestOps: Map<string, string> } | null = null;

const CODEX_STALE_WORKING_MIN_AGE_SECONDS = 120;
const CODEX_STALE_WORKING_SAMPLE_INTERVAL_SECONDS = 30;
const CODEX_STALE_WORKING_REQUIRED_SAMPLES = 2;

export function extractLatestCodexOpsFromLogLines(lines: string[]): Map<string, string> {
  const latestOps = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const threadMatch = line.match(/thread_id=([0-9a-f-]+)/i) || line.match(/thread\.id=([0-9a-f-]+)/i);
    const opMatch = line.match(/codex\.op="([^"]+)"/i);
    if (!threadMatch || !opMatch) continue;
    latestOps.set(threadMatch[1], opMatch[1]);
  }
  return latestOps;
}

function latestCodexOps(): Map<string, string> {
  if (!existsSync(codexLogPath)) return new Map();
  try {
    const mtimeMs = statSync(codexLogPath).mtimeMs;
    if (codexOpCache?.mtimeMs === mtimeMs) return codexOpCache.latestOps;

    const tail = exec(`tail -n 4000 ${JSON.stringify(codexLogPath)} 2>/dev/null`);
    const latestOps = extractLatestCodexOpsFromLogLines(tail.split("\n"));
    codexOpCache = { mtimeMs, latestOps };
    return latestOps;
  } catch {
    return new Map();
  }
}

function isCodexApprovalPending(paneId?: string, snapshot?: StateSnapshot): boolean {
  const externalSessionId = stateExternalSessionId("codex", paneId, snapshot);
  if (!externalSessionId) return false;
  return latestCodexOps().get(externalSessionId) === "exec_approval";
}

const genericDetector: AgentDetector = {
  isWorking(content, title) {
    if (/[⠁-⠿⏳🔄]/.test(title)) return true;
    return /Working\.\.\.|Thinking\.\.\.|Running\.\.\.|Generating|Searching|Compiling|[⠁-⠿]/.test(content);
  },
  isIdle(content) {
    const bottom = content.split("\n").slice(-10).join("\n");
    return /❯|›|➜|\$\s*$|>\s*$|press enter|waiting|tab agents.*ctrl\+p/i.test(bottom);
  },
  isApproval(content) {
    return /needs-approval|Allow .*—|Do you want to run|Would you like to run the following command\?|Allow this action|\(Y\/n\)|\(y\/N\)|↑↓ to select|↑↓ to navigate|△ Permission required|Allow once.*Allow always.*Reject|Press enter to confirm or esc to cancel/i.test(content);
  },
  isQuestion(content) {
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-8).join("\n");
    return /\?/.test(tail);
  },
};

function makeHookDetector(agentName: string, snapshot?: StateSnapshot): AgentDetector {
  return {
    isWorking(_c, _t, paneId) { return paneId ? getAgentState(agentName, paneId, snapshot) === "working" : false; },
    isIdle(_c, _t, paneId) {
      if (!paneId) return true;
      const s = getAgentState(agentName, paneId, snapshot);
      return s === "idle" || s === "question" || s === null;
    },
    isApproval(_c, paneId) { return paneId ? getAgentState(agentName, paneId, snapshot) === "approval" : false; },
    isQuestion(_content, paneId) { return paneId ? getAgentState(agentName, paneId, snapshot) === "question" : false; },
  };
}

function makeHookFirstDetector(agentName: string, snapshot?: StateSnapshot): AgentDetector {
  return {
    isWorking(content, title, paneId) {
      const s = paneId ? getAgentState(agentName, paneId, snapshot) : null;
      if (s === "working") return true;
      if (s === "approval" || s === "question" || s === "idle") return false;
      return genericDetector.isWorking(content, title, paneId);
    },
    isIdle(content, title, paneId) {
      const s = paneId ? getAgentState(agentName, paneId, snapshot) : null;
      if (s !== null) return s === "idle" || s === "question";
      return genericDetector.isIdle(content, title, paneId);
    },
    isApproval(content, paneId) {
      return (paneId ? getAgentState(agentName, paneId, snapshot) === "approval" : false)
        || (agentName === "codex" && isCodexApprovalPending(paneId, snapshot))
        || genericDetector.isApproval(content, paneId);
    },
    isQuestion(content, paneId) {
      const s = paneId ? getAgentState(agentName, paneId, snapshot) : null;
      if (s !== null) return s === "question";
      if (agentName === "codex") return false;
      return genericDetector.isQuestion(content, paneId);
    },
  };
}

const claudeDetector = makeHookDetector("claude");
const codexDetector = makeHookFirstDetector("codex");
const copilotDetector = makeHookDetector("copilot");
const piDetector = makeHookDetector("pi");
const opencodeDetector = makeHookDetector("opencode");

export function getDetector(agent: string, snapshot?: StateSnapshot): AgentDetector {
  switch (agent.toLowerCase()) {
    case "claude":   return snapshot ? makeHookDetector("claude", snapshot) : claudeDetector;
    case "codex":    return snapshot ? makeHookFirstDetector("codex", snapshot) : codexDetector;
    case "copilot":  return snapshot ? makeHookDetector("copilot", snapshot) : copilotDetector;
    case "pi":       return snapshot ? makeHookDetector("pi", snapshot) : piDetector;
    case "opencode": return snapshot ? makeHookDetector("opencode", snapshot) : opencodeDetector;
    default:          return genericDetector;
  }
}

function normalizeCleanupContent(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanupContentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export function shouldTreatCodexWorkingAsIdle(content: string, title: string, paneId?: string, snapshot?: StateSnapshot): boolean {
  if (!paneId) return false;
  const entry = getAgentStateEntry("codex", paneId, snapshot);
  if (entry?.state === "working") {
    const age = Math.floor(Date.now() / 1000) - entry.ts;
    if (age < CODEX_STALE_WORKING_MIN_AGE_SECONDS) return false;
  }
  if (isCodexApprovalPending(paneId, snapshot)) return false;
  if (genericDetector.isApproval(content, paneId)) return false;
  return genericDetector.isIdle(content, title, paneId);
}

export function reconcileStaleCodexWorkingState(content: string, title: string, paneId?: string, snapshot?: StateSnapshot): void {
  if (!paneId) return;
  const entry = getAgentStateEntry("codex", paneId, snapshot);
  if (!entry || entry.state !== "working") {
    const updated = recordCleanupObservation("codex", paneId, null);
    if (updated && snapshot) upsertStateSnapshotEntry(snapshot, updated);
    return;
  }

  if (!shouldTreatCodexWorkingAsIdle(content, title, paneId, snapshot)) {
    const updated = recordCleanupObservation("codex", paneId, null);
    if (updated && snapshot) upsertStateSnapshotEntry(snapshot, updated);
    return;
  }

  const normalized = normalizeCleanupContent(content);
  if (!normalized) {
    const updated = recordCleanupObservation("codex", paneId, null);
    if (updated && snapshot) upsertStateSnapshotEntry(snapshot, updated);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const nextHash = cleanupContentHash(normalized);
  const previous = entry.cleanup;

  if (previous?.contentHash === nextHash
      && previous.observedAt
      && now - previous.observedAt < CODEX_STALE_WORKING_SAMPLE_INTERVAL_SECONDS) {
    return;
  }

  const unchangedSamples = previous?.contentHash === nextHash
    ? (previous.unchangedSamples ?? 1) + 1
    : 1;

  if (unchangedSamples >= CODEX_STALE_WORKING_REQUIRED_SAMPLES) {
    const updated = reportState("codex", paneId, "idle", {
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.modelId ? { modelId: entry.modelId } : {}),
      ...(entry.modelLabel ? { modelLabel: entry.modelLabel } : {}),
      ...(entry.modelSource ? { modelSource: entry.modelSource } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.externalSessionId ? { externalSessionId: entry.externalSessionId } : {}),
      ...(entry.context ? { context: entry.context } : {}),
      ...(entry.workspace ? { workspace: entry.workspace } : {}),
      ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
      ...(entry.contextMax !== undefined ? { contextMax: entry.contextMax } : {}),
    });
    if (snapshot) upsertStateSnapshotEntry(snapshot, updated);
    return;
  }

  const updated = recordCleanupObservation("codex", paneId, {
    contentHash: nextHash,
    observedAt: now,
    unchangedSamples,
  });
  if (updated && snapshot) upsertStateSnapshotEntry(snapshot, updated);
}

const HOOK_AGENTS = new Set(["claude", "codex", "copilot", "pi", "opencode"]);

export function resolveStatusFromContent(
  title: string,
  windowActivity: number,
  agent: string,
  tailContent: string,
  tmuxPaneId?: string,
  snapshot?: StateSnapshot,
  fullPane?: string,
): { status: AgentStatus; detail?: string } {
  const detector = getDetector(agent, snapshot);
  const dur = stateDuration(agent, tmuxPaneId, snapshot);

  if (HOOK_AGENTS.has(agent.toLowerCase())) {
    const content = agent.toLowerCase() === "codex" ? tailContent : "";
    if (agent.toLowerCase() === "codex") reconcileStaleCodexWorkingState(content, title, tmuxPaneId, snapshot);

    if (detector.isApproval(content, tmuxPaneId)) return { status: "attention", detail: dur };
    if (detector.isIdle(content, title, tmuxPaneId)) {
      if (detector.isQuestion(content, tmuxPaneId)) return { status: "question", detail: dur };
      return { status: "idle" };
    }
    if (detector.isWorking(content, title, tmuxPaneId)) return { status: "working", detail: dur };
    return { status: "idle" };
  }

  if (detector.isApproval(tailContent, tmuxPaneId)) return { status: "attention", detail: dur };
  if (detector.isIdle(tailContent, title, tmuxPaneId)) {
    if (detector.isQuestion(tailContent, tmuxPaneId)) return { status: "question", detail: dur };
    return { status: "idle" };
  }
  if (detector.isWorking(tailContent, title, tmuxPaneId)) return { status: "working", detail: dur };

  const full = fullPane ?? "";
  const isEmpty = full.replace(/\s/g, "").length === 0;
  if (isEmpty) return { status: "idle" };

  const now = Math.floor(Date.now() / 1000);
  const age = now - windowActivity;
  if (age < 120) return { status: "stalled", detail: `${age}s` };
  return { status: "idle", detail: `${Math.floor(age / 60)}m` };
}
