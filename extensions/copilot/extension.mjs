/**
 * Agents reporting extension for Copilot CLI.
 *
 * Reports copilot state (working/idle/approval) plus structured model metadata
 * to the agents dashboard via `agents report`.
 *
 * - working: user prompt submitted, or tool executing
 * - approval: a permission request waits for the user (working again once it is answered)
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
// Session spend in nano-AIU: the last usage checkpoint (session-wide) plus each call since.
let spendNanoAiu = undefined;
let sawAssistantUsage = false;
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

// Reports run one at a time, in the order of their events. Each one checks the pane's process
// tree, which takes a moment: started side by side, a "working" from a tool's end could land after
// the turn's "idle" and leave the pane working until its next turn.
let reportChain = Promise.resolve();

function report(state, extraArgs = []) {
  const args = ["report", "--agent", "copilot", "--state", state, "--session", SESSION_ID, ...extraArgs];
  if (currentProvider) args.push("--provider", String(currentProvider));
  if (currentModelId) args.push("--model-id", String(currentModelId));
  if (currentModelLabel) args.push("--model-label", String(currentModelLabel));
  if (currentProvider || currentModelId || currentModelLabel) args.push("--model-source", "sdk");
  if (externalSessionId) args.push("--external-session-id", String(externalSessionId));
  if (contextTokens !== undefined) args.push("--context-tokens", String(contextTokens));
  if (contextMax !== undefined) args.push("--context-max", String(contextMax));
  if (spendNanoAiu !== undefined) args.push("--spend", String(Math.round(spendNanoAiu / 1e7) / 100), "--spend-unit", "AIU");
  const command = agentsCommand("copilot", args);
  reportChain = reportChain.then(() => new Promise((resolve) => {
    execFile(...command, (err) => {
      if (err) {
        console.error(`[agents-reporting] agents report failed: ${err.message}`);
      }
      resolve();
    });
  }));
  return reportChain;
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
      // A checkpoint's total covers every call before it.
      if (event.type === "session.usage_checkpoint" && typeof event.data?.totalNanoAiu === "number") {
        spendNanoAiu = event.data.totalNanoAiu;
      }
      break;
    case "assistant.usage": {
      const nanoAiu = event.data?.copilotUsage?.totalNanoAiu;
      if (typeof nanoAiu === "number") {
        sawAssistantUsage = true;
        spendNanoAiu = (spendNanoAiu ?? 0) + nanoAiu;
      }
      break;
    }
    case "session.usage_record": {
      // Newer CLIs record each call this way too; count it only where assistant.usage is absent.
      const nanoAiu = event.data?.totalNanoAiu ?? event.data?.copilotUsage?.totalNanoAiu ?? event.data?.total_nano_aiu;
      if (!sawAssistantUsage && typeof nanoAiu === "number") spendNanoAiu = (spendNanoAiu ?? 0) + nanoAiu;
      break;
    }
    case "permission.requested":
      report("approval");
      break;
    case "tool.execution_start":
      report(event.data?.toolName === "ask_user" ? "question" : "working");
      break;
    // Answered (or approved on its own): the tool runs, or the turn goes on.
    case "permission.completed":
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
      await report("exited");
    },
  },
});

externalSessionId = session.sessionId;
