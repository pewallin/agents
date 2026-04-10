/**
 * Agents reporting plugin for OpenCode.
 *
 * Reports opencode state (working/idle/approval/question) plus structured
 * provider/model metadata to the agents dashboard via `agents report`.
 *
 * Install: add "opencode-agents-reporting" to the plugin array in opencode.json,
 * or run `agents setup` to have it configured automatically.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENTS_SHARED_HOME = process.env.AGENTS_SHARED_HOME || join(homedir(), ".agents");
const AGENTS_PRODUCT_DIRNAME = process.env.AGENTS_PRODUCT_DIRNAME || "agents-app";
const AGENTS_HOME = process.env.AGENTS_HOME || join(AGENTS_SHARED_HOME, AGENTS_PRODUCT_DIRNAME);
const AGENTS_LOG_DIR = process.env.AGENTS_LOG_DIR || join(AGENTS_HOME, "logs");

// Resolve agents binary — may not be on PATH in sandboxed processes
const AGENTS_BIN = [
  join(homedir(), ".local", "bin", "agents"),
  "agents",
].find((p) => p === "agents" || existsSync(p)) || "agents";

// Use TMUX_PANE (%N) as session ID so each pane gets independent status
const SESSION_ID = process.env.TMUX_PANE || "default";
const LOG = join(AGENTS_LOG_DIR, "opencode-plugin.log");

let currentModel = {};
let externalSessionId;
let contextTokens;
let contextMax;

function log(msg) {
  try {
    mkdirSync(AGENTS_LOG_DIR, { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeModelInfo(value) {
  if (!value || typeof value !== "object") return null;

  const provider = pickString(value.providerID, value.providerId, value.provider_id, value.provider);
  const modelId = pickString(value.modelID, value.modelId, value.model_id);
  const modelLabel = pickString(value.modelLabel, value.modelName, value.name);

  if (!provider && !modelId && !modelLabel) return null;
  return {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    modelSource: "sdk",
  };
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeUsageInfo(value) {
  if (!value || typeof value !== "object") return null;

  const tokens = pickNumber(
    value.currentTokens,
    value.current_tokens,
    value.tokens,
    value.inputTokens,
    value.input_tokens,
  );
  const max = pickNumber(
    value.tokenLimit,
    value.token_limit,
    value.contextWindow,
    value.context_window,
    value.maxTokens,
    value.max_tokens,
  );

  if (tokens === undefined && max === undefined) return null;
  return {
    ...(tokens !== undefined ? { contextTokens: tokens } : {}),
    ...(max !== undefined ? { contextMax: max } : {}),
  };
}

function extractModelInfo(event) {
  const props = event?.properties || {};
  const info = props.info || {};
  const candidates = [
    info.message?.model,
    info.message,
    info.model,
    info,
    props.message?.model,
    props.message,
    props.model,
    props,
  ];

  let fallback = null;
  for (const candidate of candidates) {
    const parsed = normalizeModelInfo(candidate);
    if (!parsed) continue;
    if (parsed.provider || parsed.modelId) return parsed;
    fallback = fallback || parsed;
  }
  return fallback;
}

function extractSessionId(event) {
  const props = event?.properties || {};
  return pickString(
    props.sessionID,
    props.sessionId,
    props.info?.sessionID,
    props.info?.sessionId,
    props.info?.session?.id,
    props.session?.id,
  );
}

function extractContextUsage(event) {
  const props = event?.properties || {};
  const info = props.info || {};
  const candidates = [
    info.message?.usage,
    info.message,
    info.usage,
    info.context,
    props.message?.usage,
    props.message,
    props.usage,
    props.context,
    props,
  ];

  for (const candidate of candidates) {
    const parsed = normalizeUsageInfo(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function appendModelArgs(args) {
  if (currentModel.provider) args.push("--provider", String(currentModel.provider));
  if (currentModel.modelId) args.push("--model-id", String(currentModel.modelId));
  if (currentModel.modelLabel) args.push("--model-label", String(currentModel.modelLabel));
  if (currentModel.provider || currentModel.modelId || currentModel.modelLabel) {
    args.push("--model-source", "sdk");
  }
}

function appendSessionArgs(args) {
  if (externalSessionId) args.push("--external-session-id", String(externalSessionId));
  if (contextTokens !== undefined) args.push("--context-tokens", String(contextTokens));
  if (contextMax !== undefined) args.push("--context-max", String(contextMax));
}

function report(state, extraArgs = []) {
  log(`report: ${state}`);
  try {
    const args = ["report", "--agent", "opencode", "--state", state, "--session", SESSION_ID, ...extraArgs];
    appendModelArgs(args);
    appendSessionArgs(args);
    execFileSync(AGENTS_BIN, args, { timeout: 3000 });
  } catch (err) {
    log(`report error: ${err.message}`);
  }
}

// Report idle synchronously on exit so the state file is written before the process dies
function reportSync(state) {
  try {
    const args = ["report", "--agent", "opencode", "--state", state, "--session", SESSION_ID];
    appendModelArgs(args);
    appendSessionArgs(args);
    execFileSync(AGENTS_BIN, args, { timeout: 3000 });
  } catch {}
}

// Ensure we report idle on shutdown regardless of how opencode exits
process.on("exit", () => reportSync("idle"));
process.on("SIGINT", () => { reportSync("idle"); process.exit(0); });
process.on("SIGTERM", () => { reportSync("idle"); process.exit(0); });

/** @type {import("@opencode-ai/plugin").Plugin} */
const plugin = async () => {
  log(`plugin loaded, SESSION_ID=${SESSION_ID}, AGENTS_BIN=${AGENTS_BIN}`);
  return {
    event: async ({ event }) => {
      const type = /** @type {string} */ (event.type);
      log(`event: ${type} ${JSON.stringify(event.properties || {})}`);

      const sessionId = extractSessionId(event);
      if (sessionId) externalSessionId = sessionId;

      const modelInfo = extractModelInfo(event);
      if (modelInfo) currentModel = { ...currentModel, ...modelInfo };

      const usageInfo = extractContextUsage(event);
      if (usageInfo) {
        if (usageInfo.contextTokens !== undefined) contextTokens = usageInfo.contextTokens;
        if (usageInfo.contextMax !== undefined) contextMax = usageInfo.contextMax;
      }

      if (type === "session.status") {
        const status = event.properties?.status;
        if (status?.type === "busy") {
          report("working");
        } else if (status?.type === "idle") {
          report("idle");
        }
      }

      if (type === "session.idle" || type === "session.compacted") {
        report("idle");
      }

      if (type === "message.updated") {
        const mode = event.properties?.info?.mode;
        if (mode === "compaction") {
          report("working", ["--context", "compacting"]);
        }
      }

      if (type === "session.error" || type === "permission.updated") {
        report("approval");
      }

      if (type === "permission.replied") {
        report("working");
      }
    },

    "tool.execute.before": async (input) => {
      log(`tool.execute.before: ${input.tool}`);
      if (input.tool === "question" || input.tool === "ask_user" || input.tool === "ask") {
        report("question");
      }
    },
  };
};

export default plugin;
