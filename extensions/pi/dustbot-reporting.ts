/**
 * Pi reporting extension: reports agent state to the agents dashboard.
 *
 * Hooks:
 *   agent_start      — reports "working" state
 *   agent_end        — reports "idle" state
 *   tool_call        — reports "question" for ask_user tools, otherwise "working"
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

function appendModel(args: string[], ctx: any): void {
  try {
    const model = ctx?.model;
    const label = model?.name || model?.id;
    if (label) args.push("--model", String(label));
  } catch {}
}

function report(state: string, ctx: any): void {
  const args = ["report", "--agent", "pi", "--state", state, "--session", SESSION_ID];
  appendModel(args, ctx);
  // Include context window data if available
  try {
    const usage = ctx?.getContextUsage?.();
    if (usage && usage.tokens != null && usage.contextWindow) {
      args.push("--context-tokens", String(usage.tokens), "--context-max", String(usage.contextWindow));
    }
  } catch {}
  execFile(AGENTS_BIN, args, () => {});
}

function reportWithContext(state: string, context: string, ctx: any): void {
  const args = ["report", "--agent", "pi", "--state", state, "--context", context, "--session", SESSION_ID];
  appendModel(args, ctx);
  try {
    const usage = ctx?.getContextUsage?.();
    if (usage && usage.tokens != null && usage.contextWindow) {
      args.push("--context-tokens", String(usage.tokens), "--context-max", String(usage.contextWindow));
    }
  } catch {}
  execFile(AGENTS_BIN, args, () => {});
}

/** Check if the last 3 non-empty lines of a message contain a question mark. */
function endsWithQuestion(message: any): boolean {
  try {
    const content = message?.content;
    if (!Array.isArray(content)) return false;
    // Extract text from content blocks
    const text = content
      .filter((c: any) => c?.type === "text" && c?.text)
      .map((c: any) => c.text)
      .join("\n");
    if (!text) return false;
    const lines = text.split("\n").filter((l: string) => l.trim());
    const tail = lines.slice(-3).join("\n");
    return tail.includes("?");
  } catch {
    return false;
  }
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("agent_start", async (_event: any, ctx: any) => {
    report("working", ctx);
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    // Check if the last assistant message ends with a question
    const messages = event?.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (endsWithQuestion(last)) {
        report("question", ctx);
        return;
      }
    }
    report("idle", ctx);
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event?.toolName === "AskUserQuestion" || event?.toolName === "ask_user") {
      report("question", ctx);
    } else {
      report("working", ctx);
    }
  });

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    reportWithContext("working", "compacting", ctx);
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    // Compaction is an internal step within an active run, not completion.
    report("working", ctx);
  });

  pi.on("turn_end", async (_event: any, _ctx: any) => {
    // A turn can end after an intermediate tool/result cycle.
    // Only agent_end/session_shutdown should report idle.
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    report("idle", ctx);
  });
};

export default extension;
