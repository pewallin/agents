// Context and spend for an ACP view whose agent reports none over ACP (Kiro): the host reads them
// where the pane's header does (paneSessionUsage: the hooks' state, Kiro's session files) when a
// session opens and when each turn ends, and gives them to the view as a usage_update of the
// agent's. An agent that sends a usage_update of its own is left to it from then on.
import type { StateUsage } from "./scanner-state-runtime.js";

/** Marks a usage_update the host made, so it is not taken for the agent's own. */
export const FILLED_USAGE_META = "agents/paneUsage";

const OPENS_OR_TURNS = new Set(["session/new", "session/load", "session/resume", "session/prompt"]);

interface Message {
  id?: string | number | null;
  method?: string;
  params?: { sessionId?: unknown; update?: { sessionUpdate?: unknown; _meta?: Record<string, unknown> | null } };
  result?: { sessionId?: unknown };
  error?: unknown;
}

function parse(line: string): Message | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Message : undefined;
  } catch {
    return undefined;
  }
}

/** The usage_update a view is sent, or none when there is nothing to show. */
export function filledUsageUpdate(sessionId: string, usage: StateUsage): string | undefined {
  const context = usage.contextTokens !== undefined && usage.contextMax !== undefined && usage.contextMax > 0;
  if (!context && usage.spend === undefined) return undefined;
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        // No context known: a size of 0 tells the view to show the spend alone.
        used: context ? usage.contextTokens : 0,
        size: context ? usage.contextMax : 0,
        ...(usage.spend !== undefined ? { cost: { amount: usage.spend, currency: usage.spendUnit ?? "" } } : {}),
        _meta: { [FILLED_USAGE_META]: true },
      },
    },
  });
}

export class AcpUsageFill {
  private reports = false;
  /** Requests that open a session or run a turn, by id: the session they name, if they name one. */
  private readonly asked = new Map<string, string | undefined>();
  /** What each session was last sent, so the same usage is not sent again. */
  private readonly sent = new Map<string, string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  /**
   * @param read the session's usage now
   * @param send gives a line to the view as if the agent sent it
   * @param againMs the agent may write a turn's usage just after it ends: read once more then
   */
  constructor(
    private readonly read: (sessionId: string) => StateUsage,
    private readonly send: (line: string) => void,
    private readonly againMs = 2_000,
  ) {}

  /** A line to the agent. */
  clientLine(line: string): void {
    if (this.reports || this.closed) return;
    const message = parse(line);
    if (!message || message.id === undefined || message.id === null || !OPENS_OR_TURNS.has(message.method ?? "")) return;
    const sessionId = message.params?.sessionId;
    this.asked.set(String(message.id), typeof sessionId === "string" ? sessionId : undefined);
  }

  /** A line from the agent. Call it before the line goes on to the view: what it sends follows. */
  agentLine(line: string): void {
    if (this.reports || this.closed) return;
    const message = parse(line);
    if (!message) return;
    const update = message.params?.update;
    if (message.method === "session/update" && update?.sessionUpdate === "usage_update") {
      if (update._meta?.[FILLED_USAGE_META] !== true) {
        this.reports = true;
        this.close();
      }
      return;
    }
    if (message.method !== undefined || message.id === undefined || message.id === null) return;
    const key = String(message.id);
    if (!this.asked.has(key)) return;
    const named = this.asked.get(key);
    this.asked.delete(key);
    const sessionId = named ?? message.result?.sessionId;
    if (message.error !== undefined || typeof sessionId !== "string" || !sessionId) return;
    this.later(sessionId, 0);
    this.later(sessionId, this.againMs);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.asked.clear();
  }

  private later(sessionId: string, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      let line: string | undefined;
      try {
        line = filledUsageUpdate(sessionId, this.read(sessionId));
      } catch {
        return;
      }
      if (!line || this.sent.get(sessionId) === line) return;
      this.sent.set(sessionId, line);
      this.send(line);
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
  }
}
