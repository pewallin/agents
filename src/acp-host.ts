// The ACP host of an agent pane (`agents acp-session`): a loopback web server that serves the
// prebuilt ACP web view and gives each WebSocket client its own process of the agent's ACP
// adapter, bridged frame per line. It knows nothing of any one agent: what to start comes from
// the agent table in acp-host-cli.ts (for Codex, codex-acp on the pane's own app-server, so the
// web view and the TUI share the thread live).
//
// Only this machine reaches it (127.0.0.1), and only a page with the pane's token can open the
// agent: the WebSocket needs the token, an Origin of this server and a Host of this server. The
// token is in the pane's metadata file (0600), which is how the app finds the host's address.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { getBuildInfo, getStateDir } from "./paths.js";
import { WebSocketServer, type WebSocket } from "ws";
import { HostedSession, type HostedView } from "./acp-hosted-session.js";
import { appControlTarget, openPageBeside, paneText, ReviewStore, sessionPanes, type AppControlTarget } from "./acp-bridge.js";
import { changesSince, commitChanges, commitInfo, gitCommandSummary, IMAGE_EXTENSIONS, inside, linkInfo, paneStates, peekFile, readBeads, resolveNames, snapshotTree, treeDiff, versionsBetween } from "./acp-peek.js";

export interface AcpHostMetadata {
  url: string;
  token: string;
  processId: number;
  /** ACP registry id of the agent the host serves. */
  agent: string;
  /**
   * live: the view shares the agent's session with its TUI (Codex, on the pane's app-server).
   * handoff: one of them has the session at a time; the view takes it over (POST /api/handoff)
   * and gives it back (POST /api/return, or Enter in the pane).
   */
  mode: "live" | "handoff";
}

export interface AcpHostOptions {
  paneId: string;
  /** The agent the host serves: its ACP registry id and the name the view shows. */
  agent: { id: string; name: string };
  runtimeTempDir: string;
  /** Directory with the built web view (index.html, assets/). */
  webRoot: string;
  /** The working directory sessions are loaded with: the pane's. */
  cwd: string;
  /** How to start the agent's ACP adapter for one client. */
  agentCommand: { command: string; args: string[]; env: NodeJS.ProcessEnv };
  /** For an agent that cannot share its session: the pane's TUI hands it over and back. */
  handoff?: AcpHandoffControl;
  /** Every line between a client and its adapter, for the pane's plain-text transcript. */
  onAgentLine?: (line: string) => void;
  onClientLine?: (line: string) => void;
  /** Called when what the view's clients see changes: a permission waits, a prompt runs, or neither. */
  onActivity?: (state: "needs-you" | "working" | "idle") => void;
  /** Where the app's control socket is; defaults to the one agents-app-control uses. */
  appControl?: AppControlTarget;
  /** Keep one agent process started ahead of the next client. */
  warmSpare?: boolean;
  port?: number;
  /** The address and token of a host of this pane that ended without closing (it crashed): a
   *  view still open on it reconnects to this one. */
  reuse?: { port: number; token: string };
  log?: (message: string) => void;
  /** The agent's own log files: their last lines go into the diagnostics. */
  agentLogFiles?: string[];
  /** The pane's agent state file (state/<agent>-<pane>.json, the agent's hooks write it): the
   *  same truth the app shows, sent to the views, so a turn the TUI runs shows in them too. */
  agentStateFile?: string;
  /** The session the pane's agent has open now, for a view that has no session id yet (Codex: the
   *  thread its TUI has loaded, from the pane's app-server), and whether it is on disk yet. */
  /** The session the pane's agent has open now, for the view's /thread/current: Codex's thread,
   *  or a hand-off agent's. A null id is none yet: the view starts one. */
  currentSession?: () => Promise<{ id: string | null; persisted: boolean; busy?: boolean } | undefined>;
  /** Starts the first turn of a session that is not on disk yet (Codex: on the app-server), and
   *  resolves once a view can load it. */
  startFirstTurn?: (sessionId: string, text: string) => Promise<void>;
}

export interface AcpHandoffControl {
  /** Whether the view has the session now; before that no client may open the agent. */
  inView(): boolean;
  /** Takes the session over from the TUI: answers 409 with a reason while the agent works. */
  /** Gives the view the session (or "current": the one the TUI has, none if it has none yet). The
   *  answer names the session the view opens; a null session is none: the view starts one. */
  handOff(sessionId: string): Promise<{ status: number; message?: string; session?: string | null }>;
  giveBack(): Promise<void>;
}

/**
 * What the pane's agent is doing as its view clients see it: a prompt in flight is work, a
 * permission request waiting on an answer needs the person. Read from the traffic the host
 * carries, so the app can ask (`GET /api/state`) without speaking ACP.
 */
export class AcpActivity {
  private readonly prompts = new Set<string>();
  private readonly asks = new Set<string>();

  clientLine(client: number, line: string): void {
    const message = parseMessage(line);
    if (!message) return;
    if (message.method === "session/prompt" && message.id !== undefined) this.prompts.add(`${client}:${message.id}`);
    else if (message.method === undefined && message.id !== undefined) this.asks.delete(`${client}:${message.id}`);
  }

