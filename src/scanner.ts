import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { basename, join } from "path";
import { createHash } from "crypto";
import { exec, execAsync } from "./shell.js";
import { deriveModelDisplay, getAgentState, getAgentStateEntry, getAgentStateProvenance, readStateSnapshot, recordCleanupObservation, reportState, upsertStateSnapshotEntry } from "./state.js";
import { getMux, detectMultiplexer } from "./multiplexer.js";
import { BACK_ENV, switchBack } from "./back.js";
import type { ModelMetadata, ModelSource, StateSnapshot } from "./state.js";
import type { MuxPaneInfo } from "./multiplexer.js";

export type AgentStatus = "attention" | "question" | "working" | "stalled" | "idle";

export interface AgentPane {
  pane: string;
  paneId: string;
  tmuxPaneId: string;  // %N format for swap operations
  title: string;
  agent: string;
  status: AgentStatus;
  detail?: string;
  provider?: string;
  modelId?: string;
  modelLabel?: string;
  modelSource?: ModelSource;
  model?: string;      // backward-compatible display string for the selected model
  windowId?: string;   // session:window_index for sibling lookup
  cwd?: string;
  branch?: string;     // git branch name for the cwd
  context?: string;    // workspace context description from state file
  contextTokens?: number;
  contextMax?: number;
  stateSource?: "primary" | "contributor";
  primaryState?: string;
  auxiliaryReporters?: string[];
}

export interface AgentRuntimeState {
  session: string;
  status: AgentStatus;
  detail?: string;
  provider?: string;
  modelId?: string;
  modelLabel?: string;
  modelSource?: ModelSource;
  model?: string;
  context?: string;
  contextTokens?: number;
  contextMax?: number;
  stateSource?: "primary" | "contributor";
  primaryState?: string;
  auxiliaryReporters?: string[];
}

export interface AgentSessionHistoryItem {
  sessionId: string;
  title: string;
  titleSource?: "rename" | "summary" | "stored_title" | "session_info" | "first_prompt" | "fallback";
  model?: string;
  updatedAt: number;
  current?: boolean;
}

export interface AgentSessionHistoryGroup {
  agent: string;
  cwd: string;
  pane?: string;
  tmuxPaneId?: string;
  currentSessionId?: string;
  sessions: AgentSessionHistoryItem[];
}

export interface SiblingPane {
  tmuxPaneId: string;  // %N
  command: string;     // pane_current_command
  paneRef: string;     // session:window.pane_index
  width: number;
  height: number;
}

// Agent process names to detect — extend this list for custom agents
const AGENT_PROC_NAMES = ["claude", "copilot", "opencode", "codex", "cursor", "pi"] as const;
const AGENT_PROCS = new RegExp(`^(${AGENT_PROC_NAMES.join("|")})$`, "i");
const WRAPPER_PROCS = new Set(["node", "bun", "bunx", "deno", "tsx", "ts-node", "env", "npm", "npx", "pnpm", "yarn"]);

// ── Per-agent detection ──────────────────────────────────────────────

export interface AgentDetector {
  isWorking(content: string, title: string, tmuxPaneId?: string): boolean;
  isIdle(content: string, title: string, tmuxPaneId?: string): boolean;
  isApproval(content: string, tmuxPaneId?: string): boolean;
  isQuestion(content: string, tmuxPaneId?: string): boolean;
}
const claudeDetector = makeHookDetector("claude");
const codexDetector = makeHookFirstDetector("codex");
const copilotDetector = makeHookDetector("copilot");
const piDetector = makeHookDetector("pi");
const opencodeDetector = makeHookDetector("opencode");
const CODEX_STALE_WORKING_MIN_AGE_SECONDS = 120;
const CODEX_STALE_WORKING_SAMPLE_INTERVAL_SECONDS = 30;
const CODEX_STALE_WORKING_REQUIRED_SAMPLES = 2;

// Hook-based detector: reads state from ~/.agents/state/ files
// written by `agents report` command (called from agent hooks).
// Hooks key by $TMUX_PANE so each pane has independent status.
// When no state file exists (null), agent hasn't started yet → treat as idle.
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function stateDuration(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  if (!entry) return undefined;
  const age = Math.floor(Date.now() / 1000) - entry.ts;
  return age >= 1 ? formatDuration(age) : undefined;
}

