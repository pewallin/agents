/**
 * Agents reporting extension for Copilot CLI.
 *
 * Reports copilot state (working/idle/approval) to the agents dashboard
 * via `agents report` so the tmux agent monitor can track status.
 *
 * - working: user prompt submitted, or tool executing
 * - approval: ask_user tool is waiting for user input
 * - idle: turn complete, waiting for next prompt
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

function report(state) {
  execFile(AGENTS_BIN, ["report", "--agent", "copilot", "--state", state, "--session", SESSION_ID], (err) => {
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

// Turn completed — agent is waiting for input
session.on("session.idle", () => {
  report("idle");
});