  agentLine(client: number, line: string): void {
    const message = parseMessage(line);
    if (!message || message.id === undefined) return;
    if (message.method === "session/request_permission") this.asks.add(`${client}:${message.id}`);
    else if (message.method === undefined) this.prompts.delete(`${client}:${message.id}`);
  }

  clientGone(client: number): void {
    for (const set of [this.prompts, this.asks]) {
      for (const key of [...set]) if (key.startsWith(`${client}:`)) set.delete(key);
    }
  }

  get state(): "needs-you" | "working" | "idle" {
    if (this.asks.size > 0) return "needs-you";
    return this.prompts.size > 0 ? "working" : "idle";
  }
}

function parseMessage(line: string): { id?: string; method?: string } | undefined {
  try {
    const value = JSON.parse(line) as { id?: unknown; method?: unknown };
    return {
      id: value.id === undefined || value.id === null ? undefined : String(value.id),
      method: typeof value.method === "string" ? value.method : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface AcpHost {
  readonly url: string;
  readonly token: string;
  readonly metadataPath: string;
  /** Ends every client and its adapter process; the host and its warm spare stay. */
  closeClients(): void;
  close(): Promise<void>;
  /** Starts a session the host holds itself (acp-hosted-session.ts): a view of the pane then
   *  attaches to it, and prompts (POST /api/prompt) go to it. Resolves with its id. */
  startHostedSession(existing?: string): Promise<string>;
  /** Prompts the host's own session; resolves when the turn ends. */
  hostedPrompt(text: string): Promise<void>;
  /** Resolves when a view attaches to the host's session, or after `timeoutMs`. */
  viewAttached(timeoutMs: number): Promise<boolean>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function acpHostMetadataPath(runtimeTempDir: string, paneId: string): string {
  const normalized = paneId.trim().replace(/^%/, "pane-").replace(/[^A-Za-z0-9._-]/g, "-");
  return join(runtimeTempDir, "acp-session", `${normalized || "pane-unknown"}.json`);
}

export function readAcpHostMetadata(path: string): AcpHostMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AcpHostMetadata>;
    if (typeof value.url === "string" && typeof value.token === "string" && typeof value.processId === "number"
      && typeof value.agent === "string") {
      return value as AcpHostMetadata;
    }
  } catch {}
  return undefined;
}

function tokensMatch(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The host names this server answers to; anything else (DNS rebinding) is refused. */
function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function allowedOrigins(port: number): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
}

/** The last lines of a log file, or why there are none. */
export function tailOf(file: string, lines: number): string[] {
  try {
    const size = statSync(file).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    return buffer.toString("utf8").split("\n").filter(Boolean).slice(-lines);
  } catch (error) {
    return [`(${error instanceof Error ? error.message : String(error)})`];
  }
}

/** What the view's "Copy diagnostics" gets: the host's recent log and the last ACP messages. */
export class HostDiagnostics {
  private readonly logLines: string[] = [];
  private readonly messages: string[] = [];
  agentInfo: unknown;

  constructor(private readonly limits = { log: 200, messages: 80, messageLength: 2_000 }) {}

  log(message: string): void {
    this.logLines.push(`${new Date().toISOString()} ${message}`);
    if (this.logLines.length > this.limits.log) this.logLines.shift();
  }

  /** `direction` is "view→agent" or "agent→view". */
  message(client: number, direction: string, line: string): void {
    const text = line.length > this.limits.messageLength ? `${line.slice(0, this.limits.messageLength)}…` : line;
    this.messages.push(`${new Date().toISOString()} view ${client} ${direction} ${text}`);
    if (this.messages.length > this.limits.messages) this.messages.shift();
    if (direction === "agent→view" && this.agentInfo === undefined && line.includes("\"agentInfo\"")) {
      try { this.agentInfo = (JSON.parse(line) as { result?: { agentInfo?: unknown } }).result?.agentInfo; } catch { /* not JSON */ }
    }
  }

  snapshot(): { agentInfo: unknown; log: string[]; messages: string[] } {
    return { agentInfo: this.agentInfo, log: [...this.logLines], messages: [...this.messages] };
  }
}

export async function startAcpHost(options: AcpHostOptions): Promise<AcpHost> {
  const diagnostics = new HostDiagnostics();
  const log = (message: string) => { diagnostics.log(message); options.log?.(message); };
  const token = options.reuse?.token ?? randomBytes(32).toString("base64url");
  const webRoot = resolve(options.webRoot);
  const metadataPath = acpHostMetadataPath(options.runtimeTempDir, options.paneId);
  const children = new Set<ChildProcess>();
  const activity = new AcpActivity();
  const reviews = new ReviewStore();
  const events = new Set<ServerResponse>();
  let lastActivity = activity.state;
  const activityChanged = () => {
    const state = activity.state;
    if (state === lastActivity) return;
    lastActivity = state;
    options.onActivity?.(state);
  };
  // The agent's own state as its hooks report it, sent to the views as it changes.
  let agentState: string | undefined;
  const readAgentState = () => {
    if (!options.agentStateFile) return undefined;
    try {
      const value = JSON.parse(readFileSync(options.agentStateFile, "utf8")) as { state?: unknown };
      return typeof value.state === "string" ? value.state : undefined;
    } catch {
      return undefined;
    }
  };
  const agentStateChanged = () => {
    const next = readAgentState();
    if (next === agentState) return;
    agentState = next;
    const event = `event: agent-state\ndata: ${JSON.stringify({ state: next ?? null })}\n\n`;
    for (const listener of events) listener.write(event);
  };
  if (options.agentStateFile) {
    agentState = readAgentState();
    watchFile(options.agentStateFile, { interval: 500 }, agentStateChanged);
  }
  let nextClient = 1;
  let spare: ChildProcess | undefined;
  let closed = false;
  let hosted: HostedSession | undefined;
  let hostedView: { ws: WebSocket; viewId?: string } | undefined;
  const attachWaiters = new Set<() => void>();
  // One turn at a time: a line that comes while the agent works waits for its turn to end, as a
  // line typed into its TUI would.
  let hostedTurns: Promise<void> = Promise.resolve();
  const hostedPrompt = (text: string): Promise<void> => {
    const session = hosted;
    if (!session?.alive) return Promise.reject(new Error("the host holds no session"));
    const turn = hostedTurns.then(async () => {
      if (!session.alive) throw new Error("the agent exited");
      const stopReason = await session.prompt(text);
      log(`hosted turn ended (${stopReason ?? "no reason"})`);
    });
    hostedTurns = turn.catch(() => undefined);
    return turn;
  };

  const startAgent = (): ChildProcess => {
    const child = spawn(options.agentCommand.command, options.agentCommand.args, {
      env: options.agentCommand.env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    child.once("error", (error) => log(`agent failed to start: ${error.message}`));
    child.stderr?.on("data", (data: Buffer) => log(`agent ${child.pid}: ${data.toString().trimEnd()}`));
    return child;
  };
  const takeAgent = (keepSpare = true): ChildProcess => {
    const ready = spare && spare.exitCode === null && spare.signalCode === null ? spare : undefined;
    spare = undefined;
    const child = ready ?? startAgent();
    if (keepSpare && options.warmSpare && !closed) setImmediate(() => { if (!closed && !spare) spare = startAgent(); });
    return child;
  };

  const server: Server = createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    if (!allowedHosts(port).has(request.headers.host ?? "")) {
      response.writeHead(403).end("forbidden host");
      return;
    }
    if (request.method === "POST" && (request.url === "/api/handoff" || request.url === "/api/return")) {
      handleControl(request, response, token, options.handoff);
      return;
    }
    // A line for the agent, as typed into its TUI: the host's own session takes it as a prompt.
    if (request.method === "POST" && request.url === "/api/prompt") {
      const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!tokensMatch(token, auth)) {
        response.writeHead(401, { "Cache-Control": "no-store" }).end();
        return;
      }
      readJson(request).then((body) => {
        const text = (body as { text?: unknown } | undefined)?.text;
        if (typeof text !== "string" || !text.trim()) { sendJson(response, 400, { message: "A prompt is needed." }); return; }
        if (!hosted?.alive || !hosted.sessionId) { sendJson(response, 409, { message: "The host holds no session of the agent to prompt." }); return; }
        void hostedPrompt(text).catch((error: unknown) => log(`hosted prompt failed: ${error instanceof Error ? error.message : String(error)}`));
        sendJson(response, 202, { sessionId: hosted.sessionId });
      }, () => sendJson(response, 400, { message: "The body is not JSON." }));
      return;
    }
    if (handleBridge(request, response, {
      token,
      paneId: options.paneId,
      origin: `http://127.0.0.1:${port}`,
      reviews,
      events,
      appControl: options.appControl ?? appControlTarget(),
      cwd: options.cwd,
      startFirstTurn: options.startFirstTurn,
      log,
    })) return;
    handleHttp(request, response, {
      webRoot,
      token,
      cwd: options.cwd,
      agent: options.agent,
      currentSession: options.currentSession,
      state: () => ({ state: activity.state, agentState: agentState ?? null, mode: options.handoff ? "handoff" : "live", inView: options.handoff?.inView() ?? true, clients: wss.clients.size }),
      diagnostics: () => ({
        agent: options.agent,
        pane: options.paneId,
        mode: options.handoff ? "handoff" : "live",
        hostProcess: process.pid,
        agentsCLI: ((build) => (build ? `${build.version}+${build.gitCommit.slice(0, 12)}${build.dirty ? "-dirty" : ""}` : "dev"))(getBuildInfo()),
        cwd: options.cwd,
        ...diagnostics.snapshot(),
        agentLogs: Object.fromEntries((options.agentLogFiles ?? []).map((file) => [file, tailOf(file, 60)])),
      }),
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  // One view per session: two adapters on one session answer each other's questions (codex-acp
  // cancels an approval of a turn it did not start). A second view is told the session is open
  // elsewhere; it takes it over only when asked to (?takeover=1), and the first view is told.
  const views = new Map<number, OpenView>();
  const holders = (client: number, sessionId: string) =>
    [...views].filter(([other, view]) => other !== client && view.sessions.has(sessionId));
  server.on("upgrade", (request, socket, head) => {
    const port = (server.address() as { port: number }).port;
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const origin = request.headers.origin ?? "";
    if (
      url.pathname !== "/acp"
      || !allowedHosts(port).has(request.headers.host ?? "")
      || !allowedOrigins(port).has(origin)
      || !tokensMatch(token, url.searchParams.get("token"))
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Two processes in one session overwrite each other's history: while the TUI has it, no.
    if (options.handoff && !options.handoff.inView()) {
      socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const takesOver = url.searchParams.get("takeover") === "1";
    // A view's own id, the same across reloads of its page: a view that loads again is not another.
    const viewId = url.searchParams.get("view") ?? undefined;
    if (hosted?.alive) {
      const session = hosted;
      wss.handleUpgrade(request, socket, head, (ws) => {
        const client = nextClient++;
        log(`view ${client} attached to the host's session`);
        for (const waiter of [...attachWaiters]) waiter();
        const previous = hostedView;
        hostedView = { ws, viewId };
        const attached: HostedView = session.attach(
          (line) => { if (ws.readyState === ws.OPEN) ws.send(line); },
          () => {
            if (!previous || previous.ws.readyState !== previous.ws.OPEN) return;
            // The same view loading again is not told; another is told its session went elsewhere.
            if (previous.viewId === undefined || previous.viewId !== viewId) {
              previous.ws.send(JSON.stringify({ jsonrpc: "2.0", method: TAKEN_OVER_METHOD, params: {} }));
            }
            previous.ws.close(TAKEN_OVER_CLOSE_CODE, "the session is open in another view");
          },
        );
        ws.on("message", (data, isBinary) => { if (!isBinary) attached.fromView(data.toString()); });
        ws.on("close", (code) => {
          log(`view ${client} closed (${code})`);
          attached.detach();
          if (hostedView?.ws === ws) hostedView = undefined;
        });
        ws.on("error", (error) => log(`client error: ${error.message}`));
      });
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const client = nextClient++;
      const view: OpenView = { sessions: new SessionTracker(), viewId };
      views.set(client, view);
      const child = takeAgent();
      log(`view ${client} connected${takesOver ? " (taking over)" : ""}, agent ${child.pid}`);
      const link = bridge(ws, child, log, {
        onAgentLine: (line) => {
          diagnostics.message(client, "agent→view", line);
          view.sessions.agentLine(line);
          activity.agentLine(client, line);
          activityChanged();
          options.onAgentLine?.(line);
        },
        onClientLine: (line) => {
          diagnostics.message(client, "view→agent", line);
          const loading = view.sessions.clientLine(line);
          if (loading) {
            const others = holders(client, loading.sessionId);
            const sameView = others.length > 0 && viewId !== undefined && others.every(([, held]) => held.viewId === viewId);
            if (others.length > 0 && !takesOver && !sameView) {
              log(`view ${client} asked for session ${loading.sessionId}, open in another view`);
              return JSON.stringify({
                jsonrpc: "2.0",
                id: loading.id,
                error: { code: OPEN_ELSEWHERE_CODE, message: "The session is open in another view", data: { reason: OPEN_ELSEWHERE_REASON } },
              });
            }
            for (const [other, held] of others) {
              log(`view ${client} takes session ${loading.sessionId} over from view ${other}`);
              held.takeOver?.();
            }
            view.sessions.open(loading.sessionId);
          }
          activity.clientLine(client, line);
          activityChanged();
          options.onClientLine?.(line);
          return undefined;
        },
        onClose: (code, reason) => {
          log(`view ${client} closed (${code}${reason ? ` ${reason}` : ""})`);
          views.delete(client);
          activity.clientGone(client);
          activityChanged();
        },
      });
      view.takeOver = link.takeOver;
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? options.reuse?.port ?? 0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  mkdirSync(join(options.runtimeTempDir, "acp-session"), { recursive: true, mode: 0o700 });
  const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ url, token, processId: process.pid, agent: options.agent.id, mode: options.handoff ? "handoff" : "live" } satisfies AcpHostMetadata), { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, metadataPath);
  if (options.warmSpare) spare = startAgent();
  log(`listening on ${url}`);

  const closeClients = () => {
    const hadHosted = hosted !== undefined;
    hosted = undefined;
    hostedView = undefined;
    // Its turns end with it: the pane is not left working.
    activity.clientGone(0);
    activityChanged();
    if (hadHosted && options.warmSpare && !closed && !spare) setTimeout(() => { if (!closed && !spare) spare = startAgent(); }, 3_000);
    for (const client of wss.clients) client.close(1001, "the session went back to the terminal");
    for (const child of children) {
      if (child === spare) continue;
      child.stdin?.end();
      child.kill("SIGTERM");
    }
  };

  return {
    url,
    token,
    metadataPath,
    closeClients,
    hostedPrompt,
    viewAttached(timeoutMs) {
      if (hostedView) return Promise.resolve(true);
      return new Promise((resolveAttached) => {
        const done = (attached: boolean) => { attachWaiters.delete(onAttach); clearTimeout(timer); resolveAttached(attached); };
        const onAttach = () => done(true);
        const timer = setTimeout(() => done(false), timeoutMs);
        attachWaiters.add(onAttach);
      });
    },
    async startHostedSession(existing?: string) {
      // A process of its own, started now: a spare started beside the TUI can be stuck on the
      // agent's store the TUI held (OpenCode answers no prompt then). And no spare beside it: the
      // views attach to this one, and two of some agents starting at once fight over their store
      // (OpenCode: "database is locked").
      if (spare) {
        children.delete(spare);
        spare.stdin?.end();
        spare.kill("SIGTERM");
        spare = undefined;
      }
      const child = takeAgent(false);
      log(`the host starts a session of its own, agent ${child.pid}`);
      const session = new HostedSession(child, {
        onAgentLine: (line) => {
          diagnostics.message(0, "agent→host", line);
          activity.agentLine(0, line);
          activityChanged();
          options.onAgentLine?.(line);
        },
        onClientLine: (line) => {
          diagnostics.message(0, "host→agent", line);
          activity.clientLine(0, line);
          activityChanged();
          options.onClientLine?.(line);
        },
        log,
      });
      child.once("exit", (code, signal) => log(`agent ${child.pid} exited (${code ?? signal})`));
      hosted = session;
      return await session.start(options.cwd, existing);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (options.agentStateFile) unwatchFile(options.agentStateFile, agentStateChanged);
      if (readAcpHostMetadata(metadataPath)?.token === token) rmSync(metadataPath, { force: true });
      for (const client of wss.clients) client.close(1001, "host closing");
      for (const child of children) {
        child.stdin?.end();
        child.kill("SIGTERM");
      }
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

interface OpenView {
  sessions: SessionTracker;
  viewId?: string;
  takeOver?: () => void;
}

/** The sessions a view has open: those it loads, and those it makes once the agent names them. */
export class SessionTracker {
  private readonly opened = new Set<string>();
  private readonly creating = new Set<string>();

  /** A message from the view; returns the session it asks to load (with the request's id), if
   *  it asks for one. The session is the view's once the host lets it have it (`open`). */
  clientLine(line: string): { id: string | number; sessionId: string } | undefined {
    const message = parseJson(line);
    if (!message || (typeof message.id !== "string" && typeof message.id !== "number")) return undefined;
    if (message.method === "session/new") {
      this.creating.add(String(message.id));
      return undefined;
    }
    if (message.method !== "session/load" && message.method !== "session/resume") return undefined;
    const sessionId = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) return undefined;
    return { id: message.id, sessionId };
  }

  open(sessionId: string): void {
    this.opened.add(sessionId);
  }

  agentLine(line: string): void {
    if (this.creating.size === 0) return;
    const message = parseJson(line);
    if (!message || message.method !== undefined || message.id === undefined || message.id === null) return;
    if (!this.creating.delete(String(message.id))) return;
    const sessionId = (message.result as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sessionId === "string" && sessionId) this.opened.add(sessionId);
  }

  has(sessionId: string): boolean {
    return this.opened.has(sessionId);
  }
}

function parseJson(line: string): { id?: unknown; method?: unknown; params?: unknown; result?: unknown } | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as { id?: unknown; method?: unknown; params?: unknown; result?: unknown } : undefined;
  } catch {
    return undefined;
  }
}

/** The error a view's session/load gets when the session is open in another view. */
export const OPEN_ELSEWHERE_CODE = -32050;
export const OPEN_ELSEWHERE_REASON = "open-in-another-view";
/** The notification a view gets when another view has taken its session over. */
export const TAKEN_OVER_METHOD = "_agents/taken_over";
/** The close code of a view whose session another view took over. */
export const TAKEN_OVER_CLOSE_CODE = 4000;

/** One WebSocket client to one agent process: a text frame is one JSON-RPC message, a stdout
 *  line is one frame back. */
function bridge(
  ws: WebSocket,
  child: ChildProcess,
  log: (message: string) => void,
  taps: Pick<AcpHostOptions, "onAgentLine"> & {
    /** Sees each message from the client; a reply it returns goes back instead of the message going on. */
    onClientLine?: (line: string) => string | undefined;
    onClose?: (code: number, reason: string) => void;
  } = {},
): { takeOver: () => void } {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    child.stdin?.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 3_000);
    timer.unref();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    taps.onAgentLine?.(line);
    if (ws.readyState === ws.OPEN) ws.send(line);
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary || finished) return;
    const text = data.toString();
    const reply = taps.onClientLine?.(text);
    if (reply !== undefined) {
      if (ws.readyState === ws.OPEN) ws.send(reply);
      return;
    }
    child.stdin?.write(text.endsWith("\n") ? text : `${text}\n`);
  });
  ws.on("close", (code, reason) => { taps.onClose?.(code, reason.toString()); finish(); });
  ws.on("error", (error) => log(`client error: ${error.message}`));
  child.once("exit", (code, signal) => {
    log(`agent ${child.pid} exited (${code ?? signal})`);
    finish();
  });
  return {
    // The adapter stops at once: until it is gone it would still answer the session's questions.
    takeOver: () => {
      if (finished) return;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", method: TAKEN_OVER_METHOD, params: {} }));
      finished = true;
      child.stdin?.end();
      child.kill("SIGTERM");
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(TAKEN_OVER_CLOSE_CODE, "the session is open in another view");
    },
  };
}

/** The project's files for the view's @ menu: git's list where the folder is a repository. */
const fileLists = new Map<string, { at: number; files: Promise<string[]> }>();
function projectFiles(cwd: string): Promise<string[]> {
  const cached = fileLists.get(cwd);
  if (cached && Date.now() - cached.at < 10_000) return cached.files;
  const files = new Promise<string[]>((resolveFiles) => {
    execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 5_000 }, (error, stdout) => {
      resolveFiles(error ? [] : stdout.split("\n").filter(Boolean));
    });
  });
  fileLists.set(cwd, { at: Date.now(), files });
  return files;
}

/** Files whose name starts with the query first, then those whose path holds it. */
export function rankFiles(files: string[], query: string): string[] {
  if (!query) return files.slice(0, 50);
  const scored: Array<[number, string]> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    const score = name.startsWith(query) ? 0 : name.includes(query) ? 1 : lower.includes(query) ? 2 : -1;
    if (score >= 0) scored.push([score * 10_000 + file.length, file]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, file]) => file);
}

