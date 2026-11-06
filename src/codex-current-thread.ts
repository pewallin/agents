// The thread a Codex pane's TUI has open, from the pane's own app-server: known as soon as the TUI
// starts, before its first prompt and before its hooks report a session.
//
// Codex writes a thread to disk with its first turn. Until then codex-acp can load it but hears
// none of its turns, so the view's first prompt starts the turn on the app-server itself. Nor does
// codex-acp follow a turn already running when it loads the thread: the view loads it once the
// first turn is done, and follows every turn after it live.
import { existsSync } from "node:fs";
import WebSocket from "ws";

interface AppServer {
  request(method: string, params: unknown): Promise<unknown>;
}

interface ThreadInfo {
  id?: string;
  updatedAt?: number;
  parentThreadId?: string | null;
  ephemeral?: boolean;
  path?: string | null;
  status?: { type?: string };
}

/** Runs `use` on a connection to the pane's app-server, initialized, and closes it. */
async function withAppServer<T>(appServerUrl: string, use: (server: AppServer) => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const ws = new WebSocket(appServerUrl);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  const server: AppServer = {
    request: (method, params) => new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    }),
  };
  ws.on("message", (raw) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (typeof message.id !== "number") return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message ?? "app-server error"));
    else waiting.resolve(message.result);
  });
  const timer = setTimeout(() => {
    for (const waiting of pending.values()) waiting.reject(new Error("the pane's app-server did not answer"));
    ws.terminate();
  }, timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
    await server.request("initialize", { clientInfo: { name: "agents-acp-host", version: "1" } });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    return await use(server);
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

/** Codex names the thread's file from the start, but writes it with the first turn. */
function onDisk(thread: ThreadInfo | undefined): boolean {
  return Boolean(thread?.path && existsSync(thread.path));
}

async function readThread(server: AppServer, threadId: string): Promise<ThreadInfo | undefined> {
  const read = await server.request("thread/read", { threadId }).catch(() => undefined) as { thread?: ThreadInfo } | undefined;
  return read?.thread;
}

/** The pane's current thread: of its loaded conversations, the one updated last, and whether
 *  Codex has written it to disk yet. */
export async function codexCurrentThread(appServerUrl: string): Promise<{ id: string; persisted: boolean; busy: boolean } | undefined> {
  return await withAppServer(appServerUrl, async (server) => {
    const loaded = await server.request("thread/loaded/list", {}) as { data?: string[] };
    let latest: { id: string; at: number; persisted: boolean; busy: boolean } | undefined;
    for (const id of loaded.data ?? []) {
      const thread = await readThread(server, id);
      // A subagent's thread is its parent's work, and an ephemeral one (Codex makes them for its
      // own small jobs, such as a title) is no one's conversation.
      if (!thread || thread.parentThreadId || thread.ephemeral) continue;
      const at = thread.updatedAt ?? 0;
      if (!latest || at > latest.at) latest = { id, at, persisted: onDisk(thread), busy: thread.status?.type === "active" };
    }
    return latest && { id: latest.id, persisted: latest.persisted, busy: latest.busy };
  });
}

/** Starts a turn with `text` on the thread, and waits until Codex has written the thread to disk. */
export async function codexStartFirstTurn(appServerUrl: string, threadId: string, text: string, timeoutMs = 15_000): Promise<void> {
  await withAppServer(appServerUrl, async (server) => {
    await server.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (onDisk(await readThread(server, threadId))) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("Codex did not write the thread to disk");
  }, timeoutMs + 5_000);
}

/** Resumes a thread on the pane's app-server with permissions (`agents codex-thread-settings`):
 *  a TUI that resumes it over --remote then finds them on it (Codex refuses them from such a TUI). */
export async function codexResumeWithPermissions(
  appServerUrl: string,
  threadId: string,
  settings: { approvalPolicy?: string; sandbox?: string },
): Promise<void> {
  await withAppServer(appServerUrl, async (server) => {
    await server.request("thread/resume", {
      threadId,
      excludeTurns: true,
      ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}),
      ...(settings.sandbox ? { sandbox: settings.sandbox } : {}),
    });
  }, 15_000);
}
