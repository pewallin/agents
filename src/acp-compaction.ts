// /compact for agents whose ACP agent does not offer it, so the view's /compact works for every
// agent that can compact at all. Claude, Codex and Pi list `compact` among their commands and run
// it from the prompt text; they need nothing here. The host sits between a client and these:
//
//   - Kiro (kiro-cli 3.1) compacts through an extension of its own and runs "/compact" sent as a
//     prompt as a message to the model, which answers that it compacted. Its v3 engine takes
//     `_kiro/session/compact {sessionId, value?}` and answers when the summary is written; v2 takes
//     its TUI's command, `_kiro.dev/commands/execute {sessionId, command: {command: "compact",
//     args: {value?}}}`, answers at once and says how it went in `_kiro.dev/compaction/status`.
//     A "/compact [instructions]" prompt is answered here: the compaction runs as a step of the
//     turn, with the summary as its output.
//   - OpenCode runs "/compact" from the prompt (it summarizes the session) but does not list it.
//
// Both get `compact` in their commands, and the compaction shows as the step Claude and Codex
// show for theirs: a tool call titled "Compact conversation".

type Id = string | number;

interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

interface Command { name: string; description?: string; input?: { hint: string } | null }

export type CompactionWay = "kiro" | "opencode";

/** The agents whose /compact the host provides, by their ACP registry id (acp-host-cli.ts). */
export function compactionWay(agentId: string): CompactionWay | undefined {
  if (agentId === "kiro") return "kiro";
  if (agentId === "opencode") return "opencode";
  return undefined;
}

/** The title Claude's and Codex's adapters give a compaction's step; the view knows it by it. */
export const COMPACTION_TITLE = "Compact conversation";

const METHOD_NOT_FOUND = -32601;

function parse(line: string): Message | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Message : undefined;
  } catch {
    return undefined;
  }
}

/** A prompt that is "/compact", with what is written after it; undefined for any other prompt. */
export function compactPrompt(prompt: unknown): { instructions: string } | undefined {
  if (!Array.isArray(prompt) || prompt.length !== 1) return undefined;
  const block = prompt[0] as { type?: unknown; text?: unknown };
  if (block?.type !== "text" || typeof block.text !== "string") return undefined;
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(block.text.trim());
  return match ? { instructions: (match[1] ?? "").trim() } : undefined;
}

function compactCommand(way: CompactionWay): Command {
  return way === "kiro"
    ? { name: "compact", description: "Summarize the conversation to free up context", input: { hint: "[instructions for the summary]" } }
    : { name: "compact", description: "Summarize the conversation to free up context", input: null };
}

interface Compaction {
  clientId: Id;
  sessionId: string;
  toolCallId: string;
  instructions: string;
  /** Kiro's summary, once it reports one. */
  summary?: string;
}

export class AcpCompaction {
  private nextId = 1;
  /** Kiro's engine, once one of its answers tells: v3 has `_kiro/session/compact`, v2 does not. */
  private kiroEngine: "v2" | "v3" | undefined;
  /** Requests that open a session, by id: the session to list `compact` for once it opens. */
  private readonly opening = new Map<string, string | undefined>();
  /** The sessions whose agent listed its commands. */
  private readonly listed = new Set<string>();
  /** Kiro compactions under way, by session. */
  private readonly running = new Map<string, Compaction>();
  /** Our requests to Kiro, by id: the compaction each is for and the engine it was asked of. */
  private readonly asked = new Map<string, { compaction: Compaction; engine: "v2" | "v3" }>();
  /** OpenCode's /compact prompts under way, by id: the step that shows them and the summary
   *  OpenCode writes, which becomes the step's output. */
  private readonly prompts = new Map<string, { sessionId: string; toolCallId: string; summary: string }>();

