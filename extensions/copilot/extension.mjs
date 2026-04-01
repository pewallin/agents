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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { approveAll } from "@github/copilot-sdk";
import { joinSession } from "@github/copilot-sdk/extension";

// Resolve agents binary — may not be on PATH in sandboxed processes
const AGENTS_BIN = [
  join(homedir(), ".local", "bin", "agents"),
  "agents",
].find((p) => p === "agents" || existsSync(p)) || "agents";

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
  execFile(AGENTS_BIN, args, (err) => {
    if (err) {
      // Silently ignore — agents CLI may not be on PATH
    }
  });
}

const session = await joinSession({
  onPermissionRequest: approveAll,
  hooks: {
    onUserPromptSubmitted: async () => {
      report("working");
    },
    onSessionEnd: async () => {
      report("idle");
    },
  },
});

externalSessionId = session.sessionId;

session.on("session.start", (event) => {
  externalSessionId = event.data?.sessionId || session.sessionId;
  applyModelSelection(event.data?.selectedModel, "github-copilot");
});

session.on("session.model_change", (event) => {
  applyModelSelection(event.data?.newModel, currentProvider || "github-copilot");
});

// Context window tracking
session.on("session.usage_info", (event) => {
  if (event.data) {
    contextTokens = event.data.currentTokens;
    contextMax = event.data.tokenLimit;
  }
});

// Permission prompt — agent needs user approval for a tool
session.on("permission.requested", () => {
  report("approval");
});

// Tool started — check if it's ask_user (question for user) or a regular tool
session.on("tool.execution_start", (event) => {
  if (event.data.toolName === "ask_user") {
    report("question");
  } else {
    report("working");
  }
});

// Tool finished — back to working (more tools may follow)
session.on("tool.execution_complete", () => {
  report("working");
});

// Compaction — report working state with context
session.on("session.compaction_start", () => {
  report("working", ["--context", "compacting"]);
});

session.on("session.compaction_complete", () => {
  report("idle");
});

// Turn completed — agent is waiting for input
session.on("session.idle", () => {
  report("idle");
});
