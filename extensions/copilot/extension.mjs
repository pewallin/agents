/**
 * Agents reporting extension for Copilot CLI.
 *
 * Reports copilot state (working/idle/approval) to the agents dashboard
 * via `agents report` so the tmux agent monitor can track status.
 */
import { execFile } from "node:child_process";
import { joinSession } from "@github/copilot-sdk/extension";

function report(state) {
  execFile("agents", ["report", "--agent", "copilot", "--state", state], (err) => {
    if (err) {
      // Silently ignore — agents CLI may not be on PATH
    }
  });
}

const session = await joinSession({
  hooks: {
    onUserPromptSubmitted: async () => {
      report("working");
    },
    onSessionEnd: async () => {
      report("idle");
    },
  },
});

// Turn completed — agent is waiting for input
session.on("session.idle", () => {
  report("idle");
});

// Permission requested — agent needs approval
session.on("permission.requested", () => {
  report("approval");
});
