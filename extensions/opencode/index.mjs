/**
 * Agents reporting plugin for OpenCode.
 *
 * Reports opencode state (working/idle/approval/question) to the agents
 * dashboard via `agents report` so the tmux agent monitor can track status.
 *
 * Install: add "opencode-agents-reporting" to the plugin array in opencode.json,
 * or run `agents setup` to have it configured automatically.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Resolve agents binary — may not be on PATH in sandboxed processes
const AGENTS_BIN = [
  join(homedir(), ".local", "bin", "agents"),
  "agents",
].find((p) => p === "agents" || existsSync(p)) || "agents";

// Use TMUX_PANE (%N) as session ID so each pane gets independent status
const SESSION_ID = process.env.TMUX_PANE || "default";

function report(state) {
  execFile(AGENTS_BIN, ["report", "--agent", "opencode", "--state", state, "--session", SESSION_ID], () => {});
}

// Report idle synchronously on exit so the state file is written before the process dies
function reportSync(state) {
  try {
    execFileSync(AGENTS_BIN, ["report", "--agent", "opencode", "--state", state, "--session", SESSION_ID], { timeout: 3000 });
  } catch {}
}

// Ensure we report idle on shutdown regardless of how opencode exits
process.on("exit", () => reportSync("idle"));
process.on("SIGINT", () => { reportSync("idle"); process.exit(0); });
process.on("SIGTERM", () => { reportSync("idle"); process.exit(0); });

/** @type {import("@opencode-ai/plugin").Plugin} */
const plugin = async () => {
  return {
    event: async ({ event }) => {
      const type = /** @type {string} */ (event.type);

      if (type === "session.status") {
        const status = event.properties?.status;
        if (status?.type === "busy") {
          report("working");
        } else if (status?.type === "idle") {
          report("idle");
        }
      }

      // Redundant idle signal — some sessions fire this without session.status
      if (type === "session.idle") {
        report("idle");
      }

      if (type === "session.error") {
        report("approval");
      }

      // permission.asked / permission.replied may not be in the Event type union yet
      if (type === "permission.asked") {
        report("approval");
      }

      if (type === "permission.replied") {
        // User responded to permission prompt — agent resumes working
        report("working");
      }
    },

    "tool.execute.before": async (input) => {
      // Detect question tools (agent asking the user something)
      if (input.tool === "question" || input.tool === "ask_user" || input.tool === "ask") {
        report("question");
      }
    },
  };
};

export default plugin;
