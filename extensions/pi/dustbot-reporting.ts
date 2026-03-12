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

// Resolve agents binary — may not be on PATH in sandboxed/pi processes.
// Check common install locations since PATH may be minimal.
import { readdirSync } from "node:fs";

function findAgentsBin(): string {
  // Check nvm versions (any installed version)
  try {
    const nvmDir = join(homedir(), ".nvm", "versions", "node");
    const versions = readdirSync(nvmDir).sort().reverse();
    for (const v of versions) {
      const p = join(nvmDir, v, "bin", "agents");
      if (existsSync(p)) return p;
    }
  } catch {}
  // Other common locations
  for (const p of [join(homedir(), ".local", "bin", "agents"), "/usr/local/bin/agents"]) {
    if (existsSync(p)) return p;
  }
  return "agents";
}

const AGENTS_BIN = findAgentsBin();

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

  pi.on("tool_call", async (event: any) => {
    if (event.tool === "AskUserQuestion" || event.tool === "ask_user") {
      report("question");
    }
  });

  pi.on("session_shutdown", async () => {
    report("idle");
  });
};

export default extension;
