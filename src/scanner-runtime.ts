import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { deriveModelDisplay } from "./state.js";
import type { ModelMetadata } from "./state.js";
import type { AgentPane, AgentRuntimeState } from "./scanner-types.js";

function parseContextWindowLabel(label?: string): number | undefined {
  if (!label) return undefined;
  const match = label.match(/(\d+(?:\.\d+)?)\s*([kKmM])/);
  if (!match) return undefined;
  const base = Number.parseFloat(match[1]);
  const multiplier = match[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
  return Math.round(base * multiplier);
}

const codexSessionsRoot = join(homedir(), ".codex", "sessions");
const codexSessionPathCache = new Map<string, string>();
const codexSessionUsageCache = new Map<string, { path: string; mtimeMs: number; usage: { contextTokens?: number; contextMax?: number } }>();

function totalTokens(usage?: { total_tokens?: number; input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number }): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;

  const parts = [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
  ].filter((value): value is number => typeof value === "number");
  if (parts.length === 0) return undefined;
  return parts.reduce((sum, value) => sum + value, 0);
}

export function extractLatestCodexTokenUsageFromSessionLines(lines: string[]): { contextTokens?: number; contextMax?: number } {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          info?: {
            last_token_usage?: {
              total_tokens?: number;
              input_tokens?: number;
              cached_input_tokens?: number;
              output_tokens?: number;
              reasoning_output_tokens?: number;
            };
            model_context_window?: number;
          };
        };
      };
      if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;

      const contextTokens = totalTokens(entry.payload.info?.last_token_usage);
      const contextMax = entry.payload.info?.model_context_window;
      return {
        ...(contextTokens !== undefined ? { contextTokens } : {}),
        ...(typeof contextMax === "number" ? { contextMax } : {}),
      };
    } catch {}
  }

  return {};
}

function findCodexSessionPath(externalSessionId?: string): string | undefined {
  if (!externalSessionId || !existsSync(codexSessionsRoot)) return undefined;

  const cached = codexSessionPathCache.get(externalSessionId);
  if (cached && existsSync(cached)) return cached;

  const stack = [codexSessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(`${externalSessionId}.jsonl`)) {
          codexSessionPathCache.set(externalSessionId, fullPath);
          return fullPath;
        }
      }
    } catch {}
  }

  return undefined;
}

export function readCodexTokenUsageFromSession(externalSessionId?: string): { contextTokens?: number; contextMax?: number } {
  const sessionPath = findCodexSessionPath(externalSessionId);
  if (!sessionPath) return {};

  try {
    const mtimeMs = statSync(sessionPath).mtimeMs;
    const cached = externalSessionId ? codexSessionUsageCache.get(externalSessionId) : undefined;
    if (cached && cached.path === sessionPath && cached.mtimeMs === mtimeMs) return cached.usage;

    const usage = extractLatestCodexTokenUsageFromSessionLines(readFileSync(sessionPath, "utf-8").split("\n"));
    if (externalSessionId) codexSessionUsageCache.set(externalSessionId, { path: sessionPath, mtimeMs, usage });
    return usage;
  } catch {
    return {};
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

export function inferModelFromContent(agent: string, content: string): string | undefined {
  const lines = content.split("\n").map((line) => line.trim()).filter(Boolean).slice(-12).reverse();
  switch (agent.toLowerCase()) {
    case "codex":
      for (const line of lines) {
        let match = line.match(/^([A-Za-z0-9][A-Za-z0-9._/-]*)\s+(?:low|medium|high|xhigh)(?:\s+[A-Za-z0-9._/-]+)*\s+·/i);
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

export function runtimeStateFromAgent(agent: AgentPane): AgentRuntimeState {
  return {
    session: agent.tmuxPaneId,
    status: agent.status,
    cpuPercent: agent.cpuPercent,
    memoryMB: agent.memoryMB,
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
