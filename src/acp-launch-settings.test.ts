import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  AcpLaunchSettingsApplier, allowOption, claudeLaunchSettings, kiroLaunchSettings, opencodeLaunchSettings, settingRequest,
  type AcpLaunchSettings,
} from "./acp-launch-settings.js";
import { ACP_AGENTS } from "./acp-host-cli.js";
import { startAcpHost } from "./acp-host.js";
import { HostedSession } from "./acp-hosted-session.js";

// An ACP agent with settings as Claude's adapter has them: config options for mode (default,
// bypassPermissions) and model (sonnet, opus), set with session/set_config_option, which answers
// with the options and tells no one else. A prompt asks about a tool call and ends its turn
// saying the mode, the model and the option it was given.
const AGENT = `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const current = { mode: "default", model: "sonnet" };
let turn;
const configOptions = () => [
  { id: "mode", category: "mode", type: "select", currentValue: current.mode, options: [{ value: "default", name: "Default" }, { value: "bypassPermissions", name: "Bypass Permissions" }] },
  { id: "model", category: "model", type: "select", currentValue: current.model, options: [{ group: "all", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] }] },
];
const opened = () => ({ configOptions: configOptions(), modes: { currentModeId: current.mode, availableModes: [{ id: "default" }, { id: "bypassPermissions" }] } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "s1", ...opened() } });
  else if (message.method === "session/load") send({ id: message.id, result: opened() });
  else if (message.method === "session/set_config_option") {
    current[message.params.configId] = message.params.value;
    send({ id: message.id, result: { configOptions: configOptions() } });
  } else if (message.method === "session/prompt") {
    turn = message.id;
    send({ id: "perm-1", method: "session/request_permission", params: { sessionId: "s1", toolCall: { title: "Run touch" }, options: [
      { optionId: "always", kind: "allow_always" }, { optionId: "once", kind: "allow_once" }, { optionId: "no", kind: "reject_once" },
    ] } });
  } else if (message.id === "perm-1" && message.method === undefined) {
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: current.mode + " " + current.model + " " + message.result.outcome.optionId } } } });
    send({ id: turn, result: { stopReason: "end_turn" } });
  }
});
`;

describe("what the pane's command sets on a session", () => {
  it("reads Claude's options", () => {
    expect(claudeLaunchSettings("claude --dangerously-skip-permissions")).toEqual({ options: { mode: "bypassPermissions" } });
    expect(claudeLaunchSettings("claude --permission-mode=plan --dangerously-skip-permissions --model opus --effort xhigh --agent reviewer"))
      .toEqual({ options: { mode: "plan", model: "opus", effort: "xhigh", agent: "reviewer" } });
    expect(claudeLaunchSettings("claude --allow-dangerously-skip-permissions")).toBeUndefined();
    expect(claudeLaunchSettings("claude")).toBeUndefined();
  });

  it("reads Kiro's, with its default agent where the command names none", () => {
    const none = () => undefined;
    expect(kiroLaunchSettings("kiro-cli chat -a", none)).toEqual({ allowAll: true });
    expect(kiroLaunchSettings("kiro-cli chat --trust-all-tools --agent spec --model claude-sonnet-4.5", none))
      .toEqual({ options: { mode: "spec", model: "claude-sonnet-4.5" }, allowAll: true });
    expect(kiroLaunchSettings("kiro-cli chat", none)).toBeUndefined();
    // A prompt after -- is not the command's options.
    expect(kiroLaunchSettings("kiro-cli chat -- -a", none)).toBeUndefined();
    const defaults = (key: string) => key === "chat.defaultAgent" ? "agents-reporting" : undefined;
    expect(kiroLaunchSettings("kiro-cli chat -a", defaults)).toEqual({ options: { mode: "agents-reporting" }, allowAll: true });
    expect(kiroLaunchSettings("kiro-cli chat --agent=plan", defaults)).toEqual({ options: { mode: "plan" } });
  });

  it("reads OpenCode's", () => {
    expect(opencodeLaunchSettings("opencode --auto -m anthropic/claude-opus --agent plan"))
      .toEqual({ options: { mode: "plan", model: "anthropic/claude-opus" }, allowAll: true });
    expect(opencodeLaunchSettings("opencode")).toBeUndefined();
  });

  it("is each hand-off agent's entry", () => {
    expect(ACP_AGENTS["claude-acp"].launchSettings?.("claude --dangerously-skip-permissions")).toEqual({ options: { mode: "bypassPermissions" } });
    expect(ACP_AGENTS.opencode.launchSettings?.("opencode --auto")).toEqual({ allowAll: true });
    expect(ACP_AGENTS.kiro.launchSettings?.("kiro-cli chat -a")?.allowAll).toBe(true);
  });

  it("allows once where the agent offers it, else always, and never rejects", () => {
    expect(allowOption([{ optionId: "a", kind: "allow_always" }, { optionId: "o", kind: "allow_once" }])).toBe("o");
    expect(allowOption([{ optionId: "a", kind: "allow_always" }, { optionId: "r", kind: "reject_once" }])).toBe("a");
    expect(allowOption([{ optionId: "r", kind: "reject_once" }])).toBeUndefined();
    expect(allowOption(undefined)).toBeUndefined();
  });
});

