import { existsSync, readFileSync, statSync } from "fs";
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

export function runtimeStateFromAgent(agent: AgentPane): AgentRuntimeState {
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