function authorized(request: IncomingMessage, token: string, url: URL): boolean {
  const header = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  return tokensMatch(token, header) || tokensMatch(token, url.searchParams.get("token"));
}

function readJson(request: IncomingMessage, limit = 16 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { request.destroy(); reject(new Error("too large")); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (error) { reject(error); }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}

/**
 * The view's ways into the app and the pane's tmux session (src/acp-bridge.ts): reviews opened
 * beside the pane and their comments relayed back, the session's panes and what they show.
 * Answers true when it handled the request.
 */
function handleBridge(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    token: string;
    paneId: string;
    origin: string;
    reviews: ReviewStore;
    events: Set<ServerResponse>;
    appControl: AppControlTarget;
    /** The pane's directory: chips and peeks read only inside it. */
    cwd: string;
    startFirstTurn?: (sessionId: string, text: string) => Promise<void>;
    log: (message: string) => void;
  },
): boolean {
  const url = new URL(request.url ?? "/", context.origin);
  const path = url.pathname;
  const ours = path === "/api/events" || path === "/api/panes" || path.startsWith("/api/panes/")
    || path === "/api/review" || path.startsWith("/api/review/") || path === "/api/open-review"
    || path === "/api/session/first-turn" || PEEK_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (!ours) return false;
  if (!authorized(request, context.token, url)) {
    response.writeHead(401, { "Cache-Control": "no-store" }).end();
    return true;
  }
  const fail = (status: number) => (error: unknown) =>
    sendJson(response, status, { message: error instanceof Error ? error.message : String(error) });

  if (path === "/api/session/first-turn" && request.method === "POST") {
    if (!context.startFirstTurn) { sendJson(response, 404, { message: "This agent's sessions start in the view." }); return true; }
    readJson(request).then(async (body) => {
      const { sessionId, text } = (body ?? {}) as { sessionId?: unknown; text?: unknown };
      if (typeof sessionId !== "string" || typeof text !== "string" || !text.trim()) {
        sendJson(response, 400, { message: "A session and a prompt are needed." });
        return;
      }
      context.log(`first turn of ${sessionId} from a view`);
      await context.startFirstTurn!(sessionId, text);
      sendJson(response, 200, { sessionId });
    }).catch(fail(502));
    return true;
  }
  if (path === "/api/events" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    response.write(": connected\n\n");
    context.events.add(response);
    const ping = setInterval(() => response.write(": ping\n\n"), 25_000);
    request.on("close", () => { clearInterval(ping); context.events.delete(response); });
    return true;
  }
  if (path === "/api/panes" && request.method === "GET") {
    sessionPanes(context.paneId).then((panes) => {
      // With what each pane's agent is doing, for the dot on a pane's chip.
      const states = paneStates(getStateDir(), panes.map((pane) => pane.id));
      sendJson(response, 200, { panes: panes.map((pane) => ({ ...pane, ...(states[pane.id] ? { state: states[pane.id] } : {}) })) });
    }, fail(503));
    return true;
  }
  const paneMatch = path.match(/^\/api\/panes\/([^/]+)\/text$/);
  if (paneMatch && request.method === "GET") {
    let pane = "";
    try { pane = decodeURIComponent(paneMatch[1]); } catch { /* not a pane */ }
    paneText(pane, Number(url.searchParams.get("lines") ?? 200)).then((text) => sendJson(response, 200, { text }), fail(404));
    return true;
  }
  if (path === "/api/review" && request.method === "POST") {
    readJson(request).then((payload) => sendJson(response, 200, { id: context.reviews.put(payload) }), fail(400));
    return true;
  }
  const reviewMatch = path.match(/^\/api\/review\/([A-Za-z0-9_-]+)(\/send)?$/);
  if (reviewMatch && request.method === "GET" && !reviewMatch[2]) {
    const review = context.reviews.get(reviewMatch[1]);
    if (review === undefined) sendJson(response, 404, { message: "no such review" });
    else sendJson(response, 200, review);
    return true;
  }
  if (reviewMatch && request.method === "POST" && reviewMatch[2]) {
    readJson(request).then((body) => {
      const text = String((body as { text?: unknown }).text ?? "").trim();
      if (!text) { sendJson(response, 400, { message: "nothing to send" }); return; }
      const event = `event: send\ndata: ${JSON.stringify({ review: reviewMatch[1], text })}\n\n`;
      for (const listener of context.events) listener.write(event);
      sendJson(response, context.events.size > 0 ? 200 : 409, { delivered: context.events.size });
    }, fail(400));
    return true;
  }
  if (handlePeek(request, response, url, context, fail)) return true;
  if (path === "/api/open-review" && request.method === "POST") {
    readJson(request).then((body) => {
      const id = String((body as { id?: unknown }).id ?? "");
      if (context.reviews.get(id) === undefined) { sendJson(response, 404, { message: "no such review" }); return; }
      const page = `${context.origin}/review/${id}#token=${encodeURIComponent(context.token)}`;
      return openPageBeside(context.appControl, context.paneId, page).then(
        () => sendJson(response, 200, { opened: true }),
        (error: unknown) => {
          context.log(`could not open the review beside the pane: ${error instanceof Error ? error.message : String(error)}`);
          fail(503)(error);
        },
      );
    }, fail(400));
    return true;
  }
  response.writeHead(405).end();
  return true;
}

