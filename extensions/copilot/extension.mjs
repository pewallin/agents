/**
 * Agents reporting extension for Copilot CLI.
 *
 * Reports copilot state (working/idle/approval) plus structured model metadata
 * to the agents dashboard via `agents report`.
 *
 * - working: user prompt submitted, or tool executing
 * - approval: ask_user tool is waiting for user input
 * - idle: turn complete, waiting for next prompt
 *
 * Also tracks context window usage via session.usage_info events.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

// Resolve agents binary — may not be on PATH in sandboxed processes
const AGENTS_BIN = [
  join(homedir(), ".local", "bin", "agents"),
  "agents",
].find((p) => p === "agents" || existsSync(p)) || "agents";

// Reports go through the shared hook library (extensions/lib/agents-hook.sh): it picks a node
// that actually starts and logs failures to <agents home>/logs/hooks.log.
const HOOK_LIB = (() => {
  try {
    return join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "lib", "agents-hook.sh");
  } catch {
    return "";
  }
})();

function agentsCommand(agent, args) {
  if (HOOK_LIB && existsSync(HOOK_LIB)) {
    return ["/bin/bash", ["-c", '. "$1"; shift; agents_hook_run "$@"', "agents-hook", HOOK_LIB, agent, ...args]];
  }
  return [AGENTS_BIN, args];
}

// Use TMUX_PANE (%N) as session ID so each pane gets independent status
const SESSION_ID = process.env.TMUX_PANE || "default";

// Track context window usage and structured model identity
let contextTokens = undefined;
let contextMax = undefined;
let externalSessionId = undefined;
let currentProvider = "github-copilot";
let currentModelId = undefined;
let currentModelLabel = undefined;

function applyModelSelection(candidate, providerFallback = currentProvider) {
  if (typeof candidate !== "string" || !candidate.trim()) return;
  const trimmed = candidate.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    currentProvider = trimmed.slice(0, slash);
    currentModelId = trimmed.slice(slash + 1);
    currentModelLabel = trimmed.slice(slash + 1);
    return;
  }
  currentProvider = providerFallback || currentProvider;
  currentModelId = trimmed;
  currentModelLabel = trimmed;
}

function report(state, extraArgs = []) {
  const args = ["report", "--agent", "copilot", "--state", state, "--session", SESSION_ID, ...extraArgs];
  if (currentProvider) args.push("--provider", String(currentProvider));
  if (currentModelId) args.push("--model-id", String(currentModelId));
  if (currentModelLabel) args.push("--model-label", String(currentModelLabel));
  if (currentProvider || currentModelId || currentModelLabel) args.push("--model-source", "sdk");
  if (externalSessionId) args.push("--external-session-id", String(externalSessionId));
  if (contextTokens !== undefined) args.push("--context-tokens", String(contextTokens));
  if (contextMax !== undefined) args.push("--context-max", String(contextMax));
  execFile(...agentsCommand("copilot", args), (err) => {
    if (err) {
      console.error(`[agents-reporting] agents report failed: ${err.message}`);
    }
  });
}

function handleSessionEvent(event) {
  switch (event.type) {
    case "session.start":
      externalSessionId = event.data?.sessionId || externalSessionId;
      applyModelSelection(event.data?.selectedModel, "github-copilot");
      break;
    case "session.model_change":
      applyModelSelection(event.data?.newModel, currentProvider || "github-copilot");
      break;
    case "session.usage_info":
    case "session.usage_checkpoint":
      contextTokens = event.data?.currentTokens ?? event.data?.tokenUsage?.currentTokens ?? contextTokens;
      contextMax = event.data?.tokenLimit ?? event.data?.tokenUsage?.tokenLimit ?? contextMax;
      break;
    case "permission.requested":
      report("approval");
      break;
    case "tool.execution_start":
      report(event.data?.toolName === "ask_user" ? "question" : "working");
      break;
    case "tool.execution_complete":
    case "assistant.turn_start":
      report("working");
      break;
    case "session.compaction_start":
      report("working", ["--context", "compacting"]);
      break;
    case "session.compaction_complete":
    case "session.idle":
      report("idle");
      break;
  }
}

const session = await joinSession({
  onPermissionRequest: approveAll,
  onEvent: handleSessionEvent,
  hooks: {
    onUserPromptSubmitted: async () => {
      report("working");
    },
    onSessionEnd: async () => {
      // The agent leaves the pane: its state goes away instead of staying idle.
      report("exited");
    },
  },
});

externalSessionId = session.sessionId;
