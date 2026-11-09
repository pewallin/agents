import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AcpApprovals, allowOption, claudeApprovals, kiroApprovals, opencodeApprovals } from "./acp-approvals.js";
import { ACP_AGENTS } from "./acp-host-cli.js";
import { startAcpHost } from "./acp-host.js";
import { HostedSession } from "./acp-hosted-session.js";

// An ACP agent with modes and a tool that asks: session/new and session/load answer in mode
// "default" (of default, bypassPermissions); session/set_mode switches without a word, as Claude's
// adapter does for a mode its client asked for; a prompt asks
// about a tool call and ends its turn with the option it was given.
const AGENT = `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let mode = "default";
let turn;
const modes = () => ({ currentModeId: mode, availableModes: [{ id: "default" }, { id: "bypassPermissions" }] });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "s1", modes: modes() } });
  else if (message.method === "session/load") send({ id: message.id, result: { modes: modes() } });
  else if (message.method === "session/set_mode") {
    mode = message.params.modeId;
    send({ id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    turn = message.id;
    send({ id: "perm-1", method: "session/request_permission", params: { sessionId: "s1", toolCall: { title: "Run touch" }, options: [
      { optionId: "always", kind: "allow_always" }, { optionId: "once", kind: "allow_once" }, { optionId: "no", kind: "reject_once" },
    ] } });
  } else if (message.id === "perm-1" && message.method === undefined) {
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: mode + " " + message.result.outcome.optionId } } } });
    send({ id: turn, result: { stopReason: "end_turn" } });
  }
});
`;

describe("what the pane's command says about approvals", () => {
  it("reads each agent's own options", () => {
    expect(kiroApprovals("kiro-cli chat -a")).toEqual({ allowAll: true });
    expect(kiroApprovals("kiro-cli chat --trust-all-tools --resume")).toEqual({ allowAll: true });
    expect(kiroApprovals("kiro-cli chat")).toBeUndefined();
    // A prompt after -- is not the command's options.
    expect(kiroApprovals("kiro-cli chat -- -a")).toBeUndefined();
    expect(claudeApprovals("claude --dangerously-skip-permissions")).toEqual({ mode: "bypassPermissions" });
    expect(claudeApprovals("claude --permission-mode acceptEdits")).toEqual({ mode: "acceptEdits" });
    expect(claudeApprovals("claude --permission-mode=plan --dangerously-skip-permissions")).toEqual({ mode: "plan" });
    expect(claudeApprovals("claude --allow-dangerously-skip-permissions")).toBeUndefined();
    expect(opencodeApprovals("opencode --auto")).toEqual({ allowAll: true });
    expect(opencodeApprovals("opencode")).toBeUndefined();
  });

  it("is each hand-off agent's entry", () => {
    expect(ACP_AGENTS.kiro.approvals?.("kiro-cli chat -a")).toEqual({ allowAll: true });
    expect(ACP_AGENTS["claude-acp"].approvals?.("claude --dangerously-skip-permissions")).toEqual({ mode: "bypassPermissions" });
    expect(ACP_AGENTS.opencode.approvals?.("opencode --auto")).toEqual({ allowAll: true });
  });

  it("allows once where the agent offers it, else always, and never rejects", () => {
    expect(allowOption([{ optionId: "a", kind: "allow_always" }, { optionId: "o", kind: "allow_once" }])).toBe("o");
    expect(allowOption([{ optionId: "a", kind: "allow_always" }, { optionId: "r", kind: "reject_once" }])).toBe("a");
    expect(allowOption([{ optionId: "r", kind: "reject_once" }])).toBeUndefined();
    expect(allowOption(undefined)).toBeUndefined();
  });
});

describe("the policy on an adapter's channel", () => {
  it("answers a permission request itself and lets everything else through", () => {
    const sent: string[] = [];
    const approvals = new AcpApprovals({ allowAll: true }, (line) => sent.push(line));
    const ask = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { options: [{ optionId: "yes", kind: "allow_once" }] } });
    expect(approvals.agentLine(ask)).toBe(true);
    expect(JSON.parse(sent[0])).toEqual({ jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "yes" } } });
    expect(approvals.agentLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }))).toBe(false);
    // A question with nothing to allow is the person's.
    expect(approvals.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "session/request_permission", params: { options: [{ optionId: "no", kind: "reject_once" }] } }))).toBe(false);
  });

  it("puts a session that opens in another mode into the command's, once, and keeps the answer to itself", () => {
    const sent: string[] = [];
    const told: string[] = [];
    const approvals = new AcpApprovals({ mode: "bypassPermissions" }, (line) => sent.push(line), undefined, (line) => told.push(line));
    const available = [{ id: "default" }, { id: "bypassPermissions" }];
    approvals.clientLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/" } }));
    expect(approvals.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1", modes: { currentModeId: "default", availableModes: available } } }))).toBe(false);
    const setMode = JSON.parse(sent[0]);
    expect(setMode).toMatchObject({ method: "session/set_mode", params: { sessionId: "s1", modeId: "bypassPermissions" } });
    expect(approvals.agentLine(JSON.stringify({ jsonrpc: "2.0", id: setMode.id, result: {} }))).toBe(true);
    // The view is told, as the agent tells no client of a mode the client set.
    expect(told.map((line) => JSON.parse(line))).toEqual([{ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "current_mode_update", currentModeId: "bypassPermissions" } } }]);
    // A session already in the mode, and an agent without it, are left as they are.
    approvals.clientLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "s2" } }));
    approvals.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { modes: { currentModeId: "bypassPermissions", availableModes: available } } }));
    approvals.clientLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/load", params: { sessionId: "s3" } }));
    approvals.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { modes: { currentModeId: "default", availableModes: [{ id: "default" }] } } }));
    expect(sent).toHaveLength(1);
    // It answers no permission request: in its mode the agent decides what still asks.
    expect(approvals.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/request_permission", params: { options: [{ optionId: "o", kind: "allow_once" }] } }))).toBe(false);
  });
});

