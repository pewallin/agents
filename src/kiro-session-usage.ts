import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Context size and spend of a Kiro session, read from Kiro's own session files. Kiro's hooks
// carry neither, so the scanner reads them for the session id the hook reported.
//
//   CLI store: ~/.kiro/sessions/cli/<id>.json, session_state.conversation_metadata.user_turn_metadatas[]
//     with metering_usage [{ value, unit: "credit" }] and final_context_usage_percentage per turn.
//   v2 store:  ~/.kiro/sessions/<workspace>/sess_<id>/messages.jsonl, events { payload: { type, ... } }:
//     usage_summary.promptTurnSummaries[].usage (credits) and session_metadata key contextUsage
//     { usagePercentage }; session.json beside it names the modelId.
//
// Kiro reports context as a percentage only, so the tokens are that share of the model's window.

export interface KiroSessionUsage {
  contextTokens?: number;
  contextMax?: number;
  spend?: number;
  spendUnit?: string;
}

const KIRO_SPEND_UNIT = "credits";

export function kiroSessionsRoot(): string {
  return process.env.AGENTS_KIRO_SESSIONS_DIR || join(homedir(), ".kiro", "sessions");
}

/** The context window of a Kiro model: one the session names, else by model family. */
export function kiroContextWindow(modelId?: string, named?: number): number {
  if (typeof named === "number" && named > 0) return named;
  const id = (modelId || "").toLowerCase();
  if (/1m|opus-(4[.-][6-9]|[5-9])|sonnet-(4[.-][6-9]|[5-9])|fable/.test(id)) return 1_000_000;
  if (/claude|sonnet|opus|haiku/.test(id)) return 200_000;
  // "auto" and unknown models: Kiro's default today is a 1M-context Claude.
  return 1_000_000;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// A context window the model info names, under whichever key this Kiro version uses.
function namedContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
  if (!modelInfo) return undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/context.*(window|limit|length|tokens)|max_input_tokens/i.test(key)) {
      const direct = finiteNumber(value);
      if (direct) return direct;
      const nested = record(value);
      const tokens = nested && (finiteNumber(nested.max_tokens) ?? finiteNumber(nested.maxTokens) ?? finiteNumber(nested.tokens));
      if (tokens) return tokens;
    }
  }
  return undefined;
}

function usageFrom(percent: number | undefined, credits: number | undefined, sawMetering: boolean, contextMax: number): KiroSessionUsage {
  return {
    ...(percent !== undefined ? { contextTokens: Math.round(contextMax * percent / 100), contextMax } : {}),
    ...(sawMetering ? { spend: Math.round((credits ?? 0) * 100) / 100, spendUnit: KIRO_SPEND_UNIT } : {}),
  };
}

/** Usage from a CLI-store session file (<id>.json). */
export function kiroUsageFromCliSession(json: unknown): KiroSessionUsage {
  const state = record(record(json)?.session_state);
  if (!state) return {};
  const turns = record(state.conversation_metadata)?.user_turn_metadatas;
  let credits = 0;
  let sawMetering = false;
  let percent: number | undefined;
  if (Array.isArray(turns)) {
    for (const turn of turns) {
      const entry = record(turn);
      if (!entry) continue;
      const metering = entry.metering_usage;
      if (Array.isArray(metering)) {
        sawMetering = true;
        for (const item of metering) {
          const value = finiteNumber(record(item)?.value);
          const unit = String(record(item)?.unit ?? "credit");
          if (value !== undefined && /credit/i.test(unit)) credits += value;
        }
      }
      percent = finiteNumber(entry.final_context_usage_percentage) ?? percent;
    }
  }
  percent = percent ?? finiteNumber(state.final_context_usage_percentage);
  const modelInfo = record(record(state.rts_model_state)?.model_info);
  const modelId = typeof modelInfo?.model_id === "string" ? modelInfo.model_id : undefined;
  return usageFrom(percent, credits, sawMetering, kiroContextWindow(modelId, namedContextWindow(modelInfo)));
}

/** Usage from a v2-store session (messages.jsonl lines, and session.json's modelId). */
export function kiroUsageFromV2Messages(lines: string[], modelId?: string): KiroSessionUsage {
  let credits = 0;
  let sawMetering = false;
  let percent: number | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let payload: Record<string, unknown> | undefined;
    try {
      payload = record(record(JSON.parse(line))?.payload);
    } catch {
      continue;
    }
    if (!payload) continue;
    if (payload.type === "usage_summary" && Array.isArray(payload.promptTurnSummaries)) {
      sawMetering = true;
      for (const summary of payload.promptTurnSummaries) {
        const usage = finiteNumber(record(summary)?.usage);
        if (usage !== undefined) credits += usage;
      }
    } else if (payload.type === "session_metadata" && payload.key === "contextUsage") {
      percent = finiteNumber(record(payload.value)?.usagePercentage) ?? percent;
    }
  }
  return usageFrom(percent, credits, sawMetering, kiroContextWindow(modelId));
}

const v2PathCache = new Map<string, string>();
const usageCache = new Map<string, { path: string; mtimeMs: number; usage: KiroSessionUsage }>();

function findV2SessionDirectory(root: string, sessionId: string): string | undefined {
  const cached = v2PathCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const names = sessionId.startsWith("sess_") ? [sessionId] : [`sess_${sessionId}`, sessionId];
  let workspaces: string[] = [];
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "cli").map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const workspace of workspaces) {
    for (const name of names) {
      const dir = join(root, workspace, name);
      if (existsSync(join(dir, "messages.jsonl"))) {
        v2PathCache.set(sessionId, dir);
        return dir;
      }
    }
  }
  return undefined;
}

/** The session's usage, re-read only when its file changed. Empty when Kiro left no file. */
export function readKiroSessionUsage(sessionId?: string, root: string = kiroSessionsRoot()): KiroSessionUsage {
  if (!sessionId || !/^[\w.-]+$/.test(sessionId)) return {};
  const cliFile = join(root, "cli", `${sessionId}.json`);
  const v2Dir = existsSync(cliFile) ? undefined : findV2SessionDirectory(root, sessionId);
  const file = v2Dir ? join(v2Dir, "messages.jsonl") : cliFile;
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const key = `${root}\0${sessionId}`;
    const cached = usageCache.get(key);
    if (cached && cached.path === file && cached.mtimeMs === mtimeMs) return cached.usage;
    let usage: KiroSessionUsage;
    if (v2Dir) {
      let modelId: string | undefined;
      try {
        const meta = record(JSON.parse(readFileSync(join(v2Dir, "session.json"), "utf-8")));
        modelId = typeof meta?.modelId === "string" ? meta.modelId : undefined;
      } catch {}
      usage = kiroUsageFromV2Messages(readFileSync(file, "utf-8").split("\n"), modelId);
    } else {
      usage = kiroUsageFromCliSession(JSON.parse(readFileSync(file, "utf-8")));
    }
    usageCache.set(key, { path: file, mtimeMs, usage });
    return usage;
  } catch {
    return {};
  }
}
