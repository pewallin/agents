// The ACP host of a Codex pane: a loopback web server, started warm by `agents codex-session`
// beside the pane's app-server, that serves the prebuilt ACP web view and gives each WebSocket
// client its own codex-acp process. codex-acp runs on the pane's app-server through this CLI's
// app-server proxy (CODEX_PATH is this CLI, AGENTS_CODEX_APP_SERVER_URL the pane's server), so
// the web view and the TUI share the pane's Codex thread live.
//
// Only this machine reaches it (127.0.0.1), and only a page with the pane's token can open the
// agent: the WebSocket needs the token, an Origin of this server and a Host of this server. The
// token is in the pane's metadata file (0600), which is how the app finds the host's address.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { WebSocketServer, type WebSocket } from "ws";

export interface AcpHostMetadata {
  url: string;
  token: string;
  processId: number;
}

export interface AcpHostOptions {
  paneId: string;
  appServerUrl: string;
  runtimeTempDir: string;
  /** Directory with the built web view (index.html, assets/). */
  webRoot: string;
  /** The working directory sessions are loaded with: the pane's. */
  cwd: string;
  /** How to start the ACP agent for one client. */
  agentCommand: { command: string; args: string[]; env: NodeJS.ProcessEnv };
  /** Keep one agent process started ahead of the next client. */
  warmSpare?: boolean;
  port?: number;
  log?: (message: string) => void;
}

export interface AcpHost {
  readonly url: string;
  readonly token: string;
  readonly metadataPath: string;
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
  return join(runtimeTempDir, "acp-host", `${normalized || "pane-unknown"}.json`);
}

export function readAcpHostMetadata(path: string): AcpHostMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AcpHostMetadata>;
    if (typeof value.url === "string" && typeof value.token === "string" && typeof value.processId === "number") {
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
    handleHttp(request, response, { webRoot, token, cwd: options.cwd });
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
    wss.handleUpgrade(request, socket, head, (ws) => bridge(ws, takeAgent(), log));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolveListen());
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;

  mkdirSync(join(options.runtimeTempDir, "acp-host"), { recursive: true, mode: 0o700 });
  const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ url, token, processId: process.pid } satisfies AcpHostMetadata), { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, metadataPath);
  if (options.warmSpare) spare = startAgent();
  log(`listening on ${url}`);

  return {
    url,
    token,
    metadataPath,
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
function bridge(ws: WebSocket, child: ChildProcess, log: (message: string) => void): void {
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
    if (line.trim() && ws.readyState === ws.OPEN) ws.send(line);
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary || finished) return;
    const text = data.toString();
    child.stdin?.write(text.endsWith("\n") ? text : `${text}\n`);
  });
  ws.on("close", finish);
  ws.on("error", (error) => log(`client error: ${error.message}`));
  child.once("exit", (code, signal) => {
    log(`agent ${child.pid} exited (${code ?? signal})`);
    finish();
  });
}

function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  context: { webRoot: string; token: string; cwd: string },
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
  if (url.pathname === "/api/info") {
    const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!tokensMatch(context.token, auth)) {
      response.writeHead(401, { "Cache-Control": "no-store" }).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ cwd: context.cwd }));
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