/** What the view's chips and peeks ask the host (src/acp-peek.ts). */
const PEEK_PATHS = ["/api/resolve", "/api/peek", "/api/raw", "/api/git", "/api/commit", "/api/bead", "/api/link", "/api/open-page", "/api/output"];

const RAW_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon", ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic",
};

function handlePeek(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: { cwd: string; token: string; paneId: string; origin: string; appControl: AppControlTarget; reviews: ReviewStore; log: (message: string) => void },
  fail: (status: number) => (error: unknown) => void,
): boolean {
  const path = url.pathname;
  const cwd = context.cwd;
  const param = (name: string) => url.searchParams.get(name) ?? "";
  if (path === "/api/resolve" && request.method === "POST") {
    readJson(request, 256 * 1024).then(async (body) => {
      const names = (body as { names?: unknown })?.names;
      if (!Array.isArray(names)) { sendJson(response, 400, { message: "names are needed" }); return; }
      sendJson(response, 200, { resolved: await resolveNames(names.filter((name): name is string => typeof name === "string"), { cwd, files: () => projectFiles(cwd) }) });
    }).catch(fail(400));
    return true;
  }
  if (path === "/api/peek/file" && request.method === "GET") {
    const line = Number(param("line")) || undefined;
    const peek = peekFile(cwd, param("path"), line);
    if (peek) sendJson(response, 200, peek);
    else sendJson(response, 404, { message: "no such text file in the pane's directory" });
    return true;
  }
  if (path === "/api/raw" && request.method === "GET") {
    const file = inside(cwd, param("path"));
    const type = file ? RAW_TYPES[extname(file).toLowerCase()] : undefined;
    const stat = file ? statSync(file, { throwIfNoEntry: false }) : undefined;
    if (!file || !type || !IMAGE_EXTENSIONS.has(extname(file).toLowerCase()) || !stat?.isFile() || stat.size > 32 * 1024 * 1024) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return true;
    }
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
    response.end(readFileSync(file));
    return true;
  }
  if (path === "/api/git/summary" && request.method === "GET") {
    gitCommandSummary(cwd, param("command")).then((summary) => sendJson(response, 200, { summary }), () => sendJson(response, 200, { summary: null }));
    return true;
  }
  // A command's output, opened as a page of its own beside the pane.
  if (path === "/api/output" && request.method === "POST") {
    readJson(request, 8 * 1024 * 1024).then(async (body) => {
      const { title, text } = (body ?? {}) as { title?: unknown; text?: unknown };
      if (typeof text !== "string") { sendJson(response, 400, { message: "text is needed" }); return; }
      const id = context.reviews.put({ kind: "output", title: typeof title === "string" ? title : "Output", text });
      await openPageBeside(context.appControl, context.paneId, `${context.origin}/output/${id}#token=${encodeURIComponent(context.token)}`);
      sendJson(response, 200, { id });
    }).catch(fail(503));
    return true;
  }
  const output = path.match(/^\/api\/output\/([A-Za-z0-9_-]+)$/);
  if (output && request.method === "GET") {
    const stored = context.reviews.get(output[1]) as { kind?: string } | undefined;
    sendJson(response, stored?.kind === "output" ? 200 : 404, stored?.kind === "output" ? stored : { message: "gone" });
    return true;
  }
  if (path === "/api/git/snapshot" && request.method === "POST") {
    snapshotTree(cwd).then((tree) => sendJson(response, 200, { tree }), fail(500));
    return true;
  }
  if (path === "/api/git/changes" && request.method === "GET") {
    changesSince(cwd, param("tree")).then((changes) => sendJson(response, changes ? 200 : 404, changes ?? { message: "no snapshot to compare with" }), fail(500));
    return true;
  }
  if (path === "/api/git/diff" && request.method === "GET") {
    treeDiff(cwd, param("from"), param("to"), param("path")).then((diff) => sendJson(response, 200, { diff }), fail(500));
    return true;
  }
  if (path === "/api/git/versions" && request.method === "GET") {
    versionsBetween(cwd, param("from"), param("to"), param("path")).then((versions) => sendJson(response, versions ? 200 : 404, versions ?? {}), fail(500));
    return true;
  }
  const commit = path.match(/^\/api\/commit\/([0-9a-f]{7,40})(\/changes)?$/);
  if (commit && request.method === "GET") {
    (commit[2] ? commitChanges(cwd, commit[1]).then((changes) => ({ changes })) : commitInfo(cwd, commit[1]))
      .then((value) => sendJson(response, value ? 200 : 404, value ?? { message: "no such commit" }), fail(404));
    return true;
  }
  const bead = path.match(/^\/api\/bead\/([A-Za-z0-9._-]+)$/);
  if (bead && request.method === "GET") {
    const found = readBeads(cwd).get(bead[1]);
    sendJson(response, found ? 200 : 404, found ?? { message: "no such bead" });
    return true;
  }
  if (path === "/api/link" && request.method === "GET") {
    linkInfo(param("url")).then((info) => sendJson(response, 200, info), fail(500));
    return true;
  }
  if (path === "/api/open-page" && request.method === "POST") {
    readJson(request).then(async (body) => {
      const target = String((body as { url?: unknown })?.url ?? "");
      // A web page, or one of the host's own pages for the pane (a bead), with the pane's token.
      const own = target.startsWith("/bead/") ? `${context.origin}${target}#token=${encodeURIComponent(context.token)}` : null;
      if (!own && !/^https?:\/\//i.test(target)) { sendJson(response, 400, { message: "a web address is needed" }); return; }
      await openPageBeside(context.appControl, context.paneId, own ?? target);
      sendJson(response, 200, { opened: true });
    }).catch((error: unknown) => {
      context.log(`could not open a page beside the pane: ${error instanceof Error ? error.message : String(error)}`);
      fail(503)(error);
    });
    return true;
  }
  return false;
}

