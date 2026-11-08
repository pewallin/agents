// The ACP view's review of changes, for changes no agent made: Agents Next's Changes panel opens a
// file's diff against main, an uncommitted file or a commit with
//   agents review --cwd <repo> (--base <rev> [--path <file>]... | --commit <sha>) [--focus <file>] [--label <text>] --json
// which prints the review page's address. The page is the one an agent's view opens beside its
// pane (web/acp-view, ReviewPage), served by one small loopback server per user that a first call
// starts in the background and that stops after half an hour without a request.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { getSelfArgv, getStateDir } from "./paths.js";

export interface ReviewChange {
  path: string;
  added: number;
  removed: number;
  edits: Array<{ oldText: string | null; newText: string }>;
}

export interface ReviewPayload {
  changes: ReviewChange[];
  cwd: string;
  /** What the review is of ("Against main", "Uncommitted", a commit): the page's subtitle. */
  agentName: string;
  /** The file the page opens at. */
  focus?: string;
  /** No agent to send comments to. */
  readOnly: true;
}

interface ServerMetadata { port: number; token: string; pid: number }

const IDLE_MS = 30 * 60 * 1000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function metadataPath(): string {
  return join(getStateDir(), "review-server.json");
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** A file's text at a revision, or null when it is not there (or is too big or binary). */
function textAt(cwd: string, revision: string, path: string): string | null {
  const text = git(cwd, ["show", `${revision}:${path}`]);
  return text === null || text.length > MAX_FILE_BYTES || text.includes("\u0000") ? null : text;
}

/** A file's text in the working tree, or null when it is gone. */
function workingText(cwd: string, path: string): string | null {
  const file = join(cwd, path);
  try {
    if (!statSync(file).isFile() || statSync(file).size > MAX_FILE_BYTES) return null;
    const text = readFileSync(file, "utf8");
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** git's counts, per path: "added\tremoved\tpath" lines. */
function numstat(output: string | null): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of (output ?? "").split("\n")) {
    const [added, removed, path] = line.split("\t");
    if (!path) continue;
    counts.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  return counts;
}

function lineCount(text: string | null): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** The changes against a revision (the working tree's files), or those a commit made. */
export function collectChanges(options: { cwd: string; base?: string; commit?: string; paths?: string[] }): ReviewChange[] {
  const { cwd } = options;
  if (options.commit) {
    const commit = options.commit;
    const parent = git(cwd, ["rev-parse", "--verify", "-q", `${commit}^`])?.trim() || null;
    const counts = numstat(git(cwd, ["show", "--no-renames", "--numstat", "--format=", commit]));
    return [...counts.entries()].map(([path, count]) => ({
      path,
      ...count,
      edits: [{ oldText: parent ? textAt(cwd, parent, path) : null, newText: textAt(cwd, commit, path) ?? "" }],
    }));
  }
  const base = options.base ?? "HEAD";
  const counts = numstat(git(cwd, ["diff", "--no-renames", "--numstat", base]));
  const untracked = (git(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").filter(Boolean);
  for (const path of untracked) {
    if (!counts.has(path)) counts.set(path, { added: lineCount(workingText(cwd, path)), removed: 0 });
  }
  const wanted = options.paths && options.paths.length > 0 ? options.paths : [...counts.keys()];
  return wanted.map((path) => ({
    path,
    added: counts.get(path)?.added ?? 0,
    removed: counts.get(path)?.removed ?? 0,
    edits: [{ oldText: textAt(cwd, base, path), newText: workingText(cwd, path) ?? "" }],
  }));
}

function readMetadata(): ServerMetadata | undefined {
  try {
    return JSON.parse(readFileSync(metadataPath(), "utf8")) as ServerMetadata;
  } catch {
    return undefined;
  }
}

async function healthy(metadata: ServerMetadata): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${metadata.port}/healthz`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The running server, or one started in the background. */
async function ensureServer(): Promise<ServerMetadata> {
  const current = readMetadata();
  if (current && await healthy(current)) return current;
  const [command, ...argv] = getSelfArgv();
  if (!command) throw new Error("cannot start the review server: no path to this CLI");
  const child = spawn(command, [...argv, "review-server"], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    const started = readMetadata();
    if (started && started.pid === child.pid && await healthy(started)) return started;
  }
  throw new Error("the review server did not start");
}

/** Puts the review on the server and answers its page's address. */
export async function openReview(payload: ReviewPayload): Promise<string> {
  const server = await ensureServer();
  const response = await fetch(`http://127.0.0.1:${server.port}/api/review`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`the review server answered ${response.status}`);
  const { id } = await response.json() as { id: string };
  // `agents-next=acp-page` gives the page the view's look in Agents Next (ACPViewLook.isHostPage).
  return `http://127.0.0.1:${server.port}/review/${id}?agents-next=acp-page#token=${encodeURIComponent(server.token)}`;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: string[], name: string): string[] {
  return args.flatMap((arg, index) => (arg === name && args[index + 1] !== undefined ? [args[index + 1]] : []));
}

/** `agents review`: prints the page's address (as JSON with --json). */
export async function runReviewCommand(args: string[]): Promise<number> {
  const cwd = resolve(option(args, "--cwd") ?? process.cwd());
  const commit = option(args, "--commit");
  const base = option(args, "--base");
  const paths = options(args, "--path");
  const focus = option(args, "--focus") ?? paths[0];
  const label = option(args, "--label") ?? (commit ? `commit ${commit.slice(0, 7)}` : base ? `against ${base}` : "uncommitted");
  try {
    const changes = collectChanges({ cwd, base, commit, paths });
    if (changes.length === 0) throw new Error("no changes to review");
    const url = await openReview({ changes, cwd, agentName: label, focus, readOnly: true });
    console.log(args.includes("--json") ? JSON.stringify({ ok: true, url }) : url);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(args.includes("--json") ? JSON.stringify({ ok: false, message }) : message);
    return 1;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function tokensMatch(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}

function readBody(request: IncomingMessage, limit = 64 * 1024 * 1024): Promise<unknown> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { request.destroy(); fail(new Error("too large")); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { done(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (error) { fail(error); }
    });
    request.on("error", fail);
  });
}

/** `agents review-server`: serves the reviews and the view's page until it has been idle a while. */
export async function runReviewServer(webRoot: string): Promise<void> {
  const root = resolve(webRoot);
  const token = randomBytes(24).toString("base64url");
  const reviews = new Map<string, ReviewPayload>();
  let idleTimer: NodeJS.Timeout | undefined;
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => process.exit(0), IDLE_MS);
  };
  const server = createServer((request, response) => {
    touch();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("ok");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!tokensMatch(token, auth)) { response.writeHead(401).end(); return; }
      if (url.pathname === "/api/review" && request.method === "POST") {
        readBody(request).then((payload) => {
          const id = randomBytes(9).toString("base64url");
          reviews.set(id, payload as ReviewPayload);
          // The latest few are enough: a review is opened once, right after it is made.
          while (reviews.size > 50) reviews.delete(reviews.keys().next().value as string);
          sendJson(response, 200, { id });
        }, () => sendJson(response, 400, { message: "not a review" }));
        return;
      }
      const match = url.pathname.match(/^\/api\/review\/([A-Za-z0-9_-]+)$/);
      if (match && request.method === "GET") {
        const review = reviews.get(match[1]);
        if (review) sendJson(response, 200, review); else sendJson(response, 404, { message: "no such review" });
        return;
      }
      sendJson(response, 404, { message: "not here" });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
    const isAsset = url.pathname.startsWith("/assets/");
    const filePath = normalize(join(root, isAsset ? decodeURIComponent(url.pathname) : "/index.html"));
    if (!filePath.startsWith(root + sep) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(isAsset ? {} : { "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" }),
    });
    if (request.method === "HEAD") { response.end(); return; }
    response.end(readFileSync(filePath));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  mkdirSync(dirname(metadataPath()), { recursive: true });
  writeFileSync(metadataPath(), JSON.stringify({ port: address.port, token, pid: process.pid } satisfies ServerMetadata), { mode: 0o600 });
  touch();
}
