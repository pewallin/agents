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
import { appendFile, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
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
const DEBUG_LOG = process.env.AGENTS_PI_REPORT_DEBUG;

// Use TMUX_PANE (%N) as session ID so each pane gets independent status
const SESSION_ID = process.env.TMUX_PANE || "default";
const MAX_DETAIL_LENGTH = 60;
const TERMINAL_ASSISTANT_STOP_REASONS = new Set(["stop", "length"] as const);

type PiState = "working" | "idle" | "question";
type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

function debug(event: string, data: Record<string, unknown> = {}): void {
  if (!DEBUG_LOG) return;
  appendFile(
    DEBUG_LOG,
    JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n",
    () => {},
  );
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

function report(state: PiState, ctx: any, detail?: string | null): void {
  const args = ["report", "--agent", "pi", "--state", state, "--session", SESSION_ID];
  if (detail === null) {
    args.push("--clear-detail");
  } else if (detail) {
    args.push("--detail", detail.slice(0, MAX_DETAIL_LENGTH));
  }
  appendModel(args, ctx);
  appendSessionMetadata(args, ctx);
  debug("report", { state, detail, agentsBin: AGENTS_BIN, args });
  execFile(AGENTS_BIN, args, (error) => {
    if (error) debug("report_error", { state, detail, message: error.message });
  });
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

function normalizeToolDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_DETAIL_LENGTH) : undefined;
}

function basenameIfPath(value: unknown): string | undefined {
  const detail = normalizeToolDetail(value);
  return detail ? basename(detail) : undefined;
}

function isAssistantMessage(message: any): boolean {
  return message?.role === "assistant";
}

function getStreamingToolName(event: any): string | undefined {
  return describeToolActivity(
    event?.assistantMessageEvent?.toolCall?.name ??
      event?.assistantMessageEvent?.toolCall?.toolName ??
      event?.assistantMessageEvent?.toolName,
    event?.assistantMessageEvent?.toolCall?.args,
  );
}

function describeToolActivity(toolName: unknown, args?: any): string | undefined {
  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName) return undefined;
  switch (normalizedToolName) {
    case "read":
      return basenameIfPath(args?.path) ?? normalizedToolName;
    case "edit":
    case "write":
      return basenameIfPath(args?.path) ?? normalizedToolName;
    case "bash":
      return normalizeToolDetail(args?.command) ?? normalizedToolName;
    case "grep":
      return normalizeToolDetail(args?.pattern) ?? basenameIfPath(args?.path) ?? normalizedToolName;
    case "find":
    case "ls":
      return basenameIfPath(args?.path) ?? normalizedToolName;
    default:
      return normalizedToolName;
  }
}

export function getAssistantStopReason(message: any): AssistantStopReason | undefined {
  const stopReason = message?.stopReason;
  if (
    stopReason === "stop" ||
    stopReason === "length" ||
    stopReason === "toolUse" ||
    stopReason === "error" ||
    stopReason === "aborted"
  ) {
    return stopReason;
  }
  return undefined;
}

export function shouldSettleIdleAfterAgentEnd({
  activePrompt,
  pendingToolExecutions,
}: {
  activePrompt: boolean;
  pendingToolExecutions: number;
  hasPendingMessages?: boolean;
  isIdle?: boolean;
  lastAssistantStopReason?: AssistantStopReason;
}): boolean {
  if (!activePrompt) return false;
  if (pendingToolExecutions > 0) return false;
  return true;
}

