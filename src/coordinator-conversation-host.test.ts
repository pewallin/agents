import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startAcpHost, type AcpHost } from "./acp-host.js";
import { markTurnNotify, readThread } from "./app-control/conversation.js";

// The stand-in agent of acp-rest.test.ts.
const AGENT = (dir: string) => `
const fs = require("node:fs");
const store = ${JSON.stringify(join(dir, "store.json"))};
const notes = ${JSON.stringify(join(dir, "agent-notes.txt"))};
fs.appendFileSync(notes, "start\\n");
const read = () => { try { return JSON.parse(fs.readFileSync(store, "utf8")); } catch { return {}; } };
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const options = (mode) => [{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode, options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] }];
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method) fs.appendFileSync(notes, m.method + (m.params && m.params.value ? " " + m.params.value : "") + "\\n");
  const sessions = read();
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (m.method === "session/new") { sessions["fake-1"] = []; fs.writeFileSync(store, JSON.stringify(sessions)); send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "fake-1", configOptions: options("default") } }); }
  else if (m.method === "session/load") {
    for (const [user, agent] of sessions[m.params.sessionId] || []) {
      update(m.params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: user } });
      update(m.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: agent } });
    }
    send({ jsonrpc: "2.0", id: m.id, result: { configOptions: options("default") } });
  } else if (m.method === "session/set_config_option") send({ jsonrpc: "2.0", id: m.id, result: { configOptions: options(m.params.value) } });
  else if (m.method === "session/prompt") {
    const text = m.params.prompt[0].text;
    (sessions[m.params.sessionId] = sessions[m.params.sessionId] || []).push([text, "Hello"]);
    fs.writeFileSync(store, JSON.stringify(sessions));
    update(m.params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
`;

const until = async (check: () => boolean | Promise<boolean>, ms = 8_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};