function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  handoff: AcpHandoffControl | undefined,
): void {
  const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!tokensMatch(token, auth)) {
    response.writeHead(401, { "Cache-Control": "no-store" }).end();
    return;
  }
  if (!handoff) {
    response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "This agent shares its session live; there is nothing to hand over." }));
    return;
  }
  let body = "";
  request.on("data", (chunk: Buffer) => { body += chunk.toString(); if (body.length > 4096) request.destroy(); });
  request.on("end", async () => {
    try {
      if (request.url === "/api/return") {
        await handoff.giveBack();
        response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      const sessionId = String((JSON.parse(body || "{}") as { session?: unknown }).session ?? "").trim();
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) {
        response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "A session id is needed." }));
        return;
      }
      const result = await handoff.handOff(sessionId);
      response.writeHead(result.status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ message: result.message ?? "", session: result.session ?? null }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    }
  });
}

function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    webRoot: string;
    token: string;
    cwd: string;
    agent: { id: string; name: string };
    state: () => unknown;
    diagnostics: () => unknown;
    currentSession?: () => Promise<{ id: string | null; persisted: boolean; busy?: boolean } | undefined>;
  },
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("ok");
    return;
  }
  if (url.pathname === "/api/state" || url.pathname === "/api/files" || url.pathname === "/api/diagnostics" || url.pathname === "/api/session") {
    const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!tokensMatch(context.token, auth)) {
      response.writeHead(401, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (url.pathname === "/api/state") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(context.state()));
      return;
    }
    if (url.pathname === "/api/session") {
      const send = (status: number, body: unknown) =>
        response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
      if (!context.currentSession) {
        send(404, { message: "This agent's session is known only once it reports one." });
        return;
      }
      context.currentSession().then(
        (current) => current ? send(200, { sessionId: current.id, persisted: current.persisted, busy: current.busy ?? false }) : send(404, { message: "The agent has no session open yet." }),
        (error: unknown) => send(503, { message: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    if (url.pathname === "/api/diagnostics") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ ...(context.diagnostics() as object), state: context.state() }));
      return;
    }
    void projectFiles(context.cwd).then((files) => {
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ files: rankFiles(files, query).slice(0, 20) }));
    });
    return;
  }
  if (url.pathname === "/api/info") {
    const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!tokensMatch(context.token, auth)) {
      response.writeHead(401, { "Cache-Control": "no-store" }).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ cwd: context.cwd, agent: context.agent }));
    return;
  }

  // Hashed build assets never change under their name; everything else is the app shell.
  const isAsset = url.pathname.startsWith("/assets/");
  const relative = isAsset ? url.pathname : "/index.html";
  const filePath = normalize(join(context.webRoot, decodeURIComponent(relative)));
  if (!filePath.startsWith(context.webRoot + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Cache-Control": "no-store" }).end("not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(isAsset ? {} : {
      // Thumbnails come from Agents Next (QLThumbnailGenerator) through its own scheme.
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: agents-next-thumbnail:; frame-ancestors 'none'",
    }),
  });
  response.end(request.method === "HEAD" ? undefined : readFileSync(filePath));
}