  constructor(
    private readonly way: CompactionWay,
    private readonly toAgent: (line: string) => void,
    private readonly toClient: (line: string) => void,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** A message on its way to the agent; true when it is handled here and goes no further. */
  clientLine(line: string): boolean {
    const message = parse(line);
    if (!message?.method) return false;
    const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;
    if (message.method === "session/cancel" && sessionId) {
      this.cancel(sessionId);
      return false;
    }
    if (message.id === undefined || message.id === null) return false;
    const key = String(message.id);
    if (message.method === "session/new") this.opening.set(key, undefined);
    if ((message.method === "session/load" || message.method === "session/resume") && sessionId) this.opening.set(key, sessionId);
    if (message.method !== "session/prompt" || !sessionId) return false;
    const compact = compactPrompt(message.params?.prompt);
    if (!compact) return false;
    const toolCallId = `compact-${this.nextId++}`;
    if (this.way === "opencode") {
      // OpenCode runs it; the step shows it.
      this.prompts.set(key, { sessionId, toolCallId, summary: "" });
      this.step(sessionId, { sessionUpdate: "tool_call", toolCallId, title: COMPACTION_TITLE, kind: "think", status: "in_progress" });
      return false;
    }
    if (this.running.has(sessionId)) {
      this.reply(message.id, undefined, { code: -32602, message: "Kiro is compacting this conversation already." });
      return true;
    }
    const compaction: Compaction = { clientId: message.id, sessionId, toolCallId, instructions: compact.instructions };
    this.running.set(sessionId, compaction);
    this.step(sessionId, { sessionUpdate: "tool_call", toolCallId, title: COMPACTION_TITLE, kind: "think", status: "in_progress" });
    this.askKiro(compaction, this.kiroEngine ?? "v3");
    return true;
  }

  /** A message from the agent: the line to pass on, rewritten where it needs to be, or undefined
   *  when it is handled here. */
  agentLine(line: string): string | undefined {
    const message = parse(line);
    if (!message) return line;
    if (message.method === "session/update") return this.update(message, line);
    if (message.method === "_kiro.dev/compaction/status") {
      this.kiroStatus(message.params ?? {});
      return line;
    }
    if (message.method !== undefined || message.id === undefined || message.id === null) return line;
    const key = String(message.id);
    const asked = this.asked.get(key);
    if (asked) {
      this.asked.delete(key);
      this.kiroAnswer(asked.compaction, asked.engine, message);
      return undefined;
    }
    const prompt = this.prompts.get(key);
    if (prompt) {
      this.prompts.delete(key);
      const stopped = message.result?.stopReason === "cancelled";
      const failed = message.error !== undefined || stopped;
      const text = message.error ? message.error.message ?? "The compaction failed." : stopped ? "Stopped." : prompt.summary.trim();
      this.step(prompt.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: prompt.toolCallId,
        status: failed ? "failed" : "completed",
        ...(text ? { content: textContent(text) } : {}),
      });
      return line;
    }
    if (this.opening.has(key)) {
      const sessionId = this.opening.get(key) ?? (typeof message.result?.sessionId === "string" ? message.result.sessionId : undefined);
      this.opening.delete(key);
      // An agent that lists no commands of its own (Kiro's v2 engine) still gets `compact`.
      if (sessionId && !message.error && !this.listed.has(sessionId)) {
        setImmediate(() => { if (!this.listed.has(sessionId)) this.commands(sessionId); });
      }
    }
    return line;
  }