describe("a coordinator's pane", () => {
  let dir: string;
  let program: string;
  let host: AcpHost | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acp-coordinator-"));
    program = join(dir, "program");
    mkdirSync(join(dir, "web"), { recursive: true });
    mkdirSync(program, { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html>");
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the user's messages and its answers apart from its sessions, and a view still shows all of the session", async () => {
    host = await startAcpHost({
      paneId: "%8", agent: { id: "test-acp", name: "Test" }, runtimeTempDir: join(dir, "rt"), webRoot: join(dir, "web"), cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT(dir)], env: process.env },
      sessionLog: { harness: "test", root: join(dir, "sessions") },
      coordinatorProgram: () => program,
      historyAgent: "claude",
    });
    const h = host;
    await h.startHostedSession();
    const ws = new WebSocket(`${h.url.replace("http", "ws")}/acp?token=${encodeURIComponent(h.token)}`, { headers: { Origin: h.url } });
    const got: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => got.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.once("open", resolve));
    const ask = async (id: number, method: string, params: Record<string, unknown>) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      await until(() => got.some((m) => m.id === id && m.method === undefined));
    };
    await ask(1, "initialize", { protocolVersion: 1 });
    await ask(2, "session/load", { sessionId: "fake-1", cwd: dir, mcpServers: [] });
    await ask(3, "session/prompt", { sessionId: "fake-1", prompt: [{ type: "text", text: "Fix the login" }] });
    // A wake the CLI typed is no message of the user's; its turn says what woke it.
    await h.hostedPrompt('<agents-event kind="wake" thread="login" from="agents" words="data">Worker login is done · read /p/m.md</agents-event>');
    const thread = readThread(program);
    expect(thread.map((entry) => entry.kind)).toEqual(["message", "turn", "turn"]);
    expect(thread[0]).toMatchObject({ from: "user", via: "pane", text: "Fix the login" });
    expect(thread[1]).toMatchObject({ agent: "claude", session: "fake-1", how: { start: "continue" }, reply: "Hello" });
    expect(thread[2]).toMatchObject({ wokeBy: "Worker login is done", reply: "Hello" });
    ws.close();

    // A view that loads the pane again is given the whole session, never only the conversation
    // thread.jsonl has (it begins with the build that writes it: the history before was lost).
    const again = new WebSocket(`${h.url.replace("http", "ws")}/acp?token=${encodeURIComponent(h.token)}`, { headers: { Origin: h.url } });
    const seen: Array<Record<string, unknown>> = [];
    again.on("message", (data) => seen.push(JSON.parse(String(data))));
    await new Promise((resolve) => again.once("open", resolve));
    again.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    again.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "fake-1", cwd: dir, mcpServers: [] } }));
    await until(() => seen.some((m) => m.id === 2 && m.method === undefined));
    const texts = seen.filter((m) => m.method === "session/update").map((m) => (m.params as { update: { sessionUpdate: string; content?: { text?: string } } }).update)
      .map((update) => `${update.sessionUpdate}:${update.content?.text ?? ""}`);
    expect(texts).toEqual([
      "user_message_chunk:Fix the login",
      "agent_message_chunk:Hello",
      'user_message_chunk:<agents-event kind="wake" thread="login" from="agents" words="data">Worker login is done · read /p/m.md</agents-event>',
      "agent_message_chunk:Hello",
    ]);
    again.close();
  }, 20_000);

  it("notifies only for a turn the coordinator marked, with the turn's id (R7)", async () => {
    const told: string[] = [];
    host = await startAcpHost({
      paneId: "%8", agent: { id: "test-acp", name: "Test" }, runtimeTempDir: join(dir, "rt"), webRoot: join(dir, "web"), cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT(dir)], env: process.env },
      sessionLog: { harness: "test", root: join(dir, "sessions") },
      coordinatorProgram: () => program,
      onNotify: (value) => told.push(value),
    });
    const h = host;
    await h.startHostedSession();
    await h.hostedPrompt('<agents-event kind="wake" thread="login" from="agents" words="data">Worker login is done · read /p/m.md</agents-event>');
    expect(told).toEqual([]);
    // `agent notify` in the next turn: the mark is written while the turn runs.
    const prompt = h.hostedPrompt('<agents-event kind="wake" thread="api" from="agents" words="data">Worker api is done · read /p/n.md</agents-event>');
    markTurnNotify(program, { text: "api är klar", why: "done" });
    await prompt;
    const thread = readThread(program);
    expect(thread.at(-2)).not.toHaveProperty("notify");
    expect(thread.at(-1)).toMatchObject({ wokeBy: "Worker api is done", notify: { why: "done", text: "api är klar" } });
    expect(told).toHaveLength(1);
    expect(JSON.parse(told[0])).toEqual({ turn: thread.at(-1)!.id, at: thread.at(-1)!.at, why: "done", text: "api är klar" });
  }, 20_000);

  it("shows a run that started fresh below the runs it went on from in the pane", async () => {
    const root = join(dir, "sessions");
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "old-1.jsonl"), [
      { v: 1, n: 0, at: "x", kind: "start", session: "old-1", harness: "test" },
      { v: 1, n: 1, at: "x", kind: "user", text: "Earlier question" },
      { v: 1, n: 2, at: "x", kind: "agent", text: "Earlier answer" },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    host = await startAcpHost({
      paneId: "%8", agent: { id: "test-acp", name: "Test" }, runtimeTempDir: join(dir, "rt"), webRoot: join(dir, "web"), cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT(dir)], env: process.env },
      sessionLog: { harness: "test", root, origin: () => ({ previous: "old-1" }) },
      coordinatorProgram: () => program,
    });
    const h = host;
    await h.startHostedSession();
    await h.hostedPrompt("Now");
    // A new session's log names the one before only once it is made; a fresh host loads it.
    await h.close();
    host = await startAcpHost({
      paneId: "%8", agent: { id: "test-acp", name: "Test" }, runtimeTempDir: join(dir, "rt2"), webRoot: join(dir, "web"), cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT(dir)], env: process.env },
      sessionLog: { harness: "test", root },
      coordinatorProgram: () => program,
    });
    await host.startHostedSession("fake-1");
    const ws = new WebSocket(`${host.url.replace("http", "ws")}/acp?token=${encodeURIComponent(host.token)}`, { headers: { Origin: host.url } });
    const seen: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => seen.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "fake-1", cwd: dir, mcpServers: [] } }));
    await until(() => seen.some((m) => m.id === 2 && m.method === undefined));
    const texts = seen.filter((m) => m.method === "session/update").map((m) => (m.params as { update: { content?: { text?: string } } }).update.content?.text);
    expect(texts.slice(0, 2)).toEqual(["Earlier question", "Earlier answer"]);
    expect(texts).toContain("Now");
    ws.close();
  }, 20_000);

  it("draws the pane from its conversation once seeded from the session's log, never with less than the log", async () => {
    const root = join(dir, "sessions");
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "fake-1.jsonl"), [
      { v: 1, n: 0, at: "x", kind: "start", session: "fake-1", harness: "test" },
      { v: 1, n: 1, at: "x", kind: "user", text: "Earlier question" },
      { v: 1, n: 2, at: "x", kind: "agent", text: "Earlier answer" },
      { v: 1, n: 3, at: "x", kind: "user", text: "⟢ agents · Worker ui is done · read /p/messages/20261125T100000-ab12.md" },
      { v: 1, n: 4, at: "x", kind: "agent", text: "ui is done." },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    host = await startAcpHost({
      paneId: "%8", agent: { id: "test-acp", name: "Test" }, runtimeTempDir: join(dir, "rt"), webRoot: join(dir, "web"), cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT(dir)], env: process.env },
      sessionLog: { harness: "test", root },
      coordinatorProgram: () => program,
    });
    await host.startHostedSession("fake-1");
    const ws = new WebSocket(`${host.url.replace("http", "ws")}/acp?token=${encodeURIComponent(host.token)}`, { headers: { Origin: host.url } });
    const seen: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => seen.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "fake-1", cwd: dir, mcpServers: [] } }));
    await until(() => seen.some((m) => m.id === 2 && m.method === undefined));
    const texts = seen.filter((m) => m.method === "session/update").map((m) => (m.params as { update: { content?: { text?: string } } }).update.content?.text);
    expect(texts).toEqual(["Earlier question", "Earlier answer", '<agents-event kind="wake" from="agents" words="data">Worker ui is done</agents-event>', "ui is done."]);
    expect(readThread(program).length).toBe(3);
    ws.close();
  }, 20_000);
});
