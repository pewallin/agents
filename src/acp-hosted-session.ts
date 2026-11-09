// A session the host itself holds with a hand-off agent, for an agent pane that starts in its ACP
// view with work to do (a spawned worker's brief) or that is sent work later (its coordinator's
// lines): the host prompts the agent over ACP, as the TUI would be typed into. A view of the pane
// attaches to the same agent process instead of starting one of its own: it is answered from what
// the host already knows (initialize, the session's history) and its other messages pass through.
//
// One agent process, one session: the view's requests get ids of their own toward the agent, and
// the agent's questions (permissions) wait for a view when none is attached.
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { AcpApprovals, type AcpApprovalPolicy } from "./acp-approvals.js";

type Id = string | number;

interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

function parse(line: string): Message | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Message : undefined;
  } catch {
    return undefined;
  }
}

export interface HostedSessionTaps {
  /** Each line from the agent, as the host's other bridges report them. */
  onAgentLine?: (line: string) => void;
  /** Each line to the agent. */
  onClientLine?: (line: string) => void;
  log?: (message: string) => void;
  /** The pane command runs tools without asking (acp-approvals.ts). */
  approvals?: AcpApprovalPolicy;
}

export interface HostedView {
  /** A message from the view. */
  fromView(line: string): void;
  detach(): void;
}

export class HostedSession {
  sessionId: string | undefined;
  private nextId = 1;
  private nextViewId = 1;
  private readonly pending = new Map<string, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private initialized: Record<string, unknown> | undefined;
  private opened: Record<string, unknown> | undefined;
  /** The session's updates so far, replayed to a view that loads it. */
  private readonly history: string[] = [];
  /** The agent's requests no view has answered yet: sent again to the next view. */
  private readonly asks = new Map<string, string>();
  private view: { send: (line: string) => void; ids: Map<string, Id> } | undefined;
  private readonly exited: Promise<void>;
  private readonly approvals: AcpApprovals | undefined;

