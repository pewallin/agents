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
import { appendFile, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// Reports go through the shared hook library (extensions/lib/agents-hook.sh): it picks a node
// that actually starts and logs failures to <agents home>/logs/hooks.log.
const HOOK_LIB = (() => {
  try {
    return join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "lib", "agents-hook.sh");
  } catch {
    return "";
  }
})();

function agentsCommand(agent: string, args: string[]): [string, string[]] {
  if (HOOK_LIB && existsSync(HOOK_LIB)) {
    return ["/bin/bash", ["-c", '. "$1"; shift; agents_hook_run "$@"', "agents-hook", HOOK_LIB, agent, ...args]];
  }
  return [AGENTS_BIN, args];
}
const DEBUG_LOG = process.env.AGENTS_PI_REPORT_DEBUG;

// Use TMUX_PANE (%N) as session ID so each pane gets independent status
const SESSION_ID = process.env.TMUX_PANE || "default";
const MAX_DETAIL_LENGTH = 60;
const MAX_INTENT_LENGTH = 160;
const MAX_RESPONSE_PREVIEW_LENGTH = 320;
const TERMINAL_ASSISTANT_STOP_REASONS = new Set(["stop", "length"] as const);

type PiState = "working" | "idle" | "question" | "exited";
type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

interface ReportMetadata {
  intent?: string;
  clearIntent?: boolean;
  responsePreview?: string;
  clearResponsePreview?: boolean;
}

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

function report(state: PiState, ctx: any, detail?: string | null, metadata: ReportMetadata = {}): void {
  const args = ["report", "--agent", "pi", "--state", state, "--session", SESSION_ID];
  if (detail === null) {
    args.push("--clear-detail");
  } else if (detail) {
    args.push("--detail", detail.slice(0, MAX_DETAIL_LENGTH));
  }
  if (metadata.clearIntent) {
    args.push("--clear-intent");
  } else if (metadata.intent) {
    args.push("--intent", metadata.intent.slice(0, MAX_INTENT_LENGTH));
  }
  if (metadata.clearResponsePreview) {
    args.push("--clear-response-preview");
  } else if (metadata.responsePreview) {
    args.push("--response-preview", metadata.responsePreview);
  }
  appendModel(args, ctx);
  appendSessionMetadata(args, ctx);
  debug("report", { state, detail, intent: metadata.intent, clearIntent: metadata.clearIntent, agentsBin: AGENTS_BIN, args });
  execFile(...agentsCommand("pi", args), (error) => {
    if (error) debug("report_error", { state, detail, message: error.message });
  });
}

function assistantText(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c?.text === "string" && c.text)
    .map((c: any) => c.text)
    .join("\n");
}

/** The beginning of an assistant message on one line, for the app's finished notification. */
export function responsePreview(message: any): string | undefined {
  try {
    const text = assistantText(message).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, MAX_RESPONSE_PREVIEW_LENGTH) : undefined;
  } catch {
    return undefined;
  }
}

/** Check if the last 3 non-empty lines of a message contain a question mark. */
function endsWithQuestion(message: any): boolean {
  try {
    const text = assistantText(message);
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

export function normalizeIntent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_INTENT_LENGTH);
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

// Steered messages (docs/steer-inbox.md): a coordinator's `agents-app-control agent send --mode
// steer` puts a message in this pane's steer inbox; while a prompt runs, this extension takes it
// and hands it to Pi with sendUserMessage(..., { deliverAs: "steer" }), which delivers it after
// the current tool calls and before the next model call, inside the same run. Taking is a rename
// (<id>.msg -> <id>.taken), so a message the CLI withdraws at the same moment is taken or
// withdrawn, never both. <id>.ack.json says steered when Pi has it, acknowledged when Pi shows it
// as a user message of the run.
export function steerInboxDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const serverPid = env.TMUX?.split(",")[1];
  const pane = env.TMUX_PANE;
  if (!serverPid || !pane?.startsWith("%")) return undefined;
  const home = env.AGENTS_HOME || join(env.AGENTS_SHARED_HOME || join(homedir(), ".agents"), env.AGENTS_PRODUCT_DIRNAME || "agents-app");
  return join(env.AGENTS_TMP_DIR || join(home, "runtime", "tmp"), "steer", `${serverPid}-pane-${pane.slice(1)}`);
}

const STEER_POLL_MS = 500;

