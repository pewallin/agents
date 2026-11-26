import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startAcpHost, type AcpHost } from "./acp-host.js";
import { parseSessionLog, sessionLogPath } from "./session-log.js";

// A stand-in agent that keeps its sessions in a file, so another process of it loads them:
// a load replays the turns, a prompt answers "Hello", and each start and request is noted.
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

describe("an ACP host whose agent rests", () => {
  let dir: string;
  let host: AcpHost | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acp-rest-"));
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html>");
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (rested: string[] = []) => startAcpHost({
    paneId: "%9",
    agent: { id: "test-acp", name: "Test" },
    runtimeTempDir: join(dir, "rt"),
    webRoot: join(dir, "web"),
    cwd: dir,
    agentCommand: { command: process.execPath, args: ["-e", AGENT(dir)], env: process.env },
    sessionLog: { harness: "test", root: join(dir, "sessions") },
    rest: { idleMs: 1_000, onRest: (id) => () => { rested.push(id); } },
  });
  const notes = () => existsSync(join(dir, "agent-notes.txt")) ? readFileSync(join(dir, "agent-notes.txt"), "utf8").trim().split("\n") : [];
  const state = async (h: AcpHost) => (await (await fetch(`${h.url}/api/state`, { headers: { Authorization: `Bearer ${h.token}` } })).json()) as { resting?: boolean; state?: string };
  const view = async (h: AcpHost) => {
    const ws = new WebSocket(`${h.url.replace("http", "ws")}/acp?token=${encodeURIComponent(h.token)}`, { headers: { Origin: h.url } });
    const got: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => got.push(JSON.parse(String(data))));
    await new Promise((resolve) => ws.once("open", resolve));
    const ask = async (id: number, method: string, params: Record<string, unknown>) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      await until(() => got.some((m) => m.id === id && m.method === undefined));
      return got.find((m) => m.id === id && m.method === undefined) as { result?: Record<string, unknown>; error?: unknown };
    };
    const texts = () => got.filter((m) => m.method === "session/update").map((m) => ((m.params as { update: { content?: { text?: string } } }).update.content?.text) ?? null).filter(Boolean);
    return { ws, got, ask, texts };
  };

  it("rests when idle, opens from its log without the agent, and wakes when the view writes", async () => {
    const rested: string[] = [];
    host = await start(rested);
    const h = host;
    // A worker's session: the host's own, prompted.
    expect(await h.startHostedSession()).toBe("fake-1");
    await h.hostedPrompt("First");
    const first = await view(h);
    await first.ask(1, "initialize", { protocolVersion: 1 });
    await first.ask(2, "session/load", { sessionId: "fake-1", cwd: dir, mcpServers: [] });
    await first.ask(3, "session/set_config_option", { sessionId: "fake-1", configId: "mode", value: "plan" });
    first.ws.close();
    // Idle with no view in front: the agent stops, the host keeps the session.
    await until(async () => (await state(h)).resting === true, 6_000);
    await until(() => rested.length > 0);
    expect(rested).toEqual(["fake-1"]);
    const starts = notes().filter((line) => line === "start").length;

    // A view opens from the log: no agent starts.
    const second = await view(h);
    const init = await second.ask(1, "initialize", { protocolVersion: 1 });
    expect(init.result).toMatchObject({ agentCapabilities: { loadSession: true } });
    const loaded = await second.ask(2, "session/load", { sessionId: "fake-1", cwd: dir, mcpServers: [] });
    expect((loaded.result?.configOptions as Array<{ currentValue: string }>)[0].currentValue).toBe("plan");
    expect(second.texts()).toEqual(["First", "Hello"]);
    expect(notes().filter((line) => line === "start").length).toBe(starts);

    // The first keystroke wakes it; the session's mode is set again; its replay is not shown twice.
    second.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "_agents/wake", params: {} }));
    await until(async () => (await state(h)).resting !== true);
    expect(notes()).toContain("session/set_config_option plan");
    const answer = await second.ask(3, "session/prompt", { sessionId: "fake-1", prompt: [{ type: "text", text: "Second" }] });
    expect(answer.result).toMatchObject({ stopReason: "end_turn" });
    expect(second.texts()).toEqual(["First", "Hello", "Hello"]);
    const log = parseSessionLog(readFileSync(sessionLogPath("test", "fake-1", join(dir, "sessions")), "utf8"));
    expect(log.filter((line) => line.kind === "user").map((line) => line.text)).toEqual(["First", "Second"]);
    second.ws.close();
  }, 20_000);

  it("a prompt sent while it rests waits for the agent and goes to it", async () => {
    host = await start();
    const h = host;
    await h.startHostedSession();
    await h.hostedPrompt("First");
    await until(async () => (await state(h)).resting === true, 6_000);
    const v = await view(h);
    await v.ask(1, "initialize", { protocolVersion: 1 });
    await v.ask(2, "session/load", { sessionId: "fake-1", cwd: dir, mcpServers: [] });
    const answer = await v.ask(3, "session/prompt", { sessionId: "fake-1", prompt: [{ type: "text", text: "Again" }] });
    expect(answer.result).toMatchObject({ stopReason: "end_turn" });
    expect(v.texts()).toEqual(["First", "Hello", "Hello"]);
    v.ws.close();
  }, 20_000);

  it("does not rest the agent of a view that has the focus, and rests on the app's word", async () => {
    host = await start();
    const h = host;
    await h.startHostedSession();
    await h.hostedPrompt("First");
    const v = await view(h);
    await v.ask(1, "initialize", { protocolVersion: 1 });
    await v.ask(2, "session/load", { sessionId: "fake-1", cwd: dir, mcpServers: [] });
    v.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "_agents/focus", params: { focused: true } }));
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await state(h)).resting).toBeUndefined();
    const rest = await (await fetch(`${h.url}/api/rest`, { method: "POST", headers: { Authorization: `Bearer ${h.token}` } })).json() as { rested: boolean };
    expect(rest.rested).toBe(true);
    expect((await state(h)).resting).toBe(true);
    v.ws.close();
  }, 20_000);

  it("a session the TUI had since opens through the agent again", async () => {
    host = await start();
    const h = host;
    await h.startHostedSession();
    await h.hostedPrompt("First");
    h.sessionInTui("fake-1");
    h.closeClients();
    const starts = notes().filter((line) => line === "start").length;
    await h.startHostedSession("fake-1");
    expect(notes().filter((line) => line === "start").length).toBe(starts + 1);
  }, 20_000);
});
