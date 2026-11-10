// Steering for Kiro: kiro-cli takes a message into the turn it is working on with an extension of
// its own, `_session/steer {sessionId, message}` (both its v2 and v3 engines, kiro-cli 3.1), and
// delivers it at the turn's next tool boundary, or at its end, where the turn goes on with it. The
// host speaks the protocol the view and its own session use for Codex and Claude instead
// (`_session/steering`, with `idleBehavior: "promptRequired"`): this sits between a client and the
// agent and translates.
//
// Kiro also queues a message when no turn runs, and holds it for the next prompt. A steer that
// finds the turn over is withdrawn (`_session/steer/clear`) and answered "promptRequired", so the
// client prompts with it instead, as it does for the other agents.

type Id = string | number;

interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

function parse(line: string): Message | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Message : undefined;
  } catch {
    return undefined;
  }
}

/** What Kiro steers with: one string. A link is its address; an image or audio cannot go. */
export function steerText(prompt: unknown): string | undefined {
  if (!Array.isArray(prompt)) return undefined;
  const parts: string[] = [];
  for (const block of prompt as Array<{ type?: unknown; text?: unknown; uri?: unknown; resource?: { uri?: unknown } }>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "resource_link" && typeof block.uri === "string") parts.push(block.uri);
    else if (block?.type === "resource" && typeof block.resource?.uri === "string") parts.push(block.resource.uri);
    else return undefined;
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}

/** Whether a line from Kiro says a steered message went into the turn (v3 and v2 spell it apart). */
function injectedInto(message: Message): string | undefined {
  const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;
  const update = message.params?.update as { sessionUpdate?: unknown; _meta?: { kiro?: { kind?: unknown } } | null } | undefined;
  if (message.method === "session/update" && update?.sessionUpdate === "session_info_update" && update._meta?.kiro?.kind === "steering_injected") return sessionId;
  if (message.method === "_kiro.dev/session/update" && update?.sessionUpdate === "AgentExecutionSteeringInjected") return sessionId;
  return undefined;
}

export class KiroSteering {
  private nextId = 1;
  private readonly initializing = new Set<string>();
  /** The prompts running, by id, and the session each is for. */
  private readonly prompts = new Map<string, string>();
  /** How many steered messages went into each session's turns so far. */
  private readonly injected = new Map<string, number>();
  /** The steers asked of Kiro, by our id: the client's request and what was injected before it. */
  private readonly steers = new Map<string, { clientId: Id; sessionId: string; injectedBefore: number }>();
  /** Our withdrawals of a message Kiro queued for an idle session: their answers go nowhere. */
  private readonly clears = new Set<string>();

  constructor(
    private readonly toAgent: (line: string) => void,
    private readonly toClient: (line: string) => void,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** A message on its way to the agent; true when it is handled here and goes no further. */
  clientLine(line: string): boolean {
    const message = parse(line);
    if (!message || message.id === undefined || message.id === null || !message.method) return false;
    const key = String(message.id);
    if (message.method === "initialize") this.initializing.add(key);
    if (message.method === "session/prompt" && typeof message.params?.sessionId === "string") this.prompts.set(key, message.params.sessionId);
    if (message.method !== "_session/steering") return false;
    this.steer(message.id, message.params ?? {});
    return true;
  }

  /** A message from the agent: the line to pass on, rewritten where it needs to be, or undefined
   *  when it is handled here. */
  agentLine(line: string): string | undefined {
    const message = parse(line);
    if (!message) return line;
    const injected = injectedInto(message);
    if (injected) this.injected.set(injected, (this.injected.get(injected) ?? 0) + 1);
    if (message.method !== undefined || message.id === undefined || message.id === null) return line;
    const key = String(message.id);
    if (this.clears.delete(key)) return undefined;
    const steer = this.steers.get(key);
    if (steer) {
      this.steers.delete(key);
      this.answered(steer, message);
      return undefined;
    }
    this.prompts.delete(key);
    if (this.initializing.delete(key) && message.result) {
      // Says the agent takes steering, as Codex and Claude say it.
      const meta = (message.result._meta ?? {}) as Record<string, unknown>;
      const steering = (meta.steering ?? {}) as Record<string, unknown>;
      return JSON.stringify({ ...message, result: { ...message.result, _meta: { ...meta, steering: { ...steering, supported: true } } } });
    }
    return line;
  }

  private running(sessionId: string): boolean {
    for (const session of this.prompts.values()) if (session === sessionId) return true;
    return false;
  }

  private steer(clientId: Id, params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!sessionId) {
      this.reply(clientId, undefined, { code: -32602, message: "A steer needs a sessionId." });
      return;
    }
    // No turn of this process runs: the client prompts with it (Kiro would hold it for later).
    if (!this.running(sessionId)) {
      this.reply(clientId, { outcome: "promptRequired" });
      return;
    }
    const text = steerText(params.prompt);
    if (!text) {
      this.reply(clientId, undefined, { code: -32602, message: "Kiro takes text into a running turn, not images: queue the message for after the turn instead." });
      return;
    }
    const id = `kiro-steer-${this.nextId++}`;
    this.steers.set(id, { clientId, sessionId, injectedBefore: this.injected.get(sessionId) ?? 0 });
    this.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method: "_session/steer", params: { sessionId, message: text } }));
  }

  private answered(steer: { clientId: Id; sessionId: string; injectedBefore: number }, message: Message): void {
    if (message.error) {
      this.reply(steer.clientId, undefined, message.error);
      return;
    }
    if (message.result?.queued === false) {
      this.log(`kiro dropped a steer (${String(message.result.dropped ?? "no reason")}): prompting with it`);
      this.reply(steer.clientId, { outcome: "promptRequired" });
      return;
    }
    const taken = (this.injected.get(steer.sessionId) ?? 0) > steer.injectedBefore;
    if (taken || this.running(steer.sessionId)) {
      this.reply(steer.clientId, { outcome: "steered" });
      return;
    }
    // The turn ended before Kiro had it: Kiro holds it for the next prompt. Take it back.
    const id = `kiro-steer-${this.nextId++}`;
    this.clears.add(id);
    this.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method: "_session/steer/clear", params: { sessionId: steer.sessionId } }));
    this.reply(steer.clientId, { outcome: "promptRequired" });
  }

  private reply(id: Id, result?: Record<string, unknown>, error?: Message["error"]): void {
    this.toClient(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }));
  }
}
