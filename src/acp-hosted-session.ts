// A session the host itself holds with a hand-off agent, for an agent pane that starts in its ACP
// view with work to do (a spawned worker's brief) or that is sent work later (its coordinator's
// lines): the host prompts the agent over ACP, as the TUI would be typed into. A view of the pane
// attaches to the same agent process instead of starting one of its own: it is answered from what
// the host already knows (initialize, the session's history) and its other messages pass through.
//
// One agent process, one session: the view's requests get ids of their own toward the agent, and
// the agent's questions (permissions) wait for a view when none is attached.
//
// A view may attach while the host still opens the session (a pane restored in its view, a TUI
// handing over): its initialize and load wait for the host's own, it is given the history the
// load has replayed so far and then the rest as it comes, and its load is answered when the
// session is open. An agent that replays its history before it is ready (Claude replays the
// transcript while Claude Code starts) fills the view meanwhile.
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { AcpLaunchSettingsApplier, type AcpLaunchSettings } from "./acp-launch-settings.js";
import { AcpUsageFill } from "./acp-usage-fill.js";
import { KiroSteering } from "./kiro-steering.js";
import { AcpCompaction, type CompactionWay } from "./acp-compaction.js";
import type { StateUsage } from "./scanner-state-runtime.js";

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
  /** What the pane's TUI command sets on the session (acp-launch-settings.ts). */
  launchSettings?: AcpLaunchSettings;
  /** For an agent that reports no usage over ACP: its session's context and spend (acp-usage-fill.ts). */
  sessionUsage?: (sessionId: string) => StateUsage;
  /** The agent is Kiro, which takes steering through an extension of its own (kiro-steering.ts). */
  kiroSteering?: boolean;
  /** The agent's /compact is the host's (acp-compaction.ts). */
  compaction?: CompactionWay;
}

export interface HostedView {
  /** A message from the view. */
  fromView(line: string): void;
  detach(): void;
}

interface AttachedView {
  send: (line: string) => void;
  ids: Map<string, Id>;
  /** The view has been given the session's history: the session's updates go to it live. */
  synced: boolean;
}