describe("a setting on a session that opened", () => {
  const opened = {
    configOptions: [
      { id: "mode", category: "mode", currentValue: "vibe", options: [{ value: "vibe", name: "Vibe" }, { value: "agents-reporting", name: "agents-reporting" }] },
      { id: "model", category: "model", currentValue: "auto", options: [{ group: "x", options: [{ value: "auto", name: "Auto" }, { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" }] }] },
      { id: "effort", category: "thought_level", currentValue: "high", options: [{ value: "high" }, { value: "max" }] },
    ],
  };

  it("is its config option, found by id or category, its value by value or name", () => {
    expect(settingRequest("mode", "agents-reporting", opened)).toEqual({ method: "session/set_config_option", configId: "mode", value: "agents-reporting" });
    expect(settingRequest("model", "Claude Sonnet 4.5", opened)).toEqual({ method: "session/set_config_option", configId: "model", value: "claude-sonnet-4.5" });
    expect(settingRequest("effort", "MAX", opened)).toEqual({ method: "session/set_config_option", configId: "effort", value: "max" });
  });

  it("is nothing when the session has it already, and missing when the agent has no such value or setting", () => {
    expect(settingRequest("mode", "vibe", opened)).toBeUndefined();
    expect(settingRequest("model", "gpt-9", opened)).toEqual({ missing: "model gpt-9 is not one the agent offers" });
    expect(settingRequest("agent", "reviewer", opened)).toEqual({ missing: "the agent offers no agent setting" });
  });

  it("is a mode where the agent has modes alone", () => {
    const modes = { modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "bypassPermissions" }] } };
    expect(settingRequest("mode", "bypassPermissions", modes)).toEqual({ method: "session/set_mode", modeId: "bypassPermissions" });
    expect(settingRequest("mode", "default", modes)).toBeUndefined();
  });

  it("is the session's model where the agent offers its models in a models field (Kiro's v2 engine)", () => {
    const models = { models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "auto" }, { modelId: "claude-haiku-4.5", name: "claude-haiku-4.5" }] } };
    expect(settingRequest("model", "Claude-Haiku-4.5", models)).toEqual({ method: "session/set_model", modelId: "claude-haiku-4.5" });
    expect(settingRequest("model", "auto", models)).toBeUndefined();
    expect(settingRequest("model", "gpt-9", models)).toEqual({ missing: "model gpt-9 is not one the agent offers" });
  });

  it("sets the model on the session and tells the view, which the agent does not", () => {
    const toAgent: string[] = [];
    const toView: string[] = [];
    const settings = new AcpLaunchSettingsApplier({ options: { model: "claude-haiku-4.5" } }, (line) => toAgent.push(line), () => {}, (line) => toView.push(line));
    settings.clientLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/r", mcpServers: [] } }));
    const opened = { sessionId: "s1", models: { currentModelId: "auto", availableModels: [{ modelId: "auto" }, { modelId: "claude-haiku-4.5" }] } };
    expect(settings.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: opened }))).toBe(false);
    const request = JSON.parse(toAgent[0]);
    expect(request).toMatchObject({ method: "session/set_model", params: { sessionId: "s1", modelId: "claude-haiku-4.5" } });
    expect(settings.agentLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }))).toBe(true);
    expect(JSON.parse(toView[0])).toEqual({ jsonrpc: "2.0", method: "_agents/current_model", params: { sessionId: "s1", modelId: "claude-haiku-4.5" } });
  });
});