  private update(message: Message, line: string): string | undefined {
    const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;
    const update = message.params?.update as { sessionUpdate?: unknown; availableCommands?: unknown; _meta?: { kiro?: Record<string, unknown> } | null } | undefined;
    if (!sessionId || !update) return line;
    // OpenCode writes its summary as an answer, with its thinking: it goes into the step instead.
    const summarizing = [...this.prompts.values()].find((prompt) => prompt.sessionId === sessionId);
    if (summarizing && (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")) {
      const content = (update as { content?: { type?: unknown; text?: unknown } }).content;
      if (update.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string") summarizing.summary += content.text;
      return undefined;
    }
    if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
      const commands = update.availableCommands as Command[];
      this.listed.add(sessionId);
      if (commands.some((command) => command.name === "compact")) return line;
      return JSON.stringify({ ...message, params: { ...message.params, update: { ...update, availableCommands: [...commands, compactCommand(this.way)] } } });
    }
    // Kiro v3 says the summary is written before it answers the compaction.
    const kiro = update._meta?.kiro;
    if (update.sessionUpdate === "session_info_update" && kiro?.kind === "summarization_completed") {
      const compaction = this.running.get(sessionId);
      if (compaction && typeof kiro.conversationSummary === "string") compaction.summary = kiro.conversationSummary;
    }
    return line;
  }

  private commands(sessionId: string): void {
    this.toClient(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [compactCommand(this.way)] } },
    }));
  }

  private askKiro(compaction: Compaction, engine: "v2" | "v3"): void {
    const id = `kiro-compact-${this.nextId++}`;
    this.asked.set(id, { compaction, engine });
    const value = compaction.instructions ? { value: compaction.instructions } : {};
    const request = engine === "v3"
      ? { method: "_kiro/session/compact", params: { sessionId: compaction.sessionId, ...value } }
      : { method: "_kiro.dev/commands/execute", params: { sessionId: compaction.sessionId, command: { command: "compact", args: value } } };
    this.toAgent(JSON.stringify({ jsonrpc: "2.0", id, ...request }));
  }

  private kiroAnswer(compaction: Compaction, engine: "v2" | "v3", message: Message): void {
    if (message.error?.code === METHOD_NOT_FOUND && engine === "v3") {
      // The v2 engine: it compacts through its TUI's command.
      this.kiroEngine = "v2";
      this.askKiro(compaction, "v2");
      return;
    }
    if (this.running.get(compaction.sessionId) !== compaction) return;
    if (message.error) {
      this.finish(compaction, message.error.message ?? "Kiro could not compact the conversation.");
      return;
    }
    const result = message.result ?? {};
    if (result.success === false) {
      this.finish(compaction, typeof result.message === "string" && result.message ? result.message : "Kiro could not compact the conversation.");
      return;
    }
    this.kiroEngine = engine;
    // v3 answers once the summary is written; v2 took the command, and its status notice says how it went.
    if (engine === "v3") this.finish(compaction);
  }

  private kiroStatus(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const compaction = sessionId ? this.running.get(sessionId) : undefined;
    const status = (params.status ?? {}) as { type?: unknown; error?: unknown; message?: unknown };
    if (!compaction) return;
    if (status.type === "completed") {
      if (typeof params.summary === "string") compaction.summary = params.summary;
      this.finish(compaction);
    } else if (status.type === "failed") {
      const reason = typeof status.error === "string" ? status.error : typeof status.message === "string" ? status.message : "Kiro could not compact the conversation.";
      this.finish(compaction, reason);
    }
  }

  private cancel(sessionId: string): void {
    const compaction = this.running.get(sessionId);
    if (!compaction) return;
    this.running.delete(sessionId);
    this.step(sessionId, { sessionUpdate: "tool_call_update", toolCallId: compaction.toolCallId, status: "failed", content: textContent("Stopped. Kiro may still finish the summary.") });
    this.reply(compaction.clientId, { stopReason: "cancelled" });
  }

  private finish(compaction: Compaction, failure?: string): void {
    this.running.delete(compaction.sessionId);
    if (failure) this.log(`kiro did not compact: ${failure}`);
    const text = failure ?? compaction.summary;
    this.step(compaction.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: compaction.toolCallId,
      status: failure ? "failed" : "completed",
      ...(text ? { content: textContent(text) } : {}),
    });
    this.reply(compaction.clientId, { stopReason: "end_turn" });
  }

  private step(sessionId: string, update: Record<string, unknown>): void {
    this.toClient(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }));
  }

  private reply(id: Id, result?: Record<string, unknown>, error?: Message["error"]): void {
    this.toClient(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }));
  }
}

function textContent(text: string): Array<Record<string, unknown>> {
  return [{ type: "content", content: { type: "text", text } }];
}
