/**
 * Pi reporting extension: reports agent state to the agents dashboard.
 *
 * Pi exposes a richer lifecycle than the older reporter used. We treat:
 * - agent_start / agent_end as the outer prompt lifecycle
 * - message_update as active model thinking/streaming
 * - tool_execution_* as active tool work
 * - tool_call ask_user as a user-question state
 *
 * Install: symlink or copy to ~/.pi/agent/extensions/
 */
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Resolve agents binary — may not be on PATH in sandboxed/pi processes.
// Check common install locations since PATH may be minimal.
function findAgentsBin(): string {
  try {
    const nvmDir = join(homedir(), ".nvm", "versions", "node");
    const versions = readdirSync(nvmDir).sort().reverse();
    for (const v of versions) {
      const p = join(nvmDir, v, "bin", "agents");
      if (existsSync(p)) return p;
    }
  } catch {}
  for (const p of [join(homedir(), ".local", "bin", "agents"), "/usr/local/bin/agents"]) {
    if (existsSync(p)) return p;
  }
  return "agents";
}

const AGENTS_BIN = findAgentsBin();

// Use TMUX_PANE (%N) as session ID so each pane gets independent status
const SESSION_ID = process.env.TMUX_PANE || "default";
const IDLE_SETTLE_MS = 250;
const MAX_DETAIL_LENGTH = 60;

type PiState = "working" | "idle" | "question";
type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

function isAssistantStopReason(value: unknown): value is AssistantStopReason {
  return (
    value === "stop" ||
    value === "length" ||
    value === "toolUse" ||
    value === "error" ||
    value === "aborted"
  );
}

export function getAssistantStopReason(message: any): AssistantStopReason | undefined {
  const stopReason = message?.stopReason;
  return isAssistantStopReason(stopReason) ? stopReason : undefined;
}

function hasPendingMessages(ctx: any): boolean {
  try {
    return Boolean(ctx?.hasPendingMessages?.());
  } catch {
    return false;
  }
}

function isIdle(ctx: any): boolean {
  try {
    return Boolean(ctx?.isIdle?.());
  } catch {
    return false;
  }
}

export function shouldSettleIdleAfterAgentEnd(opts: {
  activePrompt: boolean;
  pendingToolExecutions: number;
  hasPendingMessages: boolean;
  isIdle: boolean;
  lastAssistantStopReason?: string;
}): boolean {
  if (!opts.activePrompt) return false;
  if (opts.pendingToolExecutions > 0) return false;
  if (!opts.isIdle) return false;
  if (opts.hasPendingMessages) return false;
  return opts.lastAssistantStopReason === "stop" || opts.lastAssistantStopReason === "length";
}

function appendModel(args: string[], ctx: any): void {
  try {
    const model = ctx?.model;
    if (typeof model?.provider === "string" && model.provider) args.push("--provider", model.provider);
    if (typeof model?.id === "string" && model.id) args.push("--model-id", model.id);
    if (typeof model?.name === "string" && model.name) args.push("--model-label", model.name);
    if (model?.provider || model?.id || model?.name) args.push("--model-source", "hook");
  } catch {}
}

function appendSessionMetadata(args: string[], ctx: any): void {
  try {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (typeof sessionId === "string" && sessionId) {
      args.push("--external-session-id", sessionId);
    }
  } catch {}

  try {
    const usage = ctx?.getContextUsage?.();
    if (usage && usage.tokens != null && usage.contextWindow) {
      args.push("--context-tokens", String(usage.tokens), "--context-max", String(usage.contextWindow));
    }
  } catch {}
}

function report(state: PiState, ctx: any, detail?: string): void {
  const args = ["report", "--agent", "pi", "--state", state, "--session", SESSION_ID];
  if (detail) args.push("--detail", detail.slice(0, MAX_DETAIL_LENGTH));
  appendModel(args, ctx);
  appendSessionMetadata(args, ctx);
  execFile(AGENTS_BIN, args, () => {});
}