describe("the settings on an adapter's channel", () => {
  it("answers a permission request itself and lets everything else through", () => {
    const sent: string[] = [];
    const settings = new AcpLaunchSettingsApplier({ allowAll: true }, (line) => sent.push(line));
    const ask = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { options: [{ optionId: "yes", kind: "allow_once" }] } });
    expect(settings.agentLine(ask)).toBe(true);
    expect(JSON.parse(sent[0])).toEqual({ jsonrpc: "2.0", id: 5, result: { outcome: { outcome: "selected", optionId: "yes" } } });
    expect(settings.agentLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }))).toBe(false);
    // A question with nothing to allow is the person's.
    expect(settings.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "session/request_permission", params: { options: [{ optionId: "no", kind: "reject_once" }] } }))).toBe(false);
  });

  it("sets what the command picks on a session that opens otherwise, keeps the answers and tells the view", () => {
    const sent: string[] = [];
    const told: string[] = [];
    const settings = new AcpLaunchSettingsApplier({ options: { mode: "bypassPermissions", model: "opus" } }, (line) => sent.push(line), undefined, (line) => told.push(line));
    const options = [{ id: "mode", category: "mode", currentValue: "default", options: [{ value: "default" }, { value: "bypassPermissions" }] }];
    settings.clientLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s1" } }));
    expect(settings.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { configOptions: options } }))).toBe(false);
    // The agent has no model setting: only the mode is asked for.
    expect(sent.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: "agents-host-launch-1", method: "session/set_config_option", params: { sessionId: "s1", configId: "mode", value: "bypassPermissions" } },
    ]);
    const now = [{ ...options[0], currentValue: "bypassPermissions" }];
    expect(settings.agentLine(JSON.stringify({ jsonrpc: "2.0", id: "agents-host-launch-1", result: { configOptions: now } }))).toBe(true);
    expect(told.map((line) => JSON.parse(line).params.update)).toEqual([
      { sessionUpdate: "config_option_update", configOptions: now },
      { sessionUpdate: "current_mode_update", currentModeId: "bypassPermissions" },
    ]);
    // It answers no permission request: in its mode the agent decides what still asks.
    expect(settings.agentLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/request_permission", params: { options: [{ optionId: "o", kind: "allow_once" }] } }))).toBe(false);
  });
});