export function shouldTreatCodexWorkingAsIdle(content: string, title: string, paneId?: string, snapshot?: StateSnapshot): boolean {
  if (!paneId) return false;
  const entry = getAgentStateEntry("codex", paneId, snapshot);
  if (entry?.state === "working") {
    const age = Math.floor(Date.now() / 1000) - entry.ts;
    if (age < CODEX_STALE_WORKING_MIN_AGE_SECONDS) return false;
  }
  if (isCodexApprovalPending(paneId)) return false;
  if (genericDetector.isApproval(content, paneId)) return false;
  return genericDetector.isIdle(content, title, paneId);
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

function stateDetail(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  return entry?.detail;
}

function stateContext(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  return entry?.context;
}

function stateWorkspaceCwd(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  return entry?.workspace?.cwd;
}

function stateTokens(agent: string, paneId?: string, snapshot?: StateSnapshot): { contextTokens?: number; contextMax?: number } {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  if (!entry) return {};
  return {
    ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
    ...(entry.contextMax !== undefined ? { contextMax: entry.contextMax } : {}),
  };
}

function mergedContextTokens(agent: string, paneId: string | undefined, content: string, snapshot?: StateSnapshot): { contextTokens?: number; contextMax?: number } {
  const stored = stateTokens(agent, paneId, snapshot);
  const inferred = inferContextFromContent(agent, content);

  if (agent.toLowerCase() === "codex") {
    return {
      ...(inferred.contextTokens !== undefined ? { contextTokens: inferred.contextTokens } : stored.contextTokens !== undefined ? { contextTokens: stored.contextTokens } : {}),
      ...(inferred.contextMax !== undefined ? { contextMax: inferred.contextMax } : stored.contextMax !== undefined ? { contextMax: stored.contextMax } : {}),
    };
  }

  return {
    ...(stored.contextTokens !== undefined ? { contextTokens: stored.contextTokens } : inferred.contextTokens !== undefined ? { contextTokens: inferred.contextTokens } : {}),
    ...(stored.contextMax !== undefined ? { contextMax: stored.contextMax } : inferred.contextMax !== undefined ? { contextMax: inferred.contextMax } : {}),
  };
}

function normalizeModelMetadata(meta: ModelMetadata): ModelMetadata {
  const model = deriveModelDisplay(meta);
  return {
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...(meta.modelLabel ? { modelLabel: meta.modelLabel } : {}),
    ...(meta.modelSource ? { modelSource: meta.modelSource } : {}),
    ...(model ? { model } : {}),
  };
}

function stateModelInfo(agent: string, paneId?: string, snapshot?: StateSnapshot): ModelMetadata {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  if (!entry) return {};
  return normalizeModelMetadata({
    provider: entry.provider,
    modelId: entry.modelId,
    modelLabel: entry.modelLabel,
    modelSource: entry.modelSource,
    model: entry.model,
  });
}

function hasResolvedModel(meta: ModelMetadata): boolean {
  return !!deriveModelDisplay(meta);
}

function stateExternalSessionId(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  return entry?.externalSessionId;
}

function stateProvenance(agent: string, paneId?: string, snapshot?: StateSnapshot): Pick<AgentRuntimeState, "stateSource" | "primaryState" | "auxiliaryReporters"> {
  if (!paneId) return {};
  const provenance = getAgentStateProvenance(agent, paneId, snapshot);
  if (!provenance) return {};
  return {
    stateSource: provenance.source,
    ...(provenance.source === "contributor" && provenance.primary ? { primaryState: provenance.primary.state } : {}),
    ...(provenance.contributors.length ? { auxiliaryReporters: provenance.contributors.map((entry) => entry.reporter) } : {}),
  };
}

function normalizeProcessToken(token: string): string {
  if (!token) return "";
  const trimmed = token.trim().replace(/^['"]+|['"]+$/g, "");
  if (!trimmed) return "";
  return basename(trimmed).replace(/^-/, "");
}

export function detectAgentProcess(comm: string, args: string): string | null {
  const rawTokens = [comm, ...args.trim().split(/\s+/)].filter(Boolean);
  const candidates: string[] = [];

  for (let i = 0; i < rawTokens.length; i++) {
    const current = normalizeProcessToken(rawTokens[i]);
    if (!current) continue;
    candidates.push(current);
    if (WRAPPER_PROCS.has(current.toLowerCase()) && rawTokens[i + 1]) {
      const wrapped = normalizeProcessToken(rawTokens[i + 1]);
      if (wrapped) candidates.push(wrapped);
    }
  }

  for (const candidate of candidates) {
    if (AGENT_PROCS.test(candidate)) return candidate.toLowerCase();
  }
  return null;
}

function parseContextWindowLabel(label?: string): number | undefined {
  if (!label) return undefined;
  const match = label.match(/(\d+(?:\.\d+)?)\s*([kKmM])/);
  if (!match) return undefined;
  const base = Number.parseFloat(match[1]);
  const multiplier = match[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
  return Math.round(base * multiplier);
}

const codexModelCachePath = join(homedir(), ".codex", "models_cache.json");
let codexModelCache: { mtimeMs: number; models: Map<string, number> } | null = null;

function codexContextMaxForModel(model?: string): number | undefined {
  if (!model || !existsSync(codexModelCachePath)) return undefined;

  try {
    const mtimeMs = statSync(codexModelCachePath).mtimeMs;
    if (!codexModelCache || codexModelCache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(codexModelCachePath, "utf-8")) as {
        models?: Array<{ slug?: string; context_window?: number; effective_context_window_percent?: number }>;
      };
      const models = new Map<string, number>();
      for (const entry of parsed.models || []) {
        if (!entry.slug || entry.context_window === undefined) continue;
        const pct = entry.effective_context_window_percent ?? 100;
        models.set(entry.slug.toLowerCase(), Math.round(entry.context_window * pct / 100));
      }
      codexModelCache = { mtimeMs, models };
    }

    return codexModelCache.models.get(model.toLowerCase());
  } catch {
    return undefined;
  }
}

export function inferContextFromContent(agent: string, content: string): { contextTokens?: number; contextMax?: number } {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean).slice(-12).reverse();
  switch (agent.toLowerCase()) {
    case "pi": {
      for (const line of lines) {
        const match = line.match(/([0-9]+(?:\.[0-9]+)?)%\/(\d+(?:\.\d+)?)([kKmM])/);
        if (!match) continue;
        const pct = Number.parseFloat(match[1]);
        const max = parseContextWindowLabel(`${match[2]}${match[3]}`);
        if (max === undefined) return {};
        return { contextTokens: Math.round(max * pct / 100), contextMax: max };
      }
      return {};
    }
    case "claude": {
      for (const line of lines) {
        const pctMatch = line.match(/Context:\s*([0-9]+(?:\.[0-9]+)?)%/i);
        if (!pctMatch) continue;
        const pct = Number.parseFloat(pctMatch[1]);
        const max = parseContextWindowLabel(line);
        if (max === undefined) return {};
        return { contextTokens: Math.round(max * pct / 100), contextMax: max };
      }
      return {};
    }
    case "codex": {
      for (const line of lines) {
        const leftMatch = line.match(/([0-9]+(?:\.[0-9]+)?)%\s+left\b/i);
        if (!leftMatch) continue;
        const model = inferModelFromContent("codex", line);
        const max = codexContextMaxForModel(model);
        if (max === undefined) return {};
        const leftPct = Number.parseFloat(leftMatch[1]);
        const usedPct = Math.max(0, Math.min(100, 100 - leftPct));
        return { contextTokens: Math.round(max * usedPct / 100), contextMax: max };
      }
      return {};
    }
    default:
      return {};
  }
}

function splitProviderModel(candidate?: string): Pick<ModelMetadata, "provider" | "modelId"> {
  if (!candidate) return {};
  const trimmed = candidate.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return {};
  return {
    provider: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  };
}

export function inferModelMetadataFromContent(agent: string, content: string): ModelMetadata {
  const agentName = agent.toLowerCase();
  const inferred = inferModelFromContent(agentName, content);

  switch (agentName) {
    case "codex": {
      if (!inferred) return {};
      const structured = splitProviderModel(inferred);
      return normalizeModelMetadata({
        ...structured,
        ...(structured.modelId ? {} : { modelId: inferred }),
        modelSource: "inferred",
      });
    }
    case "pi": {
      const lines = content.split("\n").map((line) => line.trim()).filter(Boolean).slice(-12).reverse();
      for (const line of lines) {
        const match = line.match(/^\(([^)]+)\)\s+(.+)$/);
        if (!match) continue;
        const modelLabel = match[2].replace(/\s+·.*$/, "").trim();
        return normalizeModelMetadata({
          provider: match[1].trim(),
          modelLabel,
          model: modelLabel,
          modelSource: "inferred",
        });
      }
      return inferred ? normalizeModelMetadata({ model: inferred, modelSource: "inferred" }) : {};
    }
    case "claude":
      return inferred ? normalizeModelMetadata({ modelLabel: inferred, model: inferred, modelSource: "inferred" }) : {};
    default:
      return inferred ? normalizeModelMetadata({ model: inferred, modelSource: "inferred" }) : {};
  }
}

function resolveModelInfo(agent: string, paneId: string | undefined, content: string, snapshot?: StateSnapshot): ModelMetadata {
  const stored = stateModelInfo(agent, paneId, snapshot);
  if (hasResolvedModel(stored)) return stored;

  const inferred = inferModelMetadataFromContent(agent, content);
  if (!hasResolvedModel(inferred) && !stored.provider) return stored;

  return normalizeModelMetadata({
    provider: stored.provider ?? inferred.provider,
    modelId: stored.modelId ?? inferred.modelId,
    modelLabel: stored.modelLabel ?? inferred.modelLabel,
    modelSource: stored.modelSource ?? inferred.modelSource,
    model: stored.model ?? inferred.model,
  });
}

function runtimeStateFromAgent(agent: AgentPane): AgentRuntimeState {
  return {
    session: agent.tmuxPaneId,
    status: agent.status,
    ...(agent.detail ? { detail: agent.detail } : {}),
    ...(agent.provider ? { provider: agent.provider } : {}),
    ...(agent.modelId ? { modelId: agent.modelId } : {}),
    ...(agent.modelLabel ? { modelLabel: agent.modelLabel } : {}),
    ...(agent.modelSource ? { modelSource: agent.modelSource } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.context ? { context: agent.context } : {}),
    ...(agent.contextTokens !== undefined ? { contextTokens: agent.contextTokens } : {}),
    ...(agent.contextMax !== undefined ? { contextMax: agent.contextMax } : {}),
    ...(agent.stateSource ? { stateSource: agent.stateSource } : {}),
    ...(agent.primaryState ? { primaryState: agent.primaryState } : {}),
    ...(agent.auxiliaryReporters?.length ? { auxiliaryReporters: agent.auxiliaryReporters } : {}),
  };
}

export function inferModelFromContent(agent: string, content: string): string | undefined {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean).slice(-12).reverse();
  switch (agent.toLowerCase()) {
    case "codex":
      for (const line of lines) {
        let match = line.match(/^([A-Za-z0-9][A-Za-z0-9._/-]*)\s+(?:low|medium|high|xhigh)\s+·/i);
        if (match) return match[1];
        match = line.match(/^([A-Za-z0-9][A-Za-z0-9._/-]*)\s+·/);
        if (match && /(gpt|codex|claude|gemini|sonnet|opus|haiku|o\d)/i.test(match[1])) return match[1];
      }
      return undefined;
    case "pi":
      for (const line of lines) {
        const match = line.match(/^\([^)]+\)\s+(.+)$/);
        if (match) return match[1].replace(/\s+·.*$/, "").trim();
      }
      return undefined;
    case "claude":
      for (const line of lines) {
        const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
        const last = parts.at(-1);
        if (parts.length >= 3 && last && /(opus|sonnet|haiku|claude)/i.test(last)) {
          return last.replace(/\s*\([^)]*$/, "").trim();
        }
      }
      return undefined;
    default:
      return undefined;
  }
}

const claudeRenameCache = new Map<string, { mtimeMs: number; title?: string }>();
const codexLogPath = join(homedir(), ".codex", "log", "codex-tui.log");
const codexSessionIndexPath = join(homedir(), ".codex", "session_index.jsonl");
let codexOpCache: { mtimeMs: number; latestOps: Map<string, string> } | null = null;
let codexSessionIndexCache: { mtimeMs: number; entries: Map<string, string> } | null = null;
let codexStateDbPathCache: string | null | undefined;
const codexTitleCache = new Map<string, { dbPath?: string; dbMtimeMs?: number; sessionIndexMtimeMs?: number; title?: string }>();

function sqliteMtimeMs(dbPath: string): number {
  let latest = 0;
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(candidate)) latest = Math.max(latest, statSync(candidate).mtimeMs);
    } catch {}
  }
  return latest;
}

export function extractClaudeRenameTitleFromTranscript(lines: string[]): string | undefined {
  let renamedTitle: string | undefined;
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; subtype?: string; content?: string };
      if (entry.type !== "system" || entry.subtype !== "local_command" || !entry.content?.includes("<command-name>/rename</command-name>")) continue;
      const match = entry.content.match(/<command-args>(.*?)<\/command-args>/s);
      const candidate = match?.[1]?.trim();
      renamedTitle = candidate || undefined;
    } catch {
      // Ignore malformed lines — transcript may contain partial writes while Claude is active.
    }
  }
  return renamedTitle;
}

