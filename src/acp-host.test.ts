import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { readAcpHostMetadata, startAcpHost, type AcpHost } from "./acp-host.js";

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
    expect(readAcpHostMetadata(h.metadataPath)).toEqual({ url: h.url, token: h.token, processId: process.pid, agent: "test-acp" });
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
});