/** Settles with `work`, and never rejects unhandled while no one waits on it. */
function settled(work: Promise<unknown>): Promise<void> {
  const done = work.then(() => undefined);
  done.catch(() => {});
  return done;
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
  /** What a view steers with, by the agent's id of the request: history once the agent took it. */
  private readonly steered = new Map<string, unknown[]>();
  /** The agent's requests no view has answered yet: sent again to the next view. */
  private readonly asks = new Map<string, string>();
  private view: AttachedView | undefined;
  /** Settled when the host's own initialize and session open have: views that ask meanwhile wait. */
  private initializing: Promise<void> | undefined;
  private opening: Promise<void> | undefined;
  private readonly exited: Promise<void>;
  private readonly launchSettings: AcpLaunchSettingsApplier | undefined;
  private readonly usage: AcpUsageFill | undefined;
  private readonly steering: KiroSteering | undefined;
  private readonly compaction: AcpCompaction | undefined;

  constructor(private readonly child: ChildProcess, private readonly taps: HostedSessionTaps = {}) {
    this.launchSettings = taps.launchSettings && new AcpLaunchSettingsApplier(taps.launchSettings, (line) => this.toAgent(line), taps.log, (line) => this.fromAgent(line));
    this.usage = taps.sessionUsage && new AcpUsageFill(taps.sessionUsage, (line) => this.fromAgent(line));
    this.steering = taps.kiroSteering ? new KiroSteering((line) => this.writeToAgent(line), (line) => this.fromAgent(line), taps.log) : undefined;
    this.compaction = taps.compaction && new AcpCompaction(taps.compaction, (line) => this.writeToAgent(line), (line) => this.fromAgent(line), taps.log);
    createInterface({ input: child.stdout! }).on("line", (line) => { if (line.trim()) this.fromAgent(line); });
    this.exited = new Promise((resolve) => child.once("exit", () => {
      this.usage?.close();
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
    // A view that attaches while the session opens waits for these (fromView).
    if (existing) this.sessionId = existing;
    const initialize = this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "agents-acp-host", version: "1" },
    }, 30_000);
    this.initializing = settled(initialize);
    this.initialized = await initialize;
    if (existing) {
      // The load replays the session: its updates are the history a view is given.
      const load = this.request("session/load", { sessionId: existing, cwd, mcpServers: [] }, 90_000);
      this.opening = settled(load);
      this.opened = { ...await load, sessionId: existing };
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
    const prompt = [{ type: "text", text }];
    // The agent does not repeat a prompt back: the view sees it from here.
    this.userMessage(prompt, true);
    const result = await this.request("session/prompt", { sessionId: this.sessionId, prompt });
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
    const prompt = [{ type: "text", text }];
    const result = await this.request("_session/steering", {
      sessionId: this.sessionId, prompt, _meta: { steering: { idleBehavior: "promptRequired" } },
    }, 30_000);
    if (result.outcome === "promptRequired") return "idle";
    this.userMessage(prompt, true);
    return "steered";
  }

  /** A view of the session: it gets the agent's messages, and its own pass through. The view that
   *  attaches last has the session; one before it is let go (`replaced`). */
  attach(send: (line: string) => void, replaced?: () => void): HostedView {
    const previous = this.view;
    const view: AttachedView = { send, ids: new Map<string, Id>(), synced: false };
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
    if (this.steering?.clientLine(line)) {
      // Kiro's steer goes to it in its own words; the taps see what the view asked.
      this.taps.onClientLine?.(line);
      return;
    }
    if (this.compaction?.clientLine(line)) {
      this.taps.onClientLine?.(line);
      return;
    }
    this.launchSettings?.clientLine(line);
    this.usage?.clientLine(line);
    this.writeToAgent(line);
  }

  private writeToAgent(line: string): void {
    this.taps.onClientLine?.(line);
    this.child.stdin?.write(`${line}\n`);
  }

  /** A message of the user's, block by block as it was sent: a view that loads the session later
   *  shows its images and files as well as its text. */
  private userMessage(prompt: unknown[], live: boolean): void {
    if (!this.sessionId) return;
    for (const content of prompt) {
      const line = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: this.sessionId, update: { sessionUpdate: "user_message_chunk", content } },
      });
      this.history.push(line);
      if (live && this.view?.synced) this.view.send(line);
    }
  }

  private fromAgent(raw: string): void {
    const steered = this.steering ? this.steering.agentLine(raw) : raw;
    const line = steered !== undefined && this.compaction ? this.compaction.agentLine(steered) : steered;
    if (line === undefined) return;
    if (this.launchSettings?.agentLine(line)) return;
    this.usage?.agentLine(line);
    this.taps.onAgentLine?.(line);
    const message = parse(line);
    if (!message) return;
    this.followSettings(message);
    const key = message.id === undefined || message.id === null ? undefined : String(message.id);
    if (key !== undefined && message.method === undefined) {
      const own = this.pending.get(key);
      if (own) {
        this.pending.delete(key);
        if (message.error) own.reject(new Error(message.error.message ?? "the agent refused"));
        else own.resolve(message.result ?? {});
        return;
      }
      // A view's steer the agent took is part of the conversation; one it did not take comes
      // again as a prompt.
      const steer = this.steered.get(key);
      if (steer) {
        this.steered.delete(key);
        if (!message.error && message.result?.outcome !== "promptRequired") this.userMessage(steer, false);
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
    else if (message.method === "session/update" && message.params?.sessionId === this.sessionId) {
      this.history.push(line);
      // A view not given the history yet gets this update with it.
      if (!this.view?.synced) return;
    }
    this.view?.send(line);
  }

  private loadsOwnSession(message: Message): boolean {
    return (message.method === "session/load" || message.method === "session/resume")
      && this.sessionId !== undefined && message.params?.sessionId === this.sessionId;
  }

  /** The session's history so far; what comes after goes to the view live. */
  private giveHistory(view: AttachedView): void {
    for (const update of this.history) view.send(update);
    view.synced = true;
  }

  private answerLoad(view: AttachedView, id: Id): void {
    const { sessionId: _sessionId, ...opened } = this.opened ?? {};
    view.send(JSON.stringify({ jsonrpc: "2.0", id, result: opened }));
    for (const ask of this.asks.values()) view.send(ask);
  }

  /** `answer` once `work` is done, for a view still attached; an error answer if it failed. */
  private whenSettled(view: AttachedView, id: Id, work: Promise<void>, answer: () => void): void {
    work.then(
      () => { if (this.view === view) answer(); },
      (error: unknown) => {
        if (this.view !== view) return;
        const reason = error instanceof Error ? error.message : String(error);
        view.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: `The session did not open: ${reason}` } }));
      },
    );
  }

  /** A view that loads the session later is given the mode and settings it has now, not those
   *  it opened with. */
  private followSettings(message: Message): void {
    const update = message.params?.update as { sessionUpdate?: unknown; currentModeId?: unknown; configOptions?: unknown } | undefined;
    if (!this.opened || message.method !== "session/update" || message.params?.sessionId !== this.sessionId) return;
    const modes = this.opened.modes as Record<string, unknown> | undefined;
    if (update?.sessionUpdate === "current_mode_update" && modes && typeof update.currentModeId === "string") {
      this.opened = { ...this.opened, modes: { ...modes, currentModeId: update.currentModeId } };
    } else if (update?.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
      this.opened = { ...this.opened, configOptions: update.configOptions };
    }
  }

  private fromView(view: AttachedView, line: string): void {
    const message = parse(line);
    if (!message) return;
    const id = message.id;
    if (id === undefined || id === null) {
      this.toAgent(line);
      return;
    }
    // The host's own initialize or session open is under way: the view's waits for it. A load is
    // given the history so far at once, the rest live, and its answer once the session is open.
    if (message.method === "initialize" && !this.initialized && this.initializing) {
      this.whenSettled(view, id, this.initializing, () => view.send(JSON.stringify({ jsonrpc: "2.0", id, result: this.initialized })));
      return;
    }
    if (this.loadsOwnSession(message) && !this.opened && this.opening) {
      this.giveHistory(view);
      this.whenSettled(view, id, this.opening, () => this.answerLoad(view, id));
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
    if (this.loadsOwnSession(message) && this.opened) {
      this.giveHistory(view);
      this.answerLoad(view, id);
      return;
    }
    const agentId = `view-${this.nextViewId++}`;
    const prompt = message.params?.sessionId === this.sessionId && Array.isArray(message.params?.prompt) ? message.params.prompt as unknown[] : undefined;
    if (prompt && message.method === "session/prompt") this.userMessage(prompt, false);
    if (prompt && message.method === "_session/steering") this.steered.set(agentId, prompt);
    view.ids.set(agentId, id);
    this.toAgent(JSON.stringify({ ...message, id: agentId }));
  }
}