export function createSteerInbox(pi: Pick<ExtensionAPI, "sendUserMessage">, dir: string | undefined, now = () => new Date()) {
  const waiting = new Map<string, string>();
  const ack = (id: string, state: string, detail: string) => {
    try {
      writeFileSync(join(dir!, `${id}.ack.json`), `${JSON.stringify({ state, detail, at: now().toISOString() })}\n`);
    } catch {}
  };
  return {
    // Says that this pane's Pi takes steered messages.
    announce(): void {
      if (!dir) return;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "harness.json"), `${JSON.stringify({ harness: "pi", pid: process.pid, at: now().toISOString() })}\n`);
      } catch {}
    },
    // Takes every waiting message and hands it to the run in progress.
    take(): number {
      if (!dir) return 0;
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((name) => name.endsWith(".msg")).sort();
      } catch {
        return 0;
      }
      let taken = 0;
      for (const name of names) {
        const id = name.slice(0, -4);
        const takenFile = join(dir, `${id}.taken`);
        try {
          renameSync(join(dir, name), takenFile);
        } catch {
          continue; // Withdrawn, or taken by another reader.
        }
        let text = "";
        try {
          text = String(JSON.parse(readFileSync(takenFile, "utf8")).text || "").trim();
        } catch {}
        if (!text) {
          ack(id, "rejected", "no text");
          continue;
        }
        try {
          pi.sendUserMessage(text, { deliverAs: "steer" });
        } catch (error) {
          ack(id, "rejected", `Pi refused it: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        waiting.set(text, id);
        ack(id, "steered", "handed to Pi with deliverAs: steer");
        taken += 1;
      }
      return taken;
    },
    // A user message of the run that is one of ours: Pi delivered it into the run.
    delivered(message: any): void {
      if (message?.role !== "user" || waiting.size === 0) return;
      const content = message.content;
      const text = (typeof content === "string" ? content : Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("") : "").trim();
      const id = waiting.get(text);
      if (!id) return;
      waiting.delete(text);
      ack(id, "acknowledged", "Pi delivered it into the run as a user message");
    },
  };
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  let activePrompt = false;
  let lastState: PiState | undefined;
  let lastDetail: string | undefined;
  let lastIntent: string | undefined;
  let pendingIntent: string | undefined;
  let lastAssistantStopReason: AssistantStopReason | undefined;
  let lastAssistantMessageSeen: any | undefined;
  const pendingToolExecutions = new Set<string>();
  const activeToolNames = new Map<string, string>();
  const steerInbox = createSteerInbox(pi, steerInboxDirectory());
  let steerTimer: ReturnType<typeof setInterval> | undefined;
  let steerCtx: any;

  // Only while a run is in progress and not idle: a message for an idle Pi is not steering.
  function startSteering(ctx: any): void {
    steerCtx = ctx;
    if (steerTimer) return;
    steerInbox.announce();
    steerTimer = setInterval(() => {
      if (!activePrompt || ctxIsIdle(steerCtx)) return;
      steerInbox.take();
    }, STEER_POLL_MS);
    steerTimer.unref?.();
  }

  function stopSteering(): void {
    if (steerTimer) clearInterval(steerTimer);
    steerTimer = undefined;
  }

  function setState(state: PiState, ctx: any, detail?: string | null, force = false, metadata: ReportMetadata = {}): void {
    const nextIntent = metadata.clearIntent ? undefined : metadata.intent ?? lastIntent;
    if (!force && lastState === state && lastDetail === detail && lastIntent === nextIntent) return;
    report(state, ctx, detail, metadata);
    lastState = state;
    lastDetail = detail ?? undefined;
    lastIntent = nextIntent;
  }

  function setWorking(ctx: any, detail?: string, metadata: ReportMetadata = {}, force = false): void {
    setState("working", ctx, detail, force, metadata);
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
    stopSteering();
    clearActivity();
    const preview = responsePreview(lastAssistantMessageSeen);
    const metadata = preview ? { responsePreview: preview } : {};
    if (lastAssistantMessageSeen && endsWithQuestion(lastAssistantMessageSeen)) {
      setState("question", ctx, null, true, metadata);
    } else {
      setState("idle", ctx, null, true, metadata);
    }
  }

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    pendingIntent = normalizeIntent(event?.prompt);
    debug("before_agent_start", { hasIntent: !!pendingIntent, intent: pendingIntent });
    activePrompt = true;
    setWorking(
      ctx,
      "starting",
      pendingIntent
        ? { intent: pendingIntent, clearResponsePreview: true }
        : { clearIntent: true, clearResponsePreview: true },
      true,
    );
  });

  pi.on("session_start", async () => {
    steerInbox.announce();
  });

  pi.on("message_start", async (event: any) => {
    steerInbox.delivered(event?.message);
  });

  pi.on("agent_start", async (_event: any, ctx: any) => {
    debug("agent_start");
    startSteering(ctx);
    activePrompt = true;
    lastAssistantStopReason = undefined;
    lastAssistantMessageSeen = undefined;
    clearActivity();
    setWorking(ctx, "starting", pendingIntent ? { intent: pendingIntent } : {});
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
    stopSteering();
    clearActivity();
    const preview = responsePreview(lastAssistantMessageSeen);
    const metadata = preview ? { responsePreview: preview } : {};
    if (lastAssistantMessageSeen && endsWithQuestion(lastAssistantMessageSeen)) {
      setState("question", ctx, null, true, metadata);
    } else {
      setState("idle", ctx, null, true, metadata);
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
    pendingIntent = undefined;
    lastAssistantStopReason = undefined;
    lastAssistantMessageSeen = undefined;
    clearActivity();
    setState("idle", ctx, null, true, { clearIntent: true });
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    activePrompt = false;
    pendingIntent = undefined;
    lastAssistantStopReason = undefined;
    lastAssistantMessageSeen = undefined;
    clearActivity();
    stopSteering();
    // The agent leaves the pane: its state goes away instead of staying idle.
    setState("exited", ctx, null, true, { clearIntent: true });
  });
};

export default extension;
