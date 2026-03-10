/**
 * Pi reporting extension: reports agent state to the agents dashboard.
 *
 * Hooks:
 *   agent_start      — reports "working" state
 *   agent_end        — reports "idle" state
 *   session_shutdown — reports "idle" state (cleanup)
 *
 * Uses `agents report` CLI to write state files that the tmux agent monitor reads.
 *
 * Install: symlink or copy to ~/.pi/agent/extensions/
 */
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Resolve agents binary — may not be on PATH in sandboxed pi processes
const AGENTS_BIN = [
  join(homedir(), ".local", "bin", "agents"),
  "agents", // fallback to PATH
].find((p) => p === "agents" || existsSync(p)) || "agents";

// Use TMUX_PANE (%N) as session ID so each pane gets independent status
const SESSION_ID = process.env.TMUX_PANE || "default";

function report(state: string): void {
  execFile(AGENTS_BIN, ["report", "--agent", "pi", "--state", state, "--session", SESSION_ID], (err) => {
    // Silently ignore — agents CLI may not be on PATH
  });
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("agent_start", async () => {
    report("working");
  });

  pi.on("agent_end", async () => {
    report("idle");
  });

  pi.on("session_shutdown", async () => {
    report("idle");
  });
};

export default extension;