function claudeTranscriptPath(cwdRaw?: string, externalSessionId?: string): string | undefined {
  if (!cwdRaw || !externalSessionId) return undefined;
  const projectDir = cwdRaw.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", projectDir, `${externalSessionId}.jsonl`);
}

function getClaudeRenamedTitle(cwdRaw?: string, externalSessionId?: string): string | undefined {
  const transcript = claudeTranscriptPath(cwdRaw, externalSessionId);
  if (!transcript || !existsSync(transcript)) return undefined;

  try {
    const mtimeMs = statSync(transcript).mtimeMs;
    const cached = claudeRenameCache.get(transcript);
    if (cached?.mtimeMs === mtimeMs) return cached.title;

    const renamedTitle = extractClaudeRenameTitleFromTranscript(readFileSync(transcript, "utf-8").split("\n"));
    claudeRenameCache.set(transcript, { mtimeMs, title: renamedTitle });
    return renamedTitle;
  } catch {
    return undefined;
  }
}

function codexStateDbPath(): string | undefined {
  if (codexStateDbPathCache !== undefined) return codexStateDbPathCache || undefined;

  const codexDir = join(homedir(), ".codex");
  const candidates: Array<{ path: string; version: number }> = [];
  try {
    for (const entry of readdirSync(codexDir)) {
      const match = entry.match(/^state_(\d+)\.sqlite$/);
      if (!match) continue;
      candidates.push({ path: join(codexDir, entry), version: Number.parseInt(match[1], 10) || 0 });
    }
  } catch {}

  candidates.sort((a, b) => b.version - a.version);
  const preferred = candidates[0]?.path;
  const fallback = join(codexDir, "state.db");
  codexStateDbPathCache = preferred || (existsSync(fallback) ? fallback : null);
  return codexStateDbPathCache || undefined;
}

export function extractLatestCodexSessionTitlesFromIndexLines(lines: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { id?: string; thread_name?: string };
      if (entry.id && entry.thread_name) entries.set(entry.id, entry.thread_name);
    } catch {
      // Ignore partial lines while Codex is appending.
    }
  }
  return entries;
}

function readCodexSessionIndex(): Map<string, string> {
  if (!existsSync(codexSessionIndexPath)) return new Map();
  try {
    const mtimeMs = statSync(codexSessionIndexPath).mtimeMs;
    if (codexSessionIndexCache?.mtimeMs === mtimeMs) return codexSessionIndexCache.entries;

    const entries = extractLatestCodexSessionTitlesFromIndexLines(readFileSync(codexSessionIndexPath, "utf-8").split("\n"));
    codexSessionIndexCache = { mtimeMs, entries };
    return entries;
  } catch {
    return new Map();
  }
}

function getCodexThreadTitle(externalSessionId?: string): string | undefined {
  if (!externalSessionId) return undefined;

  const sessionIndexTitle = readCodexSessionIndex().get(externalSessionId);
  const sessionIndexMtimeMs = codexSessionIndexCache?.mtimeMs;
  const dbPath = codexStateDbPath();
  const dbMtimeMs = dbPath && existsSync(dbPath) ? sqliteMtimeMs(dbPath) : undefined;

  const cached = codexTitleCache.get(externalSessionId);
  if (cached && cached.dbPath === dbPath && cached.dbMtimeMs === dbMtimeMs && cached.sessionIndexMtimeMs === sessionIndexMtimeMs) {
    return cached.title;
  }

  let title = sessionIndexTitle;
  if (!title && dbPath && existsSync(dbPath)) {
    try {
      const sqlId = externalSessionId.replace(/'/g, "''");
      title = exec(`sqlite3 ${JSON.stringify(dbPath)} ${JSON.stringify(`select title from threads where id='${sqlId}' limit 1;`)}`) || undefined;
    } catch {
      title = undefined;
    }
  }

  codexTitleCache.set(externalSessionId, { dbPath, dbMtimeMs, sessionIndexMtimeMs, title });
  return title;
}

function listCodexHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dbPath = codexStateDbPath();
  if (!dbPath || !existsSync(dbPath)) return [];

  try {
    const sqlCwd = cwdRaw.replace(/'/g, "''");
    const sql = `select id, title, model, updated_at from threads where cwd='${sqlCwd}' order by updated_at desc limit ${limit};`;
    const raw = exec(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`);
    if (!raw) return [];
    const rows = JSON.parse(raw) as Array<{ id?: string; title?: string; model?: string; updated_at?: number }>;
    const sessionIndex = readCodexSessionIndex();
    return rows
      .filter((row) => !!row.id)
      .map((row) => {
        const indexedTitle = sessionIndex.get(row.id!);
        const isCurrent = !!currentSessionId && row.id === currentSessionId;
        return {
          sessionId: row.id!,
          title: indexedTitle || row.title || row.id!,
          titleSource: indexedTitle ? "rename" : row.title ? "stored_title" : "fallback",
          ...(row.model ? { model: row.model } : {}),
          updatedAt: row.updated_at || 0,
          ...(isCurrent ? { current: true } : {}),
        };
      });
  } catch {
    return [];
  }
}

function expandHomePath(pathLike?: string): string | undefined {
  if (!pathLike) return undefined;
  return pathLike.startsWith("~/") ? join(homedir(), pathLike.slice(2)) : pathLike;
}

function summarizeText(raw?: string): string | undefined {
  if (!raw) return undefined;
  const lines = raw
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^<[^>]+>$/.test(line));
  const first = lines.find((line) => line !== "[object Object]");
  if (!first) return undefined;
  return first.replace(/\s+/g, " ").slice(0, 160);
}

function encodeClaudeProjectDir(cwdRaw: string): string {
  return cwdRaw.replace(/\//g, "-");
}

function encodePiSessionDir(cwdRaw: string): string {
  return `--${cwdRaw.replace(/^\/+|\/+$/g, "").replace(/\//g, "-")}--`;
}

function encodeCursorProjectDir(cwdRaw: string): string {
  return cwdRaw.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
}

type ClaudeSessionsIndexEntry = {
  summary?: string;
  firstPrompt?: string;
  modifiedAt?: number;
  transcriptPath?: string;
};

function readClaudeSessionsIndex(cwdRaw: string): Map<string, ClaudeSessionsIndexEntry> {
  const indexPath = join(homedir(), ".claude", "projects", encodeClaudeProjectDir(cwdRaw), "sessions-index.json");
  if (!existsSync(indexPath)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      entries?: Array<{ sessionId?: string; summary?: string; firstPrompt?: string; modified?: string; fileMtime?: number; fullPath?: string }>;
    };
    const entries = new Map<string, ClaudeSessionsIndexEntry>();
    for (const entry of parsed.entries || []) {
      if (!entry.sessionId) continue;
      const modifiedAt = entry.modified ? Math.round(Date.parse(entry.modified) / 1000) : entry.fileMtime ? Math.round(entry.fileMtime / 1000) : undefined;
      entries.set(entry.sessionId, {
        ...(entry.summary ? { summary: entry.summary } : {}),
        ...(entry.firstPrompt ? { firstPrompt: entry.firstPrompt } : {}),
        ...(modifiedAt ? { modifiedAt } : {}),
        ...(entry.fullPath ? { transcriptPath: entry.fullPath } : {}),
      });
    }
    return entries;
  } catch {
    return new Map();
  }
}

function parseClaudeHistoryEntry(filePath: string, currentSessionId?: string, indexEntry?: ClaudeSessionsIndexEntry): AgentSessionHistoryItem | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    const sessionId = basename(filePath, ".jsonl");
    const renamedTitle = extractClaudeRenameTitleFromTranscript(lines);
    let firstUserTitle: string | undefined;
    let model: string | undefined;

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as any;
        const messageContent = typeof entry?.message?.content === "string"
          ? entry.message.content
          : Array.isArray(entry?.message?.content)
            ? entry.message.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
            : typeof entry?.content === "string"
              ? entry.content
              : undefined;
        if (!firstUserTitle && entry?.type === "user") {
          const candidate = summarizeText(messageContent);
          if (candidate
            && !String(messageContent || "").includes("<local-command-caveat>")
            && !candidate.startsWith("Caveat:")
            && !candidate.startsWith("/")
            && !candidate.includes("<command-name>/")) {
            firstUserTitle = candidate;
          }
        }
        if (!model && typeof entry?.message?.model === "string") model = entry.message.model;
      } catch {}
    }

    const mtimeMs = statSync(filePath).mtimeMs;
    const resolvedTitle = renamedTitle || indexEntry?.summary || firstUserTitle || summarizeText(indexEntry?.firstPrompt) || sessionId;
    const titleSource = renamedTitle ? "rename"
      : indexEntry?.summary ? "summary"
      : (firstUserTitle || summarizeText(indexEntry?.firstPrompt)) ? "first_prompt"
      : "fallback";
    return {
      sessionId,
      title: resolvedTitle,
      titleSource,
      ...(model ? { model } : {}),
      updatedAt: indexEntry?.modifiedAt || Math.round(mtimeMs / 1000),
      ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
    };
  } catch {
    return null;
  }
}

function listClaudeHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dir = join(homedir(), ".claude", "projects", encodeClaudeProjectDir(cwdRaw));
  if (!existsSync(dir)) return [];
  try {
    const indexEntries = readClaudeSessionsIndex(cwdRaw);
    if (indexEntries.size > 0) {
      return [...indexEntries.entries()]
        .sort((a, b) => (b[1].modifiedAt || 0) - (a[1].modifiedAt || 0))
        .slice(0, limit)
        .map(([sessionId, entry]): AgentSessionHistoryItem | null => {
          const transcriptPath = entry.transcriptPath || join(dir, `${sessionId}.jsonl`);
          if (existsSync(transcriptPath)) return parseClaudeHistoryEntry(transcriptPath, currentSessionId, entry);
          return {
            sessionId,
            title: entry.summary || summarizeText(entry.firstPrompt) || sessionId,
            titleSource: entry.summary ? "summary" : entry.firstPrompt ? "first_prompt" : "fallback",
            updatedAt: entry.modifiedAt || 0,
            ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
          };
        })
        .filter((item): item is AgentSessionHistoryItem => item !== null);
    }

    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .map((filePath) => parseClaudeHistoryEntry(filePath, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function parsePiHistoryEntry(filePath: string, currentSessionId?: string): AgentSessionHistoryItem | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    let sessionId = basename(filePath, ".jsonl").split("_").at(-1) || basename(filePath, ".jsonl");
    let firstPromptTitle: string | undefined;
    let sessionInfoTitle: string | undefined;
    let model: string | undefined;
    let ts = Math.round(statSync(filePath).mtimeMs / 1000);

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as any;
        if (entry?.type === "session") {
          if (typeof entry.id === "string") sessionId = entry.id;
          if (typeof entry.timestamp === "string") {
            const parsed = Date.parse(entry.timestamp);
            if (!Number.isNaN(parsed)) ts = Math.round(parsed / 1000);
          }
        }
        if (entry?.type === "model_change" && typeof entry.modelId === "string") model = entry.modelId;
        if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
          sessionInfoTitle = entry.name.trim();
        }
        if (!firstPromptTitle && entry?.type === "message" && entry?.message?.role === "user") {
          const text = Array.isArray(entry.message.content)
            ? entry.message.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
            : typeof entry.message.content === "string"
              ? entry.message.content
              : undefined;
          const candidate = summarizeText(text);
          if (candidate && !candidate.includes("Daily Memory")) firstPromptTitle = candidate;
        }
      } catch {}
    }

    const title = sessionInfoTitle || firstPromptTitle || sessionId;
    return {
      sessionId,
      title,
      titleSource: sessionInfoTitle ? "session_info" : firstPromptTitle ? "first_prompt" : "fallback",
      ...(model ? { model } : {}),
      updatedAt: ts,
      ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
    };
  } catch {
    return null;
  }
}

function listPiHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dir = join(homedir(), ".pi", "agent", "sessions", encodePiSessionDir(cwdRaw));
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .map((filePath) => parsePiHistoryEntry(filePath, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function parseCopilotWorkspaceYaml(filePath: string): { cwd?: string; summary?: string; createdAt?: number; updatedAt?: number } {
  try {
    const content = readFileSync(filePath, "utf-8");
    const cwd = content.match(/^cwd:\s*(.+)$/m)?.[1]?.trim();
    const summary = content.match(/^summary:\s*(.+)$/m)?.[1]?.trim();
    const createdAtRaw = content.match(/^created_at:\s*(.+)$/m)?.[1]?.trim();
    const updatedAtRaw = content.match(/^updated_at:\s*(.+)$/m)?.[1]?.trim();
    const createdAt = createdAtRaw ? Math.round(Date.parse(createdAtRaw) / 1000) : undefined;
    const updatedAt = updatedAtRaw ? Math.round(Date.parse(updatedAtRaw) / 1000) : undefined;
    return { cwd, summary, createdAt, updatedAt };
  } catch {
    return {};
  }
}

function parseCopilotHistoryEntry(sessionDir: string, currentSessionId?: string): AgentSessionHistoryItem | null {
  try {
    const sessionId = basename(sessionDir);
    const workspaceMeta = parseCopilotWorkspaceYaml(join(sessionDir, "workspace.yaml"));
    let title = summarizeText(workspaceMeta.summary);
    if (!title) {
      const eventsPath = join(sessionDir, "events.jsonl");
      if (existsSync(eventsPath)) {
        for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as any;
            if (entry?.type === "user.message") {
              title = summarizeText(entry?.data?.content || entry?.data?.transformedContent);
              if (title) break;
            }
          } catch {}
        }
      }
    }
    const updatedAt = workspaceMeta.updatedAt || Math.round(statSync(sessionDir).mtimeMs / 1000);
    return {
      sessionId,
      title: title || sessionId,
      titleSource: title ? "summary" : "fallback",
      updatedAt,
      ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
    };
  } catch {
    return null;
  }
}

function listCopilotHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const root = join(homedir(), ".copilot", "session-state");
  if (!existsSync(root)) return [];
  try {
    const items = readdirSync(root)
      .map((name) => join(root, name))
      .filter((dir) => existsSync(join(dir, "workspace.yaml")))
      .map((dir) => ({ dir, meta: parseCopilotWorkspaceYaml(join(dir, "workspace.yaml")) }))
      .filter(({ meta }) => meta.cwd === cwdRaw)
      .sort((a, b) => (b.meta.updatedAt || statSync(b.dir).mtimeMs / 1000) - (a.meta.updatedAt || statSync(a.dir).mtimeMs / 1000))
      .slice(0, limit)
      .map(({ dir }) => parseCopilotHistoryEntry(dir, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null);
    return items;
  } catch {
    return [];
  }
}

function listOpenCodeHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return [];
  try {
    const sqlCwd = cwdRaw.replace(/'/g, "''");
    const sql = `select s.id, s.title, s.time_updated from session s join project p on p.id=s.project_id where p.worktree='${sqlCwd}' order by s.time_updated desc limit ${limit};`;
    const raw = exec(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`);
    if (!raw) return [];
    const rows = JSON.parse(raw) as Array<{ id?: string; title?: string; time_updated?: number }>;
    return rows
      .filter((row) => !!row.id)
      .map((row) => ({
        sessionId: row.id!,
        title: row.title || row.id!,
        titleSource: row.title ? "stored_title" : "fallback",
        updatedAt: Math.round((row.time_updated || 0) / 1000),
        ...(currentSessionId && row.id === currentSessionId ? { current: true } : {}),
      }));
  } catch {
    return [];
  }
}

function listCursorHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dir = join(homedir(), ".cursor", "projects", encodeCursorProjectDir(cwdRaw), "agent-transcripts");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, limit)
      .map((filePath): AgentSessionHistoryItem | null => {
        try {
          const transcript = JSON.parse(readFileSync(filePath, "utf-8")) as any[];
          const title = summarizeText(transcript.find((entry) => entry?.role === "user")?.text);
          const sessionId = basename(filePath, ".json");
          return {
            sessionId,
            title: title || sessionId,
            titleSource: title ? "first_prompt" : "fallback",
            updatedAt: Math.round(statSync(filePath).mtimeMs / 1000),
            ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
          };
        } catch {
          return null;
        }
      })
      .filter((item): item is AgentSessionHistoryItem => item !== null);
  } catch {
    return [];
  }
}

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
    const cwdRaw = expandHomePath(cwdOverride) || cwdOverride;
    for (const agent of wantedAgents) addTarget(agent, { cwdRaw });
    return targets;
  }

  for (const pane of scan()) {
    const agent = pane.agent.toLowerCase();
    const cwdRaw = stateWorkspaceCwd(agent, pane.tmuxPaneId, stateSnapshot) || expandHomePath(pane.cwd);
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

  const loaders: Record<string, (cwdRaw: string, limit: number, currentSessionId?: string) => AgentSessionHistoryItem[]> = {
    claude: listClaudeHistoryForCwd,
    codex: listCodexHistoryForCwd,
    copilot: listCopilotHistoryForCwd,
    opencode: listOpenCodeHistoryForCwd,
    pi: listPiHistoryForCwd,
    cursor: listCursorHistoryForCwd,
  };

  for (const [agent, agentTargets] of targets.entries()) {
    const load = loaders[agent];
    if (!load) continue;
    for (const target of agentTargets) {
      const sessions = load(target.cwdRaw, limit, target.currentSessionId);
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

function isCodexApprovalPending(paneId?: string): boolean {
  const externalSessionId = stateExternalSessionId("codex", paneId);
  if (!externalSessionId) return false;
  return latestCodexOps().get(externalSessionId) === "exec_approval";
}

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
    isWorking(_content, _title, paneId) {
      const s = paneId ? getAgentState(agentName, paneId, snapshot) : null;
      if (s === "working") return true;
      if (s === "approval" || s === "question" || s === "idle") return false;
      return genericDetector.isWorking(_content, _title, paneId);
    },
    isIdle(content, title, paneId) {
      const s = paneId ? getAgentState(agentName, paneId, snapshot) : null;
      if (s !== null) {
        return s === "idle" || s === "question";
      }
      return genericDetector.isIdle(content, title, paneId);
    },
    isApproval(content, paneId) {
      return (paneId ? getAgentState(agentName, paneId, snapshot) === "approval" : false)
        || (agentName === "codex" && isCodexApprovalPending(paneId))
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



// Generic screen-scrape detector for codex, cursor, opencode, etc.
// This is inherently brittle — only used for agents without hook/extension support.
const genericDetector: AgentDetector = {
  isWorking(content, title) {
    // Spinner chars in title (many TUIs set title to show progress)
    if (/[⠁-⠿⏳🔄]/.test(title)) return true;
    // Spinner chars or progress keywords in pane content
    // NOTE: ✢ intentionally excluded — it's Claude's static prompt marker
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
    // Check if the last visible block of agent output contains a question
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-8).join("\n");
    return /\?/.test(tail);
  },
};

export function getDetector(agent: string, snapshot?: StateSnapshot): AgentDetector {
  switch (agent.toLowerCase()) {
    case "claude":   return snapshot ? makeHookDetector("claude", snapshot) : claudeDetector;
    case "codex":    return snapshot ? makeHookFirstDetector("codex", snapshot) : codexDetector;
    case "copilot":  return snapshot ? makeHookDetector("copilot", snapshot) : copilotDetector;
    case "pi":       return snapshot ? makeHookDetector("pi", snapshot) : piDetector;
    case "opencode": return snapshot ? makeHookDetector("opencode", snapshot) : opencodeDetector;
    default:          return genericDetector;  // cursor, etc.
  }
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

async function detectStatus(
  paneRef: string,
  title: string,
  windowActivity: number,
  agent: string,
  tmuxPaneId?: string,
  snapshot?: StateSnapshot,
): Promise<{ status: AgentStatus; detail?: string }> {
  const detector = getDetector(agent, snapshot);
  const captureTarget = tmuxPaneId || paneRef;

  const rawLines = await execAsync(
    `tmux capture-pane -t ${JSON.stringify(captureTarget)} -p -S -20 2>/dev/null`
  );
  const content = rawLines.replace(/\n{3,}/g, "\n\n");
  if (agent.toLowerCase() === "codex") reconcileStaleCodexWorkingState(content, title, tmuxPaneId, snapshot);

  const dur = stateDuration(agent, tmuxPaneId, snapshot);

  if (detector.isApproval(content, tmuxPaneId)) return { status: "attention", detail: dur };

  // Hook-first detectors may still reach idle here after a separate stale-state
  // cleanup pass converts a long-lived working hook into idle.
  if (detector.isIdle(content, title, tmuxPaneId)) {
    if (detector.isQuestion(content, tmuxPaneId)) return { status: "question", detail: dur };
    return { status: "idle" };
  }

  if (detector.isWorking(content, title, tmuxPaneId)) return { status: "working", detail: dur };

  const fullPane = await execAsync(
    `tmux capture-pane -t ${JSON.stringify(captureTarget)} -p 2>/dev/null`
  );
  const isEmpty = fullPane.replace(/\s/g, "").length === 0;
  if (isEmpty) return { status: "idle" };

  // No hook data, no screen match — window_activity fallback (per-window, not per-pane).
  // Never reports "working" — window_activity is polluted by helper panes.
  const now = Math.floor(Date.now() / 1000);
  const age = now - windowActivity;
  if (age < 120) return { status: "stalled", detail: `${age}s` };
  return { status: "idle", detail: `${Math.floor(age / 60)}m` };
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
    const leafCmd = findLeafInTree(pidNum, tree);
    let agentName: string | null = leafCmd || null;
    if (!agentName && tty) {
      agentName = findAgentOnTtyInTree(tty, tree);
    }
    if (!agentName) continue;

    const resolvedTitle = isTitleUseful(title) ? title : winname || title;
    const wact = parseInt(wactStr, 10) || 0;
    const { status, detail } = detectStatusSync(pane, resolvedTitle, wact, agentName, tmuxPaneId, stateSnapshot);
    const richDetail = stateDetail(agentName, tmuxPaneId, stateSnapshot);
    const context = stateContext(agentName, tmuxPaneId, stateSnapshot);
    const provenance = stateProvenance(agentName, tmuxPaneId, stateSnapshot);
    const storedTokens = stateTokens(agentName, tmuxPaneId, stateSnapshot);
    const inferenceContent = exec(`tmux capture-pane -t ${JSON.stringify(tmuxPaneId)} -p -S -20 2>/dev/null`);
    const modelInfo = resolveModelInfo(agentName, tmuxPaneId, inferenceContent, stateSnapshot);
    const tokenInfo = storedTokens.contextTokens !== undefined || storedTokens.contextMax !== undefined
      ? storedTokens
      : mergedContextTokens(
        agentName,
        tmuxPaneId,
        inferenceContent,
        stateSnapshot,
      );

    results.push({
      session: tmuxPaneId,
      status,
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

    const content = mux.getPaneContent(p.id, 20);
    const detector = getDetector(agentName, stateSnapshot);
    const dur = stateDuration(agentName, p.id, stateSnapshot);

    let status: AgentStatus;
    let detail: string | undefined = dur;

    if (detector.isApproval(content, p.id)) {
      status = "attention";
    } else if (detector.isIdle(content, p.title, p.id)) {
      status = detector.isQuestion(content, p.id) ? "question" : "idle";
      detail = status === "idle" ? undefined : dur;
    } else if (detector.isWorking(content, p.title, p.id)) {
      status = "working";
    } else {
      status = "idle";
      detail = undefined;
    }

    const paneRef = `${p.session}:${p.tab}`;
    const titleClean = cleanTitle(p.title);

    const zellijCwd = p.cwd?.replace(homedir(), "~") || undefined;
    const externalSessionId = stateExternalSessionId(agentName, p.id, stateSnapshot);
    const renamedTitle = agentName === "claude" ? getClaudeRenamedTitle(p.cwd, externalSessionId) : undefined;
    const codexTitle = agentName === "codex" ? getCodexThreadTitle(externalSessionId) : undefined;
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
      title: codexTitle || renamedTitle || titleClean,
      agent: friendlyName(agentName),
      status,
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

// ── Process tree snapshot ─────────────────────────────────────────────
// Single `ps` call builds an in-memory process tree. Used by scanSync()
// to avoid per-pane pgrep/ps forks (27 panes × ~4 execs → 1 exec).

interface ProcEntry { pid: number; ppid: number; comm: string; tty: string; args: string }

function buildProcessTree(): { byPid: Map<number, ProcEntry>; children: Map<number, number[]>; byTty: Map<string, ProcEntry[]> } {
  const raw = exec("ps -eo pid=,ppid=,comm=,tty=,args= 2>/dev/null");
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  const byTty = new Map<string, ProcEntry[]>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const entry: ProcEntry = {
      pid: parseInt(match[1]),
      ppid: parseInt(match[2]),
      comm: match[3].replace(/.*\//, ""),
      tty: match[4],
      args: match[5] || "",
    };
    byPid.set(entry.pid, entry);
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
    if (entry.tty !== "??" && entry.tty !== "?") {
      const list = byTty.get(entry.tty);
      if (list) list.push(entry);
      else byTty.set(entry.tty, [entry]);
    }
  }
  return { byPid, children, byTty };
}

async function buildProcessTreeAsync(): Promise<{ byPid: Map<number, ProcEntry>; children: Map<number, number[]>; byTty: Map<string, ProcEntry[]> }> {
  const raw = await execAsync("ps -eo pid=,ppid=,comm=,tty=,args= 2>/dev/null");
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  const byTty = new Map<string, ProcEntry[]>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const entry: ProcEntry = {
      pid: parseInt(match[1]),
      ppid: parseInt(match[2]),
      comm: match[3].replace(/.*\//, ""),
      tty: match[4],
      args: match[5] || "",
    };
    byPid.set(entry.pid, entry);
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
    if (entry.tty !== "??" && entry.tty !== "?") {
      const list = byTty.get(entry.tty);
      if (list) list.push(entry);
      else byTty.set(entry.tty, [entry]);
    }
  }
  return { byPid, children, byTty };
}

function findLeafInTree(pid: number, tree: { byPid: Map<number, ProcEntry>; children: Map<number, number[]> }): string {
  let current = pid;
  for (;;) {
    const kids = tree.children.get(current);
    if (!kids || kids.length === 0) break;
    const child = kids[0];
    const entry = tree.byPid.get(child);
    const agent = entry ? detectAgentProcess(entry.comm, entry.args) : null;
    if (agent) return agent;
    current = child;
  }
  const entry = tree.byPid.get(current);
  return entry ? (detectAgentProcess(entry.comm, entry.args) || "") : "";
}

function findAgentOnTtyInTree(tty: string, tree: { byTty: Map<string, ProcEntry[]> }): string | null {
  const ttyShort = tty.replace(/^\/dev\//, "");
  const procs = tree.byTty.get(ttyShort);
  if (!procs) return null;
  for (const p of procs) {
    const agent = detectAgentProcess(p.comm, p.args);
    if (agent) return agent;
  }
  return null;
}

function buildBranchCache(uniqueCwds: Set<string>): Map<string, string | undefined> {
  const branchCache = new Map<string, string | undefined>();
  if (uniqueCwds.size === 0) return branchCache;

  const cwdArr = [...uniqueCwds];
  const script = cwdArr.map(d => `git -C ${JSON.stringify(d)} rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`).join("\n");
  const branches = exec(`bash -c ${JSON.stringify(script)}`).split("\n");
  for (let i = 0; i < cwdArr.length; i++) {
    branchCache.set(cwdArr[i], branches[i] || undefined);
  }
  return branchCache;
}

async function buildBranchCacheAsync(uniqueCwds: Set<string>): Promise<Map<string, string | undefined>> {
  const branchCache = new Map<string, string | undefined>();
  if (uniqueCwds.size === 0) return branchCache;

  const cwdArr = [...uniqueCwds];
  const script = cwdArr.map(d => `git -C ${JSON.stringify(d)} rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""`).join("\n");
  const branches = (await execAsync(`bash -c ${JSON.stringify(script)}`)).split("\n");
  for (let i = 0; i < cwdArr.length; i++) {
    branchCache.set(cwdArr[i], branches[i] || undefined);
  }
  return branchCache;
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
  type ParsedPane = { pane: string; pid: string; title: string; wactStr: string; tty: string; paneId: string; tmuxPaneId: string; cwdRaw: string; agentName: string };
  const agentPanes: ParsedPane[] = [];
  const uniqueCwds = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [pane, pid, title, winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId, cwdRaw] = line.split("§");

    const session = pane.split(":")[0];
    if (session.startsWith("_agents_")) continue;

    const pidNum = parseInt(pid, 10) || 0;
    const leafCmd = findLeafInTree(pidNum, tree);
    let agentName: string | null = leafCmd || null;
    if (!agentName && tty) {
      agentName = findAgentOnTtyInTree(tty, tree);
    }
    if (!agentName) continue;

    // Use window_name as fallback when pane_title is unhelpful
    // (e.g., "pi:c" from agents that don't set a useful terminal title)
    const resolvedTitle = isTitleUseful(title) ? title : winname || title;
    agentPanes.push({ pane, pid, title: resolvedTitle, wactStr, tty, paneId, tmuxPaneId, cwdRaw, agentName });
    if (cwdRaw) uniqueCwds.add(cwdRaw);
  }

  // Batch git branch lookup — single shell invocation for all unique cwds
  const branchCache = buildBranchCache(uniqueCwds);

  // Pass 2: detect status and build results
  const results: AgentPane[] = [];
  for (const p of agentPanes) {
    const wact = parseInt(p.wactStr, 10) || 0;
    const { status, detail } = detectStatusSync(p.pane, p.title, wact, p.agentName, p.tmuxPaneId, stateSnapshot);
    const richDetail = stateDetail(p.agentName, p.tmuxPaneId, stateSnapshot);
    const finalDetail = richDetail || detail;
    const paneShort = p.pane.replace(/\.\d+$/, "");
    const titleClean = cleanTitle(p.title);
    const cwd = p.cwdRaw?.replace(homedir(), "~") || undefined;
    const branch = branchCache.get(p.cwdRaw);
    const externalSessionId = stateExternalSessionId(p.agentName, p.tmuxPaneId, stateSnapshot);
    const renamedTitle = p.agentName === "claude" ? getClaudeRenamedTitle(p.cwdRaw, externalSessionId) : undefined;
    const codexTitle = p.agentName === "codex" ? getCodexThreadTitle(externalSessionId) : undefined;
    const inferenceContent = exec(`tmux capture-pane -t ${JSON.stringify(p.tmuxPaneId)} -p -S -20 2>/dev/null`);
    const modelInfo = resolveModelInfo(p.agentName, p.tmuxPaneId, inferenceContent, stateSnapshot);
    const tokenInfo = mergedContextTokens(p.agentName, p.tmuxPaneId, inferenceContent, stateSnapshot);
    const provenance = stateProvenance(p.agentName, p.tmuxPaneId, stateSnapshot);

    results.push({ pane: paneShort, paneId: p.paneId, tmuxPaneId: p.tmuxPaneId, title: codexTitle || renamedTitle || titleClean, agent: friendlyName(p.agentName), status, detail: finalDetail, ...modelInfo, windowId: p.paneId, cwd, branch, context: stateContext(p.agentName, p.tmuxPaneId, stateSnapshot), ...tokenInfo, ...provenance } as AgentPane);
  }

  results.sort((a, b) => a.pane.localeCompare(b.pane) || a.tmuxPaneId.localeCompare(b.tmuxPaneId));
  return results;
}

// Legacy per-process helpers — retained for non-batched fallback paths
function findLeafProcessSync(pid: string): string {
  let leaf = pid;
  for (;;) {
    const child = exec(`pgrep -P ${leaf} 2>/dev/null | head -1`);
    if (!child) break;
    const agent = detectAgentProcess("", exec(`ps -p ${child} -o args= 2>/dev/null`));
    if (agent) return agent;
    leaf = child;
  }
  return detectAgentProcess("", exec(`ps -p ${leaf} -o args= 2>/dev/null`)) || "";
}

/** Agents with hook-based state reporting — detectors read state files, not pane content. */
const HOOK_AGENTS = new Set(["claude", "codex", "copilot", "pi", "opencode"]);

function detectStatusSync(paneRef: string, title: string, windowActivity: number, agent: string, tmuxPaneId?: string, snapshot?: StateSnapshot): { status: AgentStatus; detail?: string } {
  const detector = getDetector(agent, snapshot);
  const dur = stateDuration(agent, tmuxPaneId, snapshot);
  const captureTarget = tmuxPaneId || paneRef;

  // Hook-based agents trust reported state for live status. Codex still samples
  // pane content here, but only for slow stale-working cleanup.
  if (HOOK_AGENTS.has(agent.toLowerCase())) {
    const needsContentCheck = agent.toLowerCase() === "codex";
    const rawLines = needsContentCheck ? exec(`tmux capture-pane -t ${JSON.stringify(captureTarget)} -p -S -20 2>/dev/null`) : "";
    const content = rawLines.replace(/\n{3,}/g, "\n\n");
    if (agent.toLowerCase() === "codex") reconcileStaleCodexWorkingState(content, title, tmuxPaneId, snapshot);

    if (detector.isApproval(content, tmuxPaneId)) return { status: "attention", detail: dur };
    if (detector.isIdle(content, title, tmuxPaneId)) {
      if (detector.isQuestion(content, tmuxPaneId)) return { status: "question", detail: dur };
      return { status: "idle" };
    }
    if (detector.isWorking(content, title, tmuxPaneId)) return { status: "working", detail: dur };
    return { status: "idle" };
  }

  // Generic (screen-scrape) agents: need pane content
  const rawLines = exec(`tmux capture-pane -t ${JSON.stringify(captureTarget)} -p -S -20 2>/dev/null`);
  const content = rawLines.replace(/\n{3,}/g, "\n\n");

  if (detector.isApproval(content, tmuxPaneId)) return { status: "attention", detail: dur };

  if (detector.isIdle(content, title, tmuxPaneId)) {
    if (detector.isQuestion(content, tmuxPaneId)) return { status: "question", detail: dur };
    return { status: "idle" };
  }

  if (detector.isWorking(content, title, tmuxPaneId)) return { status: "working", detail: dur };

  // Fallback: check if pane has any content at all
  const fullPane = exec(`tmux capture-pane -t ${JSON.stringify(captureTarget)} -p 2>/dev/null`);
  const isEmpty = fullPane.replace(/\s/g, "").length === 0;
  if (isEmpty) return { status: "idle" };

  const now = Math.floor(Date.now() / 1000);
  const age = now - windowActivity;
  if (age < 120) return { status: "stalled", detail: `${age}s` };
  return { status: "idle", detail: `${Math.floor(age / 60)}m` };
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
  type ParsedPane = { pane: string; title: string; wactStr: string; paneId: string; tmuxPaneId: string; cwdRaw: string; agentName: string };
  const agentPanes: ParsedPane[] = [];
  const uniqueCwds = new Set<string>();

  for (const line of lines) {
    const [pane, pid, title, winname, _fgcmd, wactStr, tty, paneId, tmuxPaneId, cwdRaw] = line.split("§");
    const session = pane.split(":")[0];
    if (session.startsWith("_agents_")) continue;

    const pidNum = parseInt(pid, 10) || 0;
    const leafCmd = findLeafInTree(pidNum, tree);
    let agentName: string | null = leafCmd || null;
    if (!agentName && tty) {
      agentName = findAgentOnTtyInTree(tty, tree);
    }
    if (!agentName) continue;

    const resolvedTitle = isTitleUseful(title) ? title : winname || title;
    agentPanes.push({ pane, title: resolvedTitle, wactStr, paneId, tmuxPaneId, cwdRaw, agentName });
    if (cwdRaw) uniqueCwds.add(cwdRaw);
  }

  const branchCache = await buildBranchCacheAsync(uniqueCwds);

  const promises = agentPanes.map(async (p) => {
    const wact = parseInt(p.wactStr, 10) || 0;
    const { status, detail } = await detectStatus(p.pane, p.title, wact, p.agentName, p.tmuxPaneId, stateSnapshot);
    const richDetail = stateDetail(p.agentName, p.tmuxPaneId, stateSnapshot);
    const finalDetail = richDetail || detail;
    const paneShort = p.pane.replace(/\.\d+$/, "");
    const titleClean = cleanTitle(p.title);
    const cwd = p.cwdRaw?.replace(homedir(), "~") || undefined;
    const branch = branchCache.get(p.cwdRaw);
    const externalSessionId = stateExternalSessionId(p.agentName, p.tmuxPaneId, stateSnapshot);
    const renamedTitle = p.agentName === "claude" ? getClaudeRenamedTitle(p.cwdRaw, externalSessionId) : undefined;
    const codexTitle = p.agentName === "codex" ? getCodexThreadTitle(externalSessionId) : undefined;
    const inferenceContent = await execAsync(`tmux capture-pane -t ${JSON.stringify(p.tmuxPaneId)} -p -S -20 2>/dev/null`);
    const modelInfo = resolveModelInfo(p.agentName, p.tmuxPaneId, inferenceContent, stateSnapshot);
    const tokenInfo = mergedContextTokens(p.agentName, p.tmuxPaneId, inferenceContent, stateSnapshot);
    const provenance = stateProvenance(p.agentName, p.tmuxPaneId, stateSnapshot);

    return { pane: paneShort, paneId: p.paneId, tmuxPaneId: p.tmuxPaneId, title: codexTitle || renamedTitle || titleClean, agent: friendlyName(p.agentName), status, detail: finalDetail, ...modelInfo, windowId: p.paneId, cwd, branch, context: stateContext(p.agentName, p.tmuxPaneId, stateSnapshot), ...tokenInfo, ...provenance } as AgentPane;
  });

  const results = (await Promise.all(promises)).filter((r): r is AgentPane => r !== null);

  results.sort((a, b) => a.pane.localeCompare(b.pane) || a.tmuxPaneId.localeCompare(b.tmuxPaneId));
  return results;
}

export function switchToPane(paneId: string, tmuxPaneId?: string): void {
  if (detectMultiplexer() === "zellij") {
    if (tmuxPaneId) {
      // Switch to the agent's tab then focus the pane
      const mux = getMux();
      const panes = mux.listPanes();
      const target = panes.find(p => p.id === tmuxPaneId);
      if (target) {
        exec(`zellij action go-to-tab ${target.tabIndex + 1}`); // 1-based
      }
      mux.focusPane(tmuxPaneId);
    }
    return;
  }
  const current = exec(`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`);
  if (current) {
    exec(`tmux set-environment -g ${BACK_ENV} ${JSON.stringify(current)}`);
  }
  exec(`tmux select-window -t ${JSON.stringify(paneId)}`);
  if (tmuxPaneId) {
    exec(`tmux select-pane -t ${tmuxPaneId}`);
  }
  exec(`tmux switch-client -t ${JSON.stringify(paneId)}`);
}

// ── Preview / swap helpers ──────────────────────────────────────────

/** Create a split for preview. `dashboardSize` is rows (horizontal) or columns
 *  (vertical) reserved for the dashboard pane – the agent gets the rest.
 *  Always targets our own pane (via $TMUX_PANE) so focus doesn't matter. */
export function createPreviewSplit(dashboardSize: number, vertical: boolean = false): string {
  if (detectMultiplexer() === "zellij") {
    const mux = getMux();
    const selfId = mux.ownPaneId();
    // Create split next to dashboard, sized to leave dashboardSize for dashboard
    const curWidth = mux.getPaneWidth(selfId);
    const previewSize = vertical
      ? Math.max(20, curWidth - dashboardSize - 1)
      : Math.max(5, (process.stdout.rows || 24) - dashboardSize - 1);
    const dir = vertical ? "right" : "down";
    const splitId = mux.createSplit(selfId, dir, String(previewSize));
    return splitId || "";
  }
  const self = process.env.TMUX_PANE || "";
  const target = self ? ` -t ${self}` : "";
  if (vertical) {
    const curWidth = parseInt(exec(`tmux display-message -t ${self || ""} -p '#{pane_width}'`) || "120", 10);
    const previewCols = Math.max(20, curWidth - dashboardSize - 1);
    return exec(`tmux split-window -h -d${target} -l ${previewCols} -P -F '#{pane_id}' 'tail -f /dev/null'`);
  }
  const curHeight = parseInt(exec(`tmux display-message -t ${self || ""} -p '#{pane_height}'`) || "24", 10);
  const previewRows = Math.max(5, curHeight - dashboardSize - 1);
  return exec(`tmux split-window -v -d${target} -l ${previewRows} -P -F '#{pane_id}' 'tail -f /dev/null'`);
}

/** Check if a pane exists. */
export function paneExists(paneId: string): boolean {
  if (detectMultiplexer() === "zellij") {
    const panes = getMux().listPanes();
    return panes.some(p => p.id === paneId);
  }
  return exec(`tmux display-message -t ${paneId} -p '#{pane_id}' 2>/dev/null`) === paneId;
}

/** Get the current width of a pane. */
export function getPaneWidth(paneId: string): number {
  if (detectMultiplexer() === "zellij") return getMux().getPaneWidth(paneId);
  return parseInt(exec(`tmux display-message -t ${paneId} -p '#{pane_width}' 2>/dev/null`) || "0", 10);
}

/** Get the current height (rows) of a tmux pane. */
export function getPaneHeight(paneId: string): number {
  if (detectMultiplexer() === "zellij") {
    const panes = getMux().listPanes();
    const pane = panes.find(p => p.id === paneId);
    return pane?.geometry.height || 0;
  }
  return parseInt(exec(`tmux display-message -t ${paneId} -p '#{pane_height}' 2>/dev/null`) || "0", 10);
}

/** Resize a pane to a specific width. */
export function resizePaneWidth(paneId: string, width: number): void {
  if (detectMultiplexer() === "zellij") { getMux().resizePaneWidth(paneId, width); return; }
  exec(`tmux resize-pane -t ${paneId} -x ${width} 2>/dev/null`);
}

/** Swap two panes by their IDs.
 *  tmux: real bidirectional swap.
 *  zellij: move src to dst's tab via breakPaneToTab, then close dst.
 *  The caller must ensure dst is a disposable placeholder (tail -f /dev/null).
 */
export function swapPanes(src: string, dst: string): void {
  if (detectMultiplexer() === "zellij") {
    // Bidirectional swap: src and dst exchange tabs.
    // NOTE: zellij's break_panes_to_tab_with_id is buggy (treats id as position),
    // so we must use tab_index (position) and re-read positions between moves.
    //
    // Order: move dst to src's tab FIRST — this ensures src's tab has ≥2 panes,
    // so when we move src out next, the tab won't collapse and shift positions.
    const mux = getMux();
    const before = mux.listPanes();
    const srcPane = before.find(p => p.id === src);
    const dstPane = before.find(p => p.id === dst);
    if (!srcPane || !dstPane) return;
    if (srcPane.tabIndex === dstPane.tabIndex) return;

    // zellij 0.44 bug: break_panes_to_tab_with_index has a position/id mismatch.
    // Use break_panes_to_new_tab (reliable) to move panes.
    //
    // For preview open: src=agent, dst=split. Move split to agent's tab,
    // then move dashboard+agent together to a new tab.
    // For preview close: src=agent, dst=split. Move agent to its own new tab.
    //
    // We detect which case by checking if the dashboard is in dst's tab.
    const selfId = mux.ownPaneId();
    const selfInDstTab = before.some(p => p.id === selfId && p.tabIndex === dstPane.tabIndex);

    if (selfInDstTab) {
      // Preview OPEN: dashboard is in dst's tab (split was created here).
      // Move split to agent's tab name, move dashboard+agent together.
      mux.breakPanesToNewTab([dst], srcPane.tab || "agent");
      mux.breakPanesToNewTab([selfId, src], dstPane.tab || "dashboard");
    } else {
      // Preview CLOSE / general swap: just exchange the two panes.
      // Move each to a new tab with the OTHER's tab name.
      mux.breakPanesToNewTab([dst], srcPane.tab || "");
      mux.breakPanesToNewTab([src], dstPane.tab || "");
    }
    return;
  }
  exec(`tmux swap-pane -d -s ${src} -t ${dst}`);
}

/** Focus a pane by its %N id (select it without switching the dashboard away). */
export function focusPane(tmuxPaneId: string): void {
  if (detectMultiplexer() === "zellij") { getMux().focusPane(tmuxPaneId); return; }
  exec(`tmux select-pane -t ${tmuxPaneId}`);
}

/** Get the current pane's %N id (tmux) or terminal_N id (zellij). */
export function ownPaneId(): string {
  // TMUX_PANE is set per-pane by tmux and stays correct regardless of focus.
  // display-message without -t returns the *focused* pane, which is wrong if
  // another pane has focus (e.g. during HMR remount).
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  if (process.env.ZELLIJ_PANE_ID) {
    const id = process.env.ZELLIJ_PANE_ID;
    return id.startsWith("terminal_") || id.startsWith("plugin_") ? id : `terminal_${id}`;
  }
  return exec(`tmux display-message -p '#{pane_id}'`);
}

/** Kill a pane by its %N id. */
export function killPane(id: string): void {
  if (detectMultiplexer() === "zellij") { getMux().closePane(id); return; }
  exec(`tmux kill-pane -t ${id} 2>/dev/null`);
}

/** Kill an entire tmux window by session:window_index. */
export function killWindow(windowId: string): void {
  if (detectMultiplexer() === "zellij") { getMux().closeTab(windowId); return; }
  exec(`tmux kill-window -t ${JSON.stringify(windowId)} 2>/dev/null`);
}

/** Find sibling panes in the same tmux window, excluding the given pane. */
export function findSiblingPanes(windowId: string, excludePaneId: string): SiblingPane[] {
  const raw = exec(
    `tmux list-panes -t ${JSON.stringify(windowId)} -F '#{pane_id}§#{pane_current_command}§#{session_name}:#{window_name}.#{pane_index}§#{pane_width}§#{pane_height}' 2>/dev/null`
  );
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [tmuxPaneId, command, paneRef, w, h] = line.split("§");
    return { tmuxPaneId, command, paneRef, width: parseInt(w, 10) || 0, height: parseInt(h, 10) || 0 };
  }).filter((p) => p.tmuxPaneId !== excludePaneId);
}

// ── Window snapshot / restore ────────────────────────────────────────

export interface WindowSnapshot {
  windowId: string;
  layout: string;      // tmux window_layout string (includes pane IDs)
}

/** Capture a window's layout so it can be restored later. */
export function snapshotWindow(windowId: string): WindowSnapshot {
  const layout = exec(
    `tmux display-message -t ${JSON.stringify(windowId)} -p '#{window_layout}'`
  );
  return { windowId, layout };
}

/** Extract ordered pane IDs from a tmux layout string.
 *  Leaf panes match: WxH,X,Y,<ID> followed by , ] or } */
function parsePaneIds(layout: string): string[] {
  const ids: string[] = [];
  const re = /\d+x\d+,\d+,\d+,(\d+)(?=[,\]\}])/g;
  let m;
  while ((m = re.exec(layout)) !== null) ids.push("%" + m[1]);
  return ids;
}

/** Return a copy of the snapshot with one pane ID replaced by another.
 *  Used when the agent pane replaces the placeholder before layout restore. */
export function patchSnapshotId(snapshot: WindowSnapshot, oldId: string, newId: string): WindowSnapshot {
  const oldNum = oldId.replace("%", "");
  const newNum = newId.replace("%", "");
  // Layout leaf format: WxH,X,Y,<ID> followed by , ] or }
  const layout = snapshot.layout.replace(
    new RegExp(`(\\d+x\\d+,\\d+,\\d+,)${oldNum}(?=[,\\]\\}])`, "g"),
    `$1${newNum}`
  );
  return { ...snapshot, layout };
}

/** Restore a window's layout and pane ordering from a snapshot. */
export function restoreWindowLayout(snapshot: WindowSnapshot): void {
  // Apply geometry
  exec(
    `tmux select-layout -t ${JSON.stringify(snapshot.windowId)} '${snapshot.layout}' 2>/dev/null`
  );
  // Fix pane ordering — select-layout sets geometry but doesn't reorder panes
  const targetOrder = parsePaneIds(snapshot.layout);
  const currentOrder = exec(
    `tmux list-panes -t ${JSON.stringify(snapshot.windowId)} -F '#{pane_id}' 2>/dev/null`
  ).split("\n").filter(Boolean);

  for (let i = 0; i < targetOrder.length; i++) {
    if (currentOrder[i] !== targetOrder[i]) {
      const j = currentOrder.indexOf(targetOrder[i]);
      if (j >= 0) {
        exec(`tmux swap-pane -d -s ${targetOrder[i]} -t ${currentOrder[i]}`);
        [currentOrder[i], currentOrder[j]] = [currentOrder[j], currentOrder[i]];
      }
    }
  }
}

/** Create a new placeholder pane by splitting an existing pane in the given direction.
 *  Returns the new pane's %N id. Used for swap-based helper pane management. */
export function createSplitPane(targetPaneId: string, direction: string, size?: string): string {
  const flags = direction === "left"  ? "-hb" :
                direction === "right" ? "-h" :
                direction === "above" ? "-vb" :
                                        "-v";
  const sizeFlag = size ? ` -l ${size}` : "";
  return exec(`tmux split-window ${flags} -d${sizeFlag} -t ${targetPaneId} -P -F '#{pane_id}' 'tail -f /dev/null'`);
}

/** Move a pane into another pane's window, splitting in the given direction. */
export function joinPane(srcPaneId: string, targetPaneId: string, direction: string): void {
  const flags = direction === "left"  ? "-hb" :
                direction === "right" ? "-h" :
                direction === "above" ? "-vb" :
                                        "-v";
  exec(`tmux join-pane -d ${flags} -s ${srcPaneId} -t ${targetPaneId}`);
}

/** Move a pane back into a window (joins to the first pane found there). */
export function returnPaneToWindow(paneId: string, windowId: string): void {
  const target = exec(
    `tmux list-panes -t ${JSON.stringify(windowId)} -F '#{pane_id}' 2>/dev/null`
  ).split("\n").filter(Boolean)[0];
  if (target) {
    exec(`tmux join-pane -d -s ${paneId} -t ${target}`);
  }
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

/** Kill multiple panes by their %N ids. */
export function killPanes(ids: string[]): void {
  for (const id of ids) {
    exec(`tmux kill-pane -t ${id} 2>/dev/null`);
  }
}

/** Replace a pane's content with a centered placeholder message. */
export function showPlaceholder(paneId: string, agentName: string, agentPane: string): void {
  const script = `#!/bin/bash
tput clear
c=$(tput cols)
r=$(tput lines)
l=$((r/2-3))
tput cup $l 0
msg="Pane previewing in Agent Dashboard"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
echo
msg="Agent: ${agentName}"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
msg="From:  ${agentPane}"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
echo
tput dim
msg="Press Ctrl-b b to return"
printf "%*s\\n" $(( (c + \${#msg}) / 2 )) "$msg"
tput sgr0
while true; do sleep 86400; done
`;
  if (detectMultiplexer() === "zellij") {
    // In zellij, the split (tail -f /dev/null) is already in the agent's original tab
    // and serves as a visual placeholder. showPlaceholder uses --in-place which
    // targets the focused pane (dashboard), not the split in a remote tab.
    return;
  }
  const path = join(tmpdir(), `agents-ph-${paneId.replace("%", "")}.sh`);
  writeFileSync(path, script, { mode: 0o755 });
  exec(`tmux respawn-pane -k -t ${paneId} 'bash ${path}'`);
}