/** Check if the last 3 non-empty lines of a message contain a question mark. */
function endsWithQuestion(message: any): boolean {
  try {
    const content = message?.content;
    if (!Array.isArray(content)) return false;
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

function lastAssistantMessage(messages: any[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function normalizeToolName(toolName: unknown): string | undefined {
  if (typeof toolName !== "string") return undefined;
  const trimmed = toolName.trim();
  return trimmed ? trimmed.slice(0, MAX_DETAIL_LENGTH) : undefined;
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  let activePrompt = false;
  let lastState: PiState | undefined;
  let lastDetail: string | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const pendingToolExecutions = new Set<string>();

  function clearIdleTimer(): void {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function setState(state: PiState, ctx: any, detail?: string, force = false): void {
    if (!force && lastState === state && lastDetail === detail) return;
    report(state, ctx, detail);
    lastState = state;
    lastDetail = detail;
  }

  function setWorking(ctx: any, detail?: string): void {
    clearIdleTimer();
    setState("working", ctx, detail);
  }

  function settleIdle(ctx: any): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      activePrompt = false;
      setState("idle", ctx, undefined, true);
    }, IDLE_SETTLE_MS);
  }

  pi.on("agent_start", async (_event: any, ctx: any) => {
    activePrompt = true;
    pendingToolExecutions.clear();
    setWorking(ctx, "starting");
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const last = lastAssistantMessage(messages);
    if (last && endsWithQuestion(last)) {
      activePrompt = false;
      clearIdleTimer();
      setState("question", ctx);
      return;
    }
    if (
      !shouldSettleIdleAfterAgentEnd({
        activePrompt,
        pendingToolExecutions: pendingToolExecutions.size,
        hasPendingMessages: hasPendingMessages(ctx),
        isIdle: isIdle(ctx),
        lastAssistantStopReason: getAssistantStopReason(last),
      })
    ) {
      return;
    }
    settleIdle(ctx);
  });

  pi.on("message_update", async (event: any, ctx: any) => {
    if (!activePrompt) return;
    if (event?.assistantMessageEvent?.type !== "text_delta") return;
    setWorking(ctx, "thinking");
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    clearIdleTimer();
    if (event?.toolName === "AskUserQuestion" || event?.toolName === "ask_user") {
      activePrompt = false;
      setState("question", ctx);
      return;
    }
    setWorking(ctx, normalizeToolName(event?.toolName) ?? "tool");
  });

  pi.on("tool_execution_start", async (event: any, ctx: any) => {
    if (!activePrompt) activePrompt = true;
    if (typeof event?.toolCallId === "string" && event.toolCallId) {
      pendingToolExecutions.add(event.toolCallId);
    }
    setWorking(ctx, normalizeToolName(event?.toolName) ?? "tool");
  });

  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    if (typeof event?.toolCallId === "string" && event.toolCallId) {
      pendingToolExecutions.delete(event.toolCallId);
    }
    if (!activePrompt) return;
    if (event?.isError) {
      const toolName = normalizeToolName(event?.toolName) ?? "tool";
      setWorking(ctx, `${toolName} failed`.slice(0, MAX_DETAIL_LENGTH));
      return;
    }
    setWorking(ctx, "thinking");
  });

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    activePrompt = true;
    setWorking(ctx, "compacting");
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    if (!activePrompt) return;
    setWorking(ctx, "thinking");
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    if (!activePrompt) return;
    setWorking(ctx, "thinking");
  });

  pi.on("session_switch", async (_event: any, ctx: any) => {
    activePrompt = false;
    pendingToolExecutions.clear();
    clearIdleTimer();
    setState("idle", ctx, undefined, true);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    activePrompt = false;
    pendingToolExecutions.clear();
    clearIdleTimer();
    setState("idle", ctx, undefined, true);
  });
};

export default extension;
