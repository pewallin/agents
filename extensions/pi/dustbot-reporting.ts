/**
 * Pi reporting extension: reports agent state to the agents dashboard.
 *
 * Hooks:
 *   agent_start      — reports "working" state
 *   agent_end        — reports "idle" state
 *   tool_call        — reports "question" for ask_user tools
 *   session_shutdown — reports "idle" state (cleanup)
 *
 * Also reports context window usage via getContextUsage().
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

function report(state: string, ctx: any): void {
  const args = ["report", "--agent", "pi", "--state", state, "--session", SESSION_ID];
  // Include context window data if available
  try {
    const usage = ctx?.getContextUsage?.();
    if (usage && usage.tokens != null && usage.contextWindow) {
      args.push("--context-tokens", String(usage.tokens), "--context-max", String(usage.contextWindow));
    }
  } catch {}
  execFile(AGENTS_BIN, args, () => {});
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("agent_start", async (ctx: any) => {
    report("working", ctx);
  });

  pi.on("agent_end", async (ctx: any) => {
    report("idle", ctx);
  });

  pi.on("tool_call", async (ctx: any) => {
    if (ctx?.tool === "AskUserQuestion" || ctx?.tool === "ask_user") {
      report("question", ctx);
    }
  });

  pi.on("turn_end", async (ctx: any) => {
    // Update context data at end of each turn
    report("idle", ctx);
  });

  pi.on("session_shutdown", async (ctx: any) => {
    report("idle", ctx);
  });
};

export default extension;
