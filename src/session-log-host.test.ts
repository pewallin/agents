import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startAcpHost, type AcpHost } from "./acp-host.js";
import { parseSessionLog, sessionLogPath } from "./session-log.js";

// A stand-in agent with one session: a prompt streams two chunks and ends the turn.
const AGENT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-1" } });
  else if (msg.method === "session/prompt") {
    for (const text of ["Hel", "lo"]) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  } else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;

describe("the ACP host's session log", () => {
  let dir: string;
  let host: AcpHost | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acp-log-host-"));
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html>");
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = () => startAcpHost({
    paneId: "%7",
    agent: { id: "test-acp", name: "Test" },
    runtimeTempDir: join(dir, "rt"),
    webRoot: join(dir, "web"),
    cwd: dir,
    agentCommand: { command: process.execPath, args: ["-e", AGENT], env: process.env },
    sessionLog: { harness: "test", root: join(dir, "sessions"), origin: () => ({ pane: "%7" }) },
  });
  const kinds = () => parseSessionLog(readFileSync(sessionLogPath("test", "fake-1", join(dir, "sessions")), "utf8")).map((line) => [line.kind, line.text ?? null]);

  it("writes what a view's agent draws", async () => {
    host = await start();
    const ws = new WebSocket(`${host.url.replace("http", "ws")}/acp?token=${encodeURIComponent(host.token)}`, { headers: { Origin: host.url } });
    const answers = new Map<number, unknown>();
    ws.on("message", (data) => { const m = JSON.parse(String(data)); if (m.id !== undefined && m.method === undefined) answers.set(m.id, m.result); });
    await new Promise((resolve) => ws.once("open", resolve));
    const ask = async (id: number, method: string, params: Record<string, unknown>) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      for (let i = 0; i < 100 && !answers.has(id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      return answers.get(id);
    };
    await ask(1, "initialize", { protocolVersion: 1 });
    await ask(2, "session/new", { cwd: dir, mcpServers: [] });
    await ask(3, "session/prompt", { sessionId: "fake-1", prompt: [{ type: "text", text: "Hi" }] });
    ws.close();
    expect(kinds()).toEqual([["start", null], ["user", "Hi"], ["agent", "Hello"], ["turnEnd", null]]);
  });

  it("tells a thread's own page its title, brief and a proposed close, and nothing on another pane", async () => {
    const program = join(dir, "program");
    mkdirSync(join(program, "tasks", "fix"), { recursive: true });
    writeFileSync(join(program, "tasks", "fix", "task.json"), JSON.stringify({ title: "Fixa inloggningen", proposedClose: { why: "Klar och mergad", at: "2026-11-27T12:00:00.000Z", as: "done" } }));
    writeFileSync(join(program, "tasks", "fix", "brief.md"), "# Task: fix\n\n## Brief\n\nROLE: worker\n\n## Goal\n\nThe login works again.\n\n## How to work here\n\nRead WORKER.md.\n");
    let own: { program: string; task: string } | undefined = { program, task: "fix" };
    host = await startAcpHost({
      paneId: "%7", agent: { id: "test-acp", name: "Test" }, runtimeTempDir: join(dir, "rt"), webRoot: join(dir, "web"), cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT], env: process.env },
      ownThread: () => own,
    });
    const auth = { headers: { Authorization: `Bearer ${host.token}` } };
    const read = async () => (await (await fetch(`${host!.url}/api/thread`, auth)).json()) as { thread: unknown };
    expect(await read()).toEqual({ thread: { task: "fix", program, title: "Fixa inloggningen", brief: "## Goal\n\nThe login works again.", proposedClose: { why: "Klar och mergad", at: "2026-11-27T12:00:00.000Z" } } });
    // The answers the thread edited, for its view (and none, with follows false, for no project's pane).
    writeFileSync(join(program, "tasks", "fix", "edits.jsonl"), `${JSON.stringify({ kind: "edit", id: "e-1", at: "2026-11-28T11:00:00.000Z", by: "worker", original: "Klart.", text: "Klart, utom SSO." })}\n`);
    const edits = async () => (await (await fetch(`${host!.url}/api/edits`, auth)).json()) as unknown;
    expect(await edits()).toEqual({ follows: true, role: "worker", edits: [{ original: "Klart.", text: "Klart, utom SSO.", at: "2026-11-28T11:00:00.000Z" }] });
    own = undefined;
    expect(await read()).toEqual({ thread: null });
    expect(await edits()).toEqual({ follows: false, role: null, edits: [] });
  });

  it("stops the turn of the session it holds when the app asks, and says so when it holds none", async () => {
    host = await start();
    const post = () => fetch(`${host!.url}/api/cancel`, { method: "POST", headers: { Authorization: `Bearer ${host!.token}` } });
    expect((await post()).status).toBe(409);
    await host.startHostedSession();
    expect((await post()).status).toBe(200);
  });

  it("writes the host's own session, its prompts included", async () => {
    host = await start();
    expect(await host.startHostedSession()).toBe("fake-1");
    await host.hostedPrompt("The brief");
    expect(kinds()).toEqual([["start", null], ["user", "The brief"], ["agent", "Hello"], ["turnEnd", null]]);
  });
});