  constructor(private readonly child: ChildProcess, private readonly taps: HostedSessionTaps = {}) {
    this.approvals = taps.approvals && new AcpApprovals(taps.approvals, (line) => this.toAgent(line), taps.log, (line) => this.fromAgent(line));
    createInterface({ input: child.stdout! }).on("line", (line) => { if (line.trim()) this.fromAgent(line); });
    this.exited = new Promise((resolve) => child.once("exit", () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error("the agent exited"));
      this.pending.clear();
      resolve();
    }));
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Initializes the agent and starts a session in `cwd`, or loads `existing`. */
  async start(cwd: string, existing?: string): Promise<string> {
    this.initialized = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agents-acp-host", version: "1" },
    }, 30_000);
    if (existing) {
      // The load replays the session: its updates are the history a view is given.
      this.sessionId = existing;
      this.opened = { ...await this.request("session/load", { sessionId: existing, cwd, mcpServers: [] }, 90_000), sessionId: existing };
      return existing;
    }
    this.opened = await this.request("session/new", { cwd, mcpServers: [] }, 60_000);
    const sessionId = this.opened.sessionId;
    if (typeof sessionId !== "string" || !sessionId) throw new Error("the agent started no session");
    this.sessionId = sessionId;
    return sessionId;
  }

  /** Prompts the agent with `text`, as typed into its TUI; resolves when its turn ends. */
  async prompt(text: string): Promise<string | undefined> {
    if (!this.sessionId) throw new Error("the session has not started");
    // The agent does not repeat a prompt back: the view sees it from here.
    this.userMessage(text, true);
    const result = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    return typeof result.stopReason === "string" ? result.stopReason : undefined;
  }

  /** Whether the agent takes steering over ACP (`_session/steering`, its initialize says so). */
  get steers(): boolean {
    const meta = (this.initialized as { _meta?: { steering?: { supported?: unknown } } } | undefined)?._meta;
    return meta?.steering?.supported === true;
  }

  /** Adds `text` to the agent's running turn: "steered", or "idle" when no turn runs (the caller
   *  prompts instead), or "unsupported" for an agent that takes no steering over ACP. */
  async steer(text: string): Promise<"steered" | "idle" | "unsupported"> {
    if (!this.sessionId) throw new Error("the session has not started");
    if (!this.steers) return "unsupported";
    const result = await this.request("_session/steering", {
      sessionId: this.sessionId, prompt: [{ type: "text", text }], _meta: { steering: { idleBehavior: "promptRequired" } },
    }, 30_000);
    if (result.outcome === "promptRequired") return "idle";
    this.userMessage(text, true);
    return "steered";
  }

  /** A view of the session: it gets the agent's messages, and its own pass through. The view that
   *  attaches last has the session; one before it is let go (`replaced`). */
  attach(send: (line: string) => void, replaced?: () => void): HostedView {
    const previous = this.view;
    const view = { send, ids: new Map<string, Id>() };
    this.view = view;
    if (previous) replaced?.();
    return {
      fromView: (line) => { if (this.view === view) this.fromView(view, line); },
      detach: () => { if (this.view === view) this.view = undefined; },
    };
  }

  async stop(): Promise<void> {
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
    await this.exited;
  }

  /** A request of the host's own; one with `timeoutMs` fails when the agent does not answer in time. */
  private request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const id = `host-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`the agent did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private toAgent(line: string): void {
    this.approvals?.clientLine(line);
    this.taps.onClientLine?.(line);
    this.child.stdin?.write(`${line}\n`);
  }

  private userMessage(text: string, live: boolean): void {
    if (!this.sessionId) return;
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: this.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } },
    });
    this.history.push(line);
    if (live) this.view?.send(line);
  }

  private fromAgent(line: string): void {
    if (this.approvals?.agentLine(line)) return;
    this.taps.onAgentLine?.(line);
    const message = parse(line);
    if (!message) return;
    this.followMode(message);
    const key = message.id === undefined || message.id === null ? undefined : String(message.id);
    if (key !== undefined && message.method === undefined) {
      const own = this.pending.get(key);
      if (own) {
        this.pending.delete(key);
        if (message.error) own.reject(new Error(message.error.message ?? "the agent refused"));
        else own.resolve(message.result ?? {});
        return;
      }
      const view = this.view;
      const viewId = view?.ids.get(key);
      if (view && viewId !== undefined) {
        view.ids.delete(key);
        view.send(JSON.stringify({ ...message, id: viewId }));
      }
      return;
    }
    if (key !== undefined) this.asks.set(key, line);
    else if (message.method === "session/update" && message.params?.sessionId === this.sessionId) this.history.push(line);
    this.view?.send(line);
  }

  /** A view that loads the session later is given the mode it is in now, not the one it opened in. */
  private followMode(message: Message): void {
    const update = message.params?.update as { sessionUpdate?: unknown; currentModeId?: unknown } | undefined;
    if (message.method !== "session/update" || message.params?.sessionId !== this.sessionId || update?.sessionUpdate !== "current_mode_update") return;
    const modes = this.opened?.modes as Record<string, unknown> | undefined;
    if (this.opened && modes && typeof update.currentModeId === "string") this.opened = { ...this.opened, modes: { ...modes, currentModeId: update.currentModeId } };
  }

  private fromView(view: { send: (line: string) => void; ids: Map<string, Id> }, line: string): void {
    const message = parse(line);
    if (!message) return;
    const id = message.id;
    if (id === undefined || id === null) {
      this.toAgent(line);
      return;
    }
    if (message.method === undefined) {
      // The view answers the agent's question.
      this.asks.delete(String(id));
      this.toAgent(line);
      return;
    }
    if (message.method === "initialize" && this.initialized) {
      view.send(JSON.stringify({ jsonrpc: "2.0", id, result: this.initialized }));
      return;
    }
    const loads = message.method === "session/load" || message.method === "session/resume";
    if (loads && message.params?.sessionId === this.sessionId && this.opened) {
      for (const update of this.history) view.send(update);
      const { sessionId: _sessionId, ...opened } = this.opened;
      view.send(JSON.stringify({ jsonrpc: "2.0", id, result: opened }));
      for (const ask of this.asks.values()) view.send(ask);
      return;
    }
    if (message.method === "session/prompt" && message.params?.sessionId === this.sessionId) {
      const prompt = message.params?.prompt as Array<{ type?: string; text?: string }> | undefined;
      this.userMessage((prompt ?? []).map((block) => block.type === "text" ? block.text ?? "" : "").join(""), false);
    }
    const agentId = `view-${this.nextViewId++}`;
    view.ids.set(agentId, id);
    this.toAgent(JSON.stringify({ ...message, id: agentId }));
  }
}
