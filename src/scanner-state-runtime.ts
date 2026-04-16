import { deriveModelDisplay, getAgentStateEntry, getAgentStateProvenance } from "./state.js";
import { inferContextFromContent, inferModelMetadataFromContent, readCodexTokenUsageFromSession } from "./scanner-runtime.js";
import type { ModelMetadata, StateSnapshot } from "./state.js";
import type { AgentRuntimeState } from "./scanner-types.js";

const HOOK_AGENTS = new Set(["claude", "codex", "copilot", "pi", "opencode"]);
const CODEX_SESSION_USAGE_MAX_SKEW_SECONDS = 300;

export function isHookAuthoritativeAgent(agent: string): boolean {
  return HOOK_AGENTS.has(agent.toLowerCase());
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
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

function hasResolvedModel(meta: ModelMetadata): boolean {
  return !!deriveModelDisplay(meta);
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

export function stateDuration(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  if (!entry) return undefined;
  const age = Math.floor(Date.now() / 1000) - entry.ts;
  return age >= 1 ? formatDuration(age) : undefined;
}

export function stateDetail(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  return entry?.detail;
}

export function stateContext(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  return entry?.context;
}

export function stateWorkspaceCwd(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  return entry?.workspace?.cwd;
}

export function stateTokens(agent: string, paneId?: string, snapshot?: StateSnapshot): { contextTokens?: number; contextMax?: number } {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  if (!entry) return {};
  return {
    ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
    ...(entry.contextMax !== undefined ? { contextMax: entry.contextMax } : {}),
  };
}

export function mergedContextTokens(agent: string, paneId: string | undefined, content: string, snapshot?: StateSnapshot): { contextTokens?: number; contextMax?: number } {
  const stored = stateTokens(agent, paneId, snapshot);

  if (agent.toLowerCase() === "codex") {
    const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
    const sessionUsage = readCodexTokenUsageFromSession(stateExternalSessionId(agent, paneId, snapshot));
    const sessionUsageFresh = sessionUsage.observedAt === undefined
      || entry?.ts === undefined
      || Math.abs(sessionUsage.observedAt - entry.ts) <= CODEX_SESSION_USAGE_MAX_SKEW_SECONDS;
    return {
      ...(stored.contextTokens !== undefined ? { contextTokens: stored.contextTokens } : sessionUsageFresh && sessionUsage.contextTokens !== undefined ? { contextTokens: sessionUsage.contextTokens } : {}),
      ...(stored.contextMax !== undefined ? { contextMax: stored.contextMax } : sessionUsageFresh && sessionUsage.contextMax !== undefined ? { contextMax: sessionUsage.contextMax } : {}),
    };
  }

  if (isHookAuthoritativeAgent(agent)) {
    return stored;
  }

  const inferred = inferContextFromContent(agent, content);

  return {
    ...(stored.contextTokens !== undefined ? { contextTokens: stored.contextTokens } : inferred.contextTokens !== undefined ? { contextTokens: inferred.contextTokens } : {}),
    ...(stored.contextMax !== undefined ? { contextMax: stored.contextMax } : inferred.contextMax !== undefined ? { contextMax: inferred.contextMax } : {}),
  };
}

export function stateExternalSessionId(agent: string, paneId?: string, snapshot?: StateSnapshot): string | undefined {
  const entry = paneId ? getAgentStateEntry(agent, paneId, snapshot) : null;
  return entry?.externalSessionId;
}

export function stateProvenance(agent: string, paneId?: string, snapshot?: StateSnapshot): Pick<AgentRuntimeState, "stateSource" | "primaryState" | "auxiliaryReporters"> {
  if (!paneId) return {};
  const provenance = getAgentStateProvenance(agent, paneId, snapshot);
  if (!provenance) return {};
  return {
    stateSource: provenance.source,
    ...(provenance.source === "contributor" && provenance.primary ? { primaryState: provenance.primary.state } : {}),
    ...(provenance.contributors.length ? { auxiliaryReporters: provenance.contributors.map((entry) => entry.reporter) } : {}),
  };
}

export function resolveModelInfo(agent: string, paneId: string | undefined, content: string, snapshot?: StateSnapshot): ModelMetadata {
  const stored = stateModelInfo(agent, paneId, snapshot);
  if (isHookAuthoritativeAgent(agent)) {
    return stored;
  }

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
