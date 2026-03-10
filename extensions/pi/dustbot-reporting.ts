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

function report(state: string): void {
  execFile("agents", ["report", "--agent", "pi", "--state", state], (err) => {
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
