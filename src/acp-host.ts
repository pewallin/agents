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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { WebSocketServer, type WebSocket } from "ws";
import { appControlTarget, openPageBeside, paneText, ReviewStore, sessionPanes, type AppControlTarget } from "./acp-bridge.js";

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
  log?: (message: string) => void;
}

export interface AcpHandoffControl {
  /** Whether the view has the session now; before that no client may open the agent. */
  inView(): boolean;
  /** Takes the session over from the TUI: answers 409 with a reason while the agent works. */
  handOff(sessionId: string): Promise<{ status: number; message?: string }>;
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

export async function startAcpHost(options: AcpHostOptions): Promise<AcpHost> {
  const log = options.log ?? (() => {});
  const token = randomBytes(32).toString("base64url");
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
  let nextClient = 1;
  let spare: ChildProcess | undefined;
  let closed = false;

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
  const takeAgent = (): ChildProcess => {
    const ready = spare && spare.exitCode === null && spare.signalCode === null ? spare : undefined;
    spare = undefined;
    const child = ready ?? startAgent();
    if (options.warmSpare && !closed) setImmediate(() => { if (!closed && !spare) spare = startAgent(); });
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
    if (handleBridge(request, response, {
      token,
      paneId: options.paneId,
      origin: `http://127.0.0.1:${port}`,
      reviews,
      events,
      appControl: options.appControl ?? appControlTarget(),
      log,
    })) return;
    handleHttp(request, response, {
      webRoot,
      token,
      cwd: options.cwd,
      agent: options.agent,
      state: () => ({ state: activity.state, mode: options.handoff ? "handoff" : "live", inView: options.handoff?.inView() ?? true, clients: wss.clients.size }),
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
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
    wss.handleUpgrade(request, socket, head, (ws) => {
      const client = nextClient++;
      bridge(ws, takeAgent(), log, {
        onAgentLine: (line) => { activity.agentLine(client, line); activityChanged(); options.onAgentLine?.(line); },
        onClientLine: (line) => { activity.clientLine(client, line); activityChanged(); options.onClientLine?.(line); },
        onClose: () => { activity.clientGone(client); activityChanged(); },
      });
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolveListen());
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
    async close() {
      if (closed) return;
      closed = true;
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

/** One WebSocket client to one agent process: a text frame is one JSON-RPC message, a stdout
 *  line is one frame back. */
function bridge(
  ws: WebSocket,
  child: ChildProcess,
  log: (message: string) => void,
  taps: Pick<AcpHostOptions, "onAgentLine" | "onClientLine"> & { onClose?: () => void } = {},
): void {
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
    taps.onClientLine?.(text);
    child.stdin?.write(text.endsWith("\n") ? text : `${text}\n`);
  });
  ws.on("close", () => { taps.onClose?.(); finish(); });
  ws.on("error", (error) => log(`client error: ${error.message}`));
  child.once("exit", (code, signal) => {
    log(`agent ${child.pid} exited (${code ?? signal})`);
    finish();
  });
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
    log: (message: string) => void;
  },
): boolean {
  const url = new URL(request.url ?? "/", context.origin);
  const path = url.pathname;
  const ours = path === "/api/events" || path === "/api/panes" || path.startsWith("/api/panes/")
    || path === "/api/review" || path.startsWith("/api/review/") || path === "/api/open-review";
  if (!ours) return false;
  if (!authorized(request, context.token, url)) {
    response.writeHead(401, { "Cache-Control": "no-store" }).end();
    return true;
  }
  const fail = (status: number) => (error: unknown) =>
    sendJson(response, status, { message: error instanceof Error ? error.message : String(error) });

  if (path === "/api/events" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    response.write(": connected\n\n");
    context.events.add(response);
    const ping = setInterval(() => response.write(": ping\n\n"), 25_000);
    request.on("close", () => { clearInterval(ping); context.events.delete(response); });
    return true;
  }
  if (path === "/api/panes" && request.method === "GET") {
    sessionPanes(context.paneId).then((panes) => sendJson(response, 200, { panes }), fail(503));
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
        .end(JSON.stringify({ message: result.message ?? "" }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    }
  });
}

function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  context: { webRoot: string; token: string; cwd: string; agent: { id: string; name: string }; state: () => unknown },
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
  if (url.pathname === "/api/state" || url.pathname === "/api/files") {
    const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!tokensMatch(context.token, auth)) {
      response.writeHead(401, { "Cache-Control": "no-store" }).end();
      return;
    }
    if (url.pathname === "/api/state") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(context.state()));
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
      "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    }),
  });
  response.end(request.method === "HEAD" ? undefined : readFileSync(filePath));
}
