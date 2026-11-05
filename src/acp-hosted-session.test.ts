import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAcpHost } from "./acp-host.js";
import { HostedSession } from "./acp-hosted-session.js";

// A small ACP agent: one session; a prompt answers "echo: <text>", and a prompt "ask" first asks
// for a permission and ends its turn with the answer it got.
const FAKE_AGENT = `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let asked;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "s1", modes: { currentModeId: "default", availableModes: [] } } });
  else if (message.method === "session/prompt") {
    const text = message.params.prompt.map((block) => block.text).join("");
    if (text === "ask") {
      asked = message.id;
      send({ id: "perm-1", method: "session/request_permission", params: { sessionId: "s1", options: [{ optionId: "ok" }] } });
      return;
    }
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo: " + text } } } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.id === "perm-1" && message.method === undefined) {
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answered " + message.result.outcome.optionId } } } });
    send({ id: asked, result: { stopReason: "end_turn" } });
  }
});
`;

describe("a session the host holds", () => {
  const sessions: HostedSession[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.stop();
  });

  function hosted() {
    const child = spawn(process.execPath, ["-e", FAKE_AGENT], { stdio: ["pipe", "pipe", "pipe"] });
    const session = new HostedSession(child);
    sessions.push(session);
    return session;
  }

  function viewOf(session: HostedSession) {
    const received: Array<Record<string, unknown>> = [];
    const view = session.attach((line) => received.push(JSON.parse(line) as Record<string, unknown>));
    const next = async (match: (message: Record<string, unknown>) => boolean) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const found = received.find(match);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no such message in ${JSON.stringify(received)}`);
    };
    return { view, received, next };
  }

  it("runs a brief before any view, and a view that loads the session later sees it", async () => {
    const session = hosted();
    expect(await session.start("/tmp")).toBe("s1");
    expect(await session.prompt("the brief")).toBe("end_turn");

    const { view, received, next } = viewOf(session);
    view.fromView(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }));
    view.fromView(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s1", cwd: "/tmp" } }));
    const loaded = await next((message) => message.id === 1);
    expect(loaded.result).toEqual({ modes: { currentModeId: "default", availableModes: [] } });
    expect(received[0]).toMatchObject({ id: 0, result: { agentCapabilities: { loadSession: true } } });
    const texts = received
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as { update: { sessionUpdate: string; content: { text: string } } }).update);
    expect(texts.map((update) => [update.sessionUpdate, update.content.text])).toEqual([
      ["user_message_chunk", "the brief"],
      ["agent_message_chunk", "echo: the brief"],
    ]);
  });

  it("passes a view's prompt through with an id of its own and answers it with the view's id", async () => {
    const session = hosted();
    await session.start("/tmp");
    const { view, next } = viewOf(session);
    view.fromView(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } }));
    expect((await next((message) => message.id === 7)).result).toEqual({ stopReason: "end_turn" });
    // The host's own prompt meanwhile is answered to the host, not to the view.
    expect(await session.prompt("from the host")).toBe("end_turn");
  });

  it("keeps the agent's question for a view that attaches later", async () => {
    const session = hosted();
    await session.start("/tmp");
    const turn = session.prompt("ask");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { view, next } = viewOf(session);
    view.fromView(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s1" } }));
    const ask = await next((message) => message.method === "session/request_permission");
    view.fromView(JSON.stringify({ jsonrpc: "2.0", id: ask.id, result: { outcome: { outcome: "selected", optionId: "ok" } } }));
    expect(await turn).toBe("end_turn");
  });
});

describe("the host's own session", () => {
  it("takes prompts over HTTP only while it holds a session, and runs them as turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-hosted-"));
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html>");
    const host = await startAcpHost({
      paneId: "%9",
      agent: { id: "test-acp", name: "Test" },
      runtimeTempDir: join(dir, "rt"),
      webRoot: join(dir, "web"),
      cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", FAKE_AGENT], env: process.env },
    });
    try {
      const post = (text: string, token = host.token) => fetch(`${host.url}/api/prompt`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      expect((await post("hi", "wrong")).status).toBe(401);
      expect((await post("hi")).status).toBe(409);
      expect(await host.startHostedSession()).toBe("s1");
      const accepted = await post("hi");
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toEqual({ sessionId: "s1" });
      await host.hostedPrompt("again");
      expect(await host.viewAttached(10)).toBe(false);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