function shouldSettleIdleFromActivityBoundary({
  activePrompt,
  pendingToolExecutions,
  hasPendingMessages,
  isIdle,
  lastAssistantStopReason,
}: {
  activePrompt: boolean;
  pendingToolExecutions: number;
  hasPendingMessages: boolean;
  isIdle: boolean;
  lastAssistantStopReason?: AssistantStopReason;
}): boolean {
  if (!activePrompt) return false;
  if (pendingToolExecutions > 0) return false;
  if (hasPendingMessages) return false;
  if (!isIdle) return false;
  return !!lastAssistantStopReason && TERMINAL_ASSISTANT_STOP_REASONS.has(lastAssistantStopReason);
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  let activePrompt = false;
  let lastState: PiState | undefined;
  let lastDetail: string | undefined;
  let lastAssistantStopReason: AssistantStopReason | undefined;
  let lastAssistantMessageSeen: any | undefined;
  const pendingToolExecutions = new Set<string>();
  const activeToolNames = new Map<string, string>();

  function setState(state: PiState, ctx: any, detail?: string | null, force = false): void {
    if (!force && lastState === state && lastDetail === detail) return;
    report(state, ctx, detail);
    lastState = state;
    lastDetail = detail ?? undefined;
  }

  function setWorking(ctx: any, detail?: string): void {
    setState("working", ctx, detail);
  }

  function ctxIsIdle(ctx: any): boolean {
    try {
      return !!ctx?.isIdle?.();
    } catch {
      return false;
    }
  }

  function ctxHasPendingMessages(ctx: any): boolean {
    try {
      return !!ctx?.hasPendingMessages?.();
    } catch {
      return false;
    }
  }

  function clearActivity(): void {
    pendingToolExecutions.clear();
    activeToolNames.clear();
  }

  function currentToolDetail(): string | undefined {
    const names = Array.from(activeToolNames.values());
    if (names.length === 0) return undefined;
    if (names.length === 1) return names[0];
    const newest = names[names.length - 1];
    return `${newest} +${names.length - 1}`.slice(0, MAX_DETAIL_LENGTH);
  }

  function syncWorkingDetail(ctx: any, fallback = "thinking"): void {
    if (!activePrompt) return;
    const toolDetail = currentToolDetail();
    if (toolDetail) {
      setWorking(ctx, toolDetail);
      return;
    }
    if (!ctxIsIdle(ctx)) {
      setWorking(ctx, fallback);
    }
  }

  function maybeSettleIdle(ctx: any): void {
    const shouldSettle = shouldSettleIdleFromActivityBoundary({
      activePrompt,
      pendingToolExecutions: pendingToolExecutions.size,
      hasPendingMessages: ctxHasPendingMessages(ctx),
      isIdle: ctxIsIdle(ctx),
      lastAssistantStopReason,
    });
    if (!shouldSettle) return;
    activePrompt = false;
    clearActivity();
    if (lastAssistantMessageSeen && endsWithQuestion(lastAssistantMessageSeen)) {
      setState("question", ctx, null, true);
    } else {
      setState("idle", ctx, null, true);
    }
  }

  pi.on("agent_start", async (_event: any, ctx: any) => {
    debug("agent_start");
    activePrompt = true;
    lastAssistantStopReason = undefined;
    lastAssistantMessageSeen = undefined;
    clearActivity();
    setWorking(ctx, "starting");
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const last = lastAssistantMessage(messages);
    if (last) lastAssistantMessageSeen = last;
    debug("agent_end", {
      activePrompt,
      pendingToolExecutions: pendingToolExecutions.size,
      lastAssistantStopReason,
      ctxIdle: ctxIsIdle(ctx),
      ctxHasPendingMessages: ctxHasPendingMessages(ctx),
      messages: messages.length,
    });
    if (!shouldSettleIdleAfterAgentEnd({ activePrompt, pendingToolExecutions: pendingToolExecutions.size })) {
      syncWorkingDetail(ctx);
      return;
    }
    activePrompt = false;
    clearActivity();
    if (lastAssistantMessageSeen && endsWithQuestion(lastAssistantMessageSeen)) {
      setState("question", ctx, null, true);
    } else {
      setState("idle", ctx, null, true);
    }
  });

  pi.on("message_update", async (event: any, ctx: any) => {
    if (!activePrompt) return;
    debug("message_update", { type: event?.assistantMessageEvent?.type });
    switch (event?.assistantMessageEvent?.type) {
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
        setWorking(ctx, "thinking");
        return;
      case "text_start":
      case "text_delta":
      case "text_end":
        setWorking(ctx, "responding");
        return;
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        setWorking(ctx, getStreamingToolName(event) ?? "tool");
        return;
      default:
        return;
    }
  });

  pi.on("message_end", async (event: any) => {
    if (!isAssistantMessage(event?.message)) return;
    lastAssistantMessageSeen = event.message;
    lastAssistantStopReason = getAssistantStopReason(event.message);
    debug("message_end", { stopReason: lastAssistantStopReason });
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    debug("tool_call", { toolName: event?.toolName, toolCallId: event?.toolCallId });
    if (event?.toolName === "AskUserQuestion" || event?.toolName === "ask_user") {
      activePrompt = false;
      clearActivity();
      setState("question", ctx, null, true);
      return;
    }
    setWorking(ctx, describeToolActivity(event?.toolName, event?.args ?? event?.input) ?? "tool");
  });

  pi.on("tool_execution_start", async (event: any, ctx: any) => {
    debug("tool_execution_start", { toolName: event?.toolName, toolCallId: event?.toolCallId });
    if (!activePrompt) activePrompt = true;
    const toolName = describeToolActivity(event?.toolName, event?.args) ?? "tool";
    if (typeof event?.toolCallId === "string" && event.toolCallId) {
      pendingToolExecutions.add(event.toolCallId);
      activeToolNames.set(event.toolCallId, toolName);
    }
    setWorking(ctx, toolName);
  });

  pi.on("tool_execution_end", async (event: any, ctx: any) => {
    debug("tool_execution_end", { toolName: event?.toolName, toolCallId: event?.toolCallId, isError: event?.isError });
    if (typeof event?.toolCallId === "string" && event.toolCallId) {
      pendingToolExecutions.delete(event.toolCallId);
      activeToolNames.delete(event.toolCallId);
    }
    if (!activePrompt) return;
    if (event?.isError) {
      const toolName = describeToolActivity(event?.toolName, event?.args) ?? "tool";
      setWorking(ctx, `${toolName} failed`.slice(0, MAX_DETAIL_LENGTH));
      return;
    }
    maybeSettleIdle(ctx);
    if (!activePrompt) return;
    syncWorkingDetail(ctx);
  });

  pi.on("session_before_compact", async (_event: any, ctx: any) => {
    debug("session_before_compact");
    activePrompt = true;
    lastAssistantStopReason = undefined;
    lastAssistantMessageSeen = undefined;
    setWorking(ctx, "compacting");
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    debug("session_compact");
    maybeSettleIdle(ctx);
    if (!activePrompt) return;
    syncWorkingDetail(ctx);
  });

  pi.on("turn_end", async (_event: any, ctx: any) => {
    debug("turn_end", {
      activePrompt,
      pendingToolExecutions: pendingToolExecutions.size,
      lastAssistantStopReason,
      ctxIdle: ctxIsIdle(ctx),
      ctxHasPendingMessages: ctxHasPendingMessages(ctx),
    });
    maybeSettleIdle(ctx);
  });

  pi.on("session_switch", async (_event: any, ctx: any) => {
    activePrompt = false;
    lastAssistantStopReason = undefined;
    lastAssistantMessageSeen = undefined;
    clearActivity();
    setState("idle", ctx, null, true);
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    activePrompt = false;
    lastAssistantStopReason = undefined;
    lastAssistantMessageSeen = undefined;
    clearActivity();
    setState("idle", ctx, null, true);
  });
};

export default extension;
