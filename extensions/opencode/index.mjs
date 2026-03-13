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

import { appendFileSync } from "node:fs";
const LOG = join(homedir(), ".agents", "opencode-plugin.log");
function log(msg) {
  try { appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

/** @type {import("@opencode-ai/plugin").Plugin} */
const plugin = async (input) => {
  log(`plugin loaded, SESSION_ID=${SESSION_ID}, AGENTS_BIN=${AGENTS_BIN}`);

  // Poll session status via SDK client as a fallback for missed events
  const client = input?.client;
  let pollTimer = null;
  let lastPolledStatus = "";
  if (client) {
    pollTimer = setInterval(async () => {
      try {
        const res = await client.GET("/session/status");
        if (res?.data) {
          // res.data is a map of sessionID → SessionStatus
          const statuses = Object.values(res.data);
          const hasBusy = statuses.some((s) => s?.type === "busy");
          const newStatus = hasBusy ? "working" : "idle";
          if (newStatus !== lastPolledStatus) {
            log(`poll: ${lastPolledStatus} → ${newStatus}`);
            lastPolledStatus = newStatus;
            report(newStatus);
          }
        }
      } catch {}
    }, 5000);
  }

  return {
    event: async ({ event }) => {
      const type = /** @type {string} */ (event.type);
      log(`event: ${type} ${JSON.stringify(event.properties || {})}`);

      if (type === "session.status") {
        const status = event.properties?.status;
        if (status?.type === "busy") {
          lastPolledStatus = "working";
          report("working");
        } else if (status?.type === "idle") {
          lastPolledStatus = "idle";
          report("idle");
        }
      }

      if (type === "session.idle") {
        lastPolledStatus = "idle";
        report("idle");
      }

      if (type === "session.error") {
        report("approval");
      }

      // SDK uses "permission.updated" (not "permission.asked")
      if (type === "permission.updated") {
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