describe("a host whose pane command runs tools without asking", () => {
  function web() {
    const dir = mkdtempSync(join(tmpdir(), "acp-approvals-"));
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html>");
    return dir;
  }

  async function viewTurn(policy: { allowAll: true } | { mode: string }) {
    const dir = web();
    const host = await startAcpHost({
      paneId: "%7",
      agent: { id: "test-acp", name: "Test" },
      runtimeTempDir: join(dir, "rt"),
      webRoot: join(dir, "web"),
      cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT], env: process.env },
      approvals: policy,
    });
    const received: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(`${host.url.replace("http", "ws")}/acp?token=${encodeURIComponent(host.token)}`, { headers: { Origin: host.url } });
    try {
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      ws.on("message", (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
      const next = async (match: (message: Record<string, unknown>) => boolean) => {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const found = received.find(match);
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`no such message in ${JSON.stringify(received)}`);
      };
      const send = (message: Record<string, unknown>) => ws.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
      send({ id: 1, method: "initialize", params: {} });
      await next((message) => message.id === 1);
      send({ id: 2, method: "session/new", params: { cwd: dir, mcpServers: [] } });
      await next((message) => message.id === 2);
      send({ id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "go" }] } });
      const asked = received.some((message) => message.method === "session/request_permission");
      if ("mode" in policy) {
        const ask = await next((message) => message.method === "session/request_permission");
        send({ id: ask.id as string, result: { outcome: { outcome: "selected", optionId: "once" } } });
      }
      await next((message) => message.id === 3);
      return { received, asked: asked || received.some((message) => message.method === "session/request_permission") };
    } finally {
      ws.close();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const said = (received: Array<Record<string, unknown>>) => received
    .map((message) => (message.params as { update?: { sessionUpdate?: string; content?: { text?: string }; currentModeId?: string } } | undefined)?.update)
    .filter((update) => update?.sessionUpdate === "agent_message_chunk" || update?.sessionUpdate === "current_mode_update")
    .map((update) => update!.content?.text ?? `mode ${update!.currentModeId}`);

  it("allows the view's tool calls itself: the view is never asked", async () => {
    const { received, asked } = await viewTurn({ allowAll: true });
    expect(asked).toBe(false);
    expect(said(received)).toEqual(["default once"]);
  });

  it("puts the view's session in the command's mode, which the view is told", async () => {
    const { received, asked } = await viewTurn({ mode: "bypassPermissions" });
    expect(said(received)).toEqual(["mode bypassPermissions", "bypassPermissions once"]);
    // The host's own request is answered to the host.
    expect(received.some((message) => typeof message.id === "string" && message.id.startsWith("agents-host-approvals"))).toBe(false);
    expect(asked).toBe(true);
  });

  it("does both for the session the host holds, and a view that loads it later sees the mode it is in", async () => {
    const child = spawn(process.execPath, ["-e", AGENT], { stdio: ["pipe", "pipe", "pipe"] });
    const session = new HostedSession(child, { approvals: { mode: "bypassPermissions" } });
    try {
      expect(await session.start("/tmp")).toBe("s1");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const received: Array<Record<string, unknown>> = [];
      const view = session.attach((line) => received.push(JSON.parse(line) as Record<string, unknown>));
      view.fromView(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s1" } }));
      expect(received.find((message) => message.id === 1)?.result).toMatchObject({ modes: { currentModeId: "bypassPermissions" } });
    } finally {
      await session.stop();
    }

    const allowing = spawn(process.execPath, ["-e", AGENT], { stdio: ["pipe", "pipe", "pipe"] });
    const allowed = new HostedSession(allowing, { approvals: { allowAll: true } });
    try {
      await allowed.start("/tmp");
      expect(await allowed.prompt("go")).toBe("end_turn");
    } finally {
      await allowed.stop();
    }
  });
});
