import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpActivity, OPEN_ELSEWHERE_CODE, OPEN_ELSEWHERE_REASON, SessionTracker, TAKEN_OVER_CLOSE_CODE, TAKEN_OVER_METHOD, rankFiles, readAcpHostMetadata, startAcpHost, type AcpHost } from "./acp-host.js";

// A stand-in agent: answers each JSON-RPC line with an echo of its method.
const ECHO_AGENT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.method, pid: process.pid } }) + "\\n");
});
`;

describe("acp-host", () => {
  let dir: string;
  let host: AcpHost | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acp-host-test-"));
    const web = join(dir, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>acp</title>");
    writeFileSync(join(web, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(dir, "secret.txt"), "secret");
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(warmSpare = false) {
    host = await startAcpHost({
      paneId: "%42",
      agent: { id: "test-acp", name: "Test" },
      runtimeTempDir: join(dir, "rt"),
      webRoot: join(dir, "web"),
      cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", ECHO_AGENT], env: process.env },
      warmSpare,
    });
    return host;
  }

  function connect(h: AcpHost, options: { token?: string; origin?: string } = {}) {
    const token = options.token ?? h.token;
    return new WebSocket(`${h.url.replace("http", "ws")}/acp?token=${encodeURIComponent(token)}`, {
      headers: { Origin: options.origin ?? h.url },
    });
  }

  it("writes the pane's metadata where the app looks, readable by the user alone", async () => {
    const h = await start();
    expect(h.metadataPath).toBe(join(dir, "rt", "acp-session", "pane-42.json"));
    expect(readAcpHostMetadata(h.metadataPath)).toEqual({ url: h.url, token: h.token, processId: process.pid, agent: "test-acp", mode: "live" });
    expect(statSync(h.metadataPath).mode & 0o777).toBe(0o600);
    expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await h.close();
    expect(existsSync(h.metadataPath)).toBe(false);
  });

  it("serves the app shell for thread addresses and hashed assets as immutable", async () => {
    const h = await start();
    const shell = await fetch(`${h.url}/thread/abc`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("no-cache");
    expect(await shell.text()).toContain("<title>acp</title>");

    const asset = await fetch(`${h.url}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    expect((await fetch(`${h.url}/assets/..%2f..%2fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${h.url}/assets/missing.js`)).status).toBe(404);
  });

  it("refuses another host name, which a rebound DNS name would send", async () => {
    const h = await start();
    const port = new URL(h.url).port;
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port, path: "/", headers: { Host: `evil.example:${port}` } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
  });

  it("tells the pane's working directory only to a holder of the token", async () => {
    const h = await start();
    expect((await fetch(`${h.url}/api/info`)).status).toBe(401);
    expect((await fetch(`${h.url}/api/info`, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    const info = await fetch(`${h.url}/api/info`, { headers: { Authorization: `Bearer ${h.token}` } });
    expect(await info.json()).toEqual({ cwd: dir, agent: { id: "test-acp", name: "Test" } });
  });

  it("refuses a WebSocket without the token or from another origin", async () => {
    const h = await start();
    for (const options of [{ token: "wrong" }, { origin: "http://evil.example" }]) {
      const ws = connect(h, options);
      const outcome = await new Promise<string>((resolve) => {
        ws.on("open", () => resolve("open"));
        ws.on("error", () => resolve("refused"));
      });
      expect(outcome).toBe("refused");
    }
  });

  it("lets no client open a hand-off agent until the view has the session", async () => {
    let inView = false;
    const handed: string[] = [];
    host = await startAcpHost({
      paneId: "%43",
      agent: { id: "test-acp", name: "Test" },
      runtimeTempDir: join(dir, "rt"),
      webRoot: join(dir, "web"),
      cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", ECHO_AGENT], env: process.env },
      handoff: {
        inView: () => inView,
        handOff: async (id) => { handed.push(id); inView = true; return { status: 200 }; },
        giveBack: async () => { inView = false; },
      },
    });
    const h = host;
    expect(readAcpHostMetadata(h.metadataPath)?.mode).toBe("handoff");
    const refused = await new Promise<string>((resolve) => {
      const ws = connect(h);
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("refused"));
    });
    expect(refused).toBe("refused");
    const post = (path: string, body: object, token = h.token) => fetch(`${h.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await post("/api/handoff", { session: "s1" }, "wrong")).status).toBe(401);
    expect((await post("/api/handoff", { session: "bad id!" })).status).toBe(400);
    expect((await post("/api/handoff", { session: "s1" })).status).toBe(200);
    expect(handed).toEqual(["s1"]);
    const opened = await new Promise<string>((resolve) => {
      const ws = connect(h);
      ws.on("open", () => { resolve("open"); ws.close(); });
      ws.on("error", () => resolve("refused"));
    });
    expect(opened).toBe("open");
    expect((await post("/api/return", {})).status).toBe(200);
    expect(inView).toBe(false);
  });

  it("bridges each client to its own agent process, one message per frame", async () => {
    const h = await start(true);
    const ask = (ws: WebSocket, id: number, method: string) => new Promise<{ result: { echo: string; pid: number } }>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
    });
    const first = connect(h);
    const second = connect(h);
    await Promise.all([first, second].map((ws) => new Promise((resolve) => ws.once("open", resolve))));
    const a = await ask(first, 1, "initialize");
    const b = await ask(second, 1, "session/load");
    expect(a.result.echo).toBe("initialize");
    expect(b.result.echo).toBe("session/load");
    expect(a.result.pid).not.toBe(b.result.pid);
    first.close();
    second.close();
  });
  it("tells a second view the session is open elsewhere, and gives it over only when asked", async () => {
    const h = await start();
    const ask = (ws: WebSocket, id: number, method: string, params: unknown) => new Promise<{ result?: { echo: string; pid: number }; error?: { code: number; data?: { reason?: string } } }>((resolve) => {
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString());
        if (message.id !== id) return;
        ws.off("message", onMessage);
        resolve(message);
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
    const opened = (ws: WebSocket) => new Promise((resolve) => ws.once("open", resolve));
    const older = connect(h);
    const other = connect(h);
    await Promise.all([older, other].map(opened));
    const olderAgent = (await ask(older, 1, "session/load", { sessionId: "s1" })).result!.pid;
    await ask(other, 1, "session/load", { sessionId: "s2" });

    // A second view of s1 is refused, and the first keeps it.
    const second = connect(h);
    await opened(second);
    const refused = await ask(second, 1, "session/load", { sessionId: "s1" });
    expect(refused.error?.code).toBe(OPEN_ELSEWHERE_CODE);
    expect(refused.error?.data?.reason).toBe(OPEN_ELSEWHERE_REASON);
    expect(older.readyState).toBe(WebSocket.OPEN);
    second.close();

    // Asked to take it over, a view gets it: the first is told and its agent ends.
    const told = new Promise<string>((resolve) => older.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.method) resolve(message.method);
    }));
    const closed = new Promise<number>((resolve) => older.once("close", (code) => resolve(code)));
    const taking = new WebSocket(`${h.url.replace("http", "ws")}/acp?token=${encodeURIComponent(h.token)}&takeover=1`, { headers: { Origin: h.url } });
    await opened(taking);
    expect((await ask(taking, 1, "session/load", { sessionId: "s1" })).result?.echo).toBe("session/load");
    expect(await told).toBe(TAKEN_OVER_METHOD);
    expect(await closed).toBe(TAKEN_OVER_CLOSE_CODE);
    await expect.poll(() => { try { process.kill(olderAgent, 0); return true; } catch { return false; } }).toBe(false);
    // A view of another session stays.
    expect(other.readyState).toBe(WebSocket.OPEN);
    taking.close();
    other.close();
  });

  it("gives the session back at once to the same view loading again, as a page reload does", async () => {
    const h = await start();
    const viewUrl = (view: string) => `${h.url.replace("http", "ws")}/acp?token=${encodeURIComponent(h.token)}&view=${view}`;
    const ask = (ws: WebSocket, method: string, params: unknown) => new Promise<{ result?: unknown; error?: { code: number } }>((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
    const opened = (ws: WebSocket) => new Promise((resolve) => ws.once("open", resolve));
    const before = new WebSocket(viewUrl("app-view"), { headers: { Origin: h.url } });
    await opened(before);
    await ask(before, "session/load", { sessionId: "s1" });
    // The reloaded page connects before its old connection is gone.
    const closed = new Promise<number>((resolve) => before.once("close", resolve));
    const after = new WebSocket(viewUrl("app-view"), { headers: { Origin: h.url } });
    await opened(after);
    expect((await ask(after, "session/load", { sessionId: "s1" })).error).toBeUndefined();
    expect(await closed).toBe(TAKEN_OVER_CLOSE_CODE);
    // Another view is still told the session is open elsewhere.
    const other = new WebSocket(viewUrl("other-view"), { headers: { Origin: h.url } });
    await opened(other);
    expect((await ask(other, "session/load", { sessionId: "s1" })).error?.code).toBe(OPEN_ELSEWHERE_CODE);
    after.close();
    other.close();
  });

  it("tells a holder of the token its log and the last ACP messages, for the view's diagnostics", async () => {
    const h = await start();
    const ws = connect(h);
    await new Promise((resolve) => ws.once("open", resolve));
    await new Promise((resolve) => {
      ws.once("message", resolve);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    });
    expect((await fetch(`${h.url}/api/diagnostics`)).status).toBe(401);
    const report = await (await fetch(`${h.url}/api/diagnostics`, { headers: { Authorization: `Bearer ${h.token}` } })).json() as {
      agent: { id: string }; mode: string; agentsCLI: string; log: string[]; messages: string[]; state: { clients: number };
    };
    expect(report.agent.id).toBe("test-acp");
    expect(report.mode).toBe("live");
    expect(report.agentsCLI).toBeTruthy();
    expect(report.log.some((line) => line.includes("view 1 connected"))).toBe(true);
    expect(report.messages.some((line) => line.includes("view→agent") && line.includes("initialize"))).toBe(true);
    expect(report.messages.some((line) => line.includes("agent→view") && line.includes("\"echo\":\"initialize\""))).toBe(true);
    expect(report.state.clients).toBe(1);
    ws.close();
  });

  it("knows a view's sessions: those it is given and those it makes", () => {
    const sessions = new SessionTracker();
    expect(sessions.clientLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "a" } }))).toEqual({ id: 1, sessionId: "a" });
    expect(sessions.has("a")).toBe(false);
    sessions.open("a");
    expect(sessions.clientLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/" } }))).toBeUndefined();
    expect(sessions.has("b")).toBe(false);
    sessions.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { sessionId: "b" } }));
    expect(sessions.has("a")).toBe(true);
    expect(sessions.has("b")).toBe(true);
    expect(sessions.clientLine(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "a" } }))).toBeUndefined();
  });

  it("tells the pane's state from the traffic: a prompt in flight works, a permission waiting needs you", () => {
    const activity = new AcpActivity();
    expect(activity.state).toBe("idle");
    activity.clientLine(1, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: {} }));
    expect(activity.state).toBe("working");
    activity.agentLine(1, JSON.stringify({ jsonrpc: "2.0", id: 0, method: "session/request_permission", params: {} }));
    expect(activity.state).toBe("needs-you");
    activity.clientLine(1, JSON.stringify({ jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } }));
    expect(activity.state).toBe("working");
    activity.agentLine(1, JSON.stringify({ jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } }));
    expect(activity.state).toBe("idle");
    activity.clientLine(2, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: {} }));
    activity.clientGone(2);
    expect(activity.state).toBe("idle");
  });

  it("answers its state to a holder of the token", async () => {
    const h = await start();
    expect((await fetch(`${h.url}/api/state`)).status).toBe(401);
    const state = await fetch(`${h.url}/api/state`, { headers: { Authorization: `Bearer ${h.token}` } });
    expect(await state.json()).toEqual({ state: "idle", mode: "live", inView: true, clients: 0 });
  });

  it("ranks files for the @ menu: names that start with the query first", () => {
    expect(rankFiles(["src/cli.ts", "docs/status.md", "src/status.ts", "src/statusline.ts"], "status"))
      .toEqual(["src/status.ts", "docs/status.md", "src/statusline.ts"]);
  });
  it("keeps a review, relays its comments to the views listening, and says when the app cannot open it", async () => {
    host = await startAcpHost({
      paneId: "%44",
      agent: { id: "test-acp", name: "Test" },
      runtimeTempDir: join(dir, "rt"),
      webRoot: join(dir, "web"),
      cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", ECHO_AGENT], env: process.env },
      appControl: { socketPath: join(dir, "no.sock"), tokenPath: join(dir, "no.token") },
    });
    const h = host;
    const auth = { Authorization: `Bearer ${h.token}`, "Content-Type": "application/json" };
    const created = await fetch(`${h.url}/api/review`, { method: "POST", headers: auth, body: JSON.stringify({ changes: [], agentName: "Test" }) });
    const { id } = await created.json() as { id: string };
    expect(await (await fetch(`${h.url}/api/review/${id}`, { headers: auth })).json()).toEqual({ changes: [], agentName: "Test" });
    expect((await fetch(`${h.url}/api/review/${id}`)).status).toBe(401);

    // No view listening yet: the comments have nowhere to go.
    expect((await fetch(`${h.url}/api/review/${id}/send`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Fix" }) })).status).toBe(409);

    const controller = new AbortController();
    const stream = await fetch(`${h.url}/api/events?token=${encodeURIComponent(h.token)}`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    const sent = await fetch(`${h.url}/api/review/${id}/send`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Fix" }) });
    expect(sent.status).toBe(200);
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("event: send");
    expect(chunk).toContain(`"review":"${id}"`);
    controller.abort();

    const opened = await fetch(`${h.url}/api/open-review`, { method: "POST", headers: auth, body: JSON.stringify({ id }) });
    expect(opened.status).toBe(503);
  });
});