describe("a host whose pane command sets the session", () => {
  async function viewTurn(settings: AcpLaunchSettings) {
    const dir = mkdtempSync(join(tmpdir(), "acp-launch-"));
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html>");
    const host = await startAcpHost({
      paneId: "%7",
      agent: { id: "test-acp", name: "Test" },
      runtimeTempDir: join(dir, "rt"),
      webRoot: join(dir, "web"),
      cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT], env: process.env },
      launchSettings: settings,
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
      send({ id: 2, method: "session/load", params: { sessionId: "s1", cwd: dir, mcpServers: [] } });
      await next((message) => message.id === 2);
      send({ id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "go" }] } });
      let asked = false;
      if (!settings.allowAll) {
        const ask = await next((message) => message.method === "session/request_permission");
        asked = true;
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
    .map((message) => (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } } | undefined)?.update)
    .filter((update) => update?.sessionUpdate === "agent_message_chunk")
    .map((update) => update!.content?.text);

  it("allows the view's tool calls itself: the view is never asked", async () => {
    const { received, asked } = await viewTurn({ allowAll: true });
    expect(asked).toBe(false);
    expect(said(received)).toEqual(["default sonnet once"]);
  });

  it("runs the view's first turn with the command's settings, which the view's pickers show", async () => {
    const { received, asked } = await viewTurn({ options: { mode: "bypassPermissions", model: "Opus" } });
    expect(said(received)).toEqual(["bypassPermissions opus once"]);
    const shown = received
      .map((message) => (message.params as { update?: { sessionUpdate?: string; configOptions?: Array<{ id: string; currentValue: string }> } } | undefined)?.update)
      .filter((update) => update?.sessionUpdate === "config_option_update")
      .at(-1)?.configOptions?.map((option) => [option.id, option.currentValue]);
    expect(shown).toEqual([["mode", "bypassPermissions"], ["model", "opus"]]);
    // The host's own requests are answered to the host.
    expect(received.some((message) => typeof message.id === "string" && message.id.startsWith("agents-host-launch"))).toBe(false);
    expect(asked).toBe(true);
  });

  it("lets a view turn allowing every tool call on and off where the agent offers it, and tells every view", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-allow-"));
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html>");
    const host = await startAcpHost({
      paneId: "%8",
      agent: { id: "test-acp", name: "Test" },
      runtimeTempDir: join(dir, "rt"),
      webRoot: join(dir, "web"),
      cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT], env: process.env },
      offersAllowAll: true,
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
      send({ id: 1, method: "_agents/allow_all", params: {} });
      expect((await next((message) => message.id === 1)).result).toEqual({ offered: true, allowAll: false });
      send({ id: 2, method: "session/new", params: { cwd: dir, mcpServers: [] } });
      await next((message) => message.id === 2);
      send({ id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "go" }] } });
      const ask = await next((message) => message.method === "session/request_permission");
      send({ id: ask.id as string, result: { outcome: { outcome: "selected", optionId: "no" } } });
      await next((message) => message.id === 3);

      send({ id: 4, method: "_agents/allow_all", params: { allowAll: true } });
      expect((await next((message) => message.id === 4)).result).toEqual({ offered: true, allowAll: true });
      expect(await next((message) => message.method === "_agents/allow_all")).toMatchObject({ params: { offered: true, allowAll: true } });
      const asked = received.filter((message) => message.method === "session/request_permission").length;
      send({ id: 5, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "go" }] } });
      await next((message) => message.id === 5);
      expect(received.filter((message) => message.method === "session/request_permission")).toHaveLength(asked);
      expect(said(received)).toEqual(["default sonnet no", "default sonnet once"]);
    } finally {
      ws.close();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offers no switch for an agent without it, and says so instead of asking the agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-allow-"));
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "index.html"), "<!doctype html>");
    const host = await startAcpHost({
      paneId: "%9",
      agent: { id: "test-acp", name: "Test" },
      runtimeTempDir: join(dir, "rt"),
      webRoot: join(dir, "web"),
      cwd: dir,
      agentCommand: { command: process.execPath, args: ["-e", AGENT], env: process.env },
    });
    const ws = new WebSocket(`${host.url.replace("http", "ws")}/acp?token=${encodeURIComponent(host.token)}`, { headers: { Origin: host.url } });
    try {
      await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      const answer = new Promise<Record<string, unknown>>((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>)));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_agents/allow_all", params: { allowAll: true } }));
      expect((await answer).result).toEqual({ offered: false, allowAll: false });
    } finally {
      ws.close();
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets the session the host holds, and a view that loads it later sees its settings", async () => {
    const child = spawn(process.execPath, ["-e", AGENT], { stdio: ["pipe", "pipe", "pipe"] });
    const session = new HostedSession(child, { launchSettings: { options: { mode: "bypassPermissions", model: "opus" } } });
    try {
      expect(await session.start("/tmp")).toBe("s1");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const received: Array<Record<string, unknown>> = [];
      const view = session.attach((line) => received.push(JSON.parse(line) as Record<string, unknown>));
      view.fromView(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId: "s1" } }));
      const loaded = received.find((message) => message.id === 1)?.result as { modes: { currentModeId: string }; configOptions: Array<{ id: string; currentValue: string }> };
      expect(loaded.modes.currentModeId).toBe("bypassPermissions");
      expect(loaded.configOptions.map((option) => [option.id, option.currentValue])).toEqual([["mode", "bypassPermissions"], ["model", "opus"]]);
    } finally {
      await session.stop();
    }

    const allowing = spawn(process.execPath, ["-e", AGENT], { stdio: ["pipe", "pipe", "pipe"] });
    const allowed = new HostedSession(allowing, { launchSettings: { allowAll: true } });
    try {
      await allowed.start("/tmp");
      expect(await allowed.prompt("go")).toBe("end_turn");
    } finally {
      await allowed.stop();
    }
  });
});
