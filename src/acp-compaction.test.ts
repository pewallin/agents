import { describe, expect, it } from "vitest";
import { AcpCompaction, COMPACTION_TITLE, compactPrompt, compactionWay, type CompactionWay } from "./acp-compaction.js";

function setUp(way: CompactionWay = "kiro") {
  const toAgent: Array<Record<string, unknown>> = [];
  const toClient: Array<Record<string, unknown>> = [];
  const compaction = new AcpCompaction(way, (line) => toAgent.push(JSON.parse(line)), (line) => toClient.push(JSON.parse(line)));
  const client = (message: Record<string, unknown>) => compaction.clientLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const agent = (message: Record<string, unknown>) => {
    const passed = compaction.agentLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
    return passed === undefined ? undefined : JSON.parse(passed) as Record<string, unknown>;
  };
  const prompt = (id: number, text: string) => client({ id, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text }] } });
  const updates = () => toClient.filter((message) => message.method === "session/update").map((message) => (message.params as { update: Record<string, unknown> }).update);
  const answers = () => toClient.filter((message) => message.method === undefined);
  return { toAgent, toClient, client, agent, prompt, updates, answers };
}

const commandsUpdate = (availableCommands: unknown[]) => ({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "available_commands_update", availableCommands } } });

describe("compactPrompt", () => {
  it("reads /compact and what follows it", () => {
    expect(compactPrompt([{ type: "text", text: "/compact" }])).toEqual({ instructions: "" });
    expect(compactPrompt([{ type: "text", text: " /compact keep the plan\n and the files " }])).toEqual({ instructions: "keep the plan\n and the files" });
    expect(compactPrompt([{ type: "text", text: "/compaction" }])).toBeUndefined();
    expect(compactPrompt([{ type: "text", text: "please /compact" }])).toBeUndefined();
    expect(compactPrompt([{ type: "text", text: "/compact" }, { type: "image", data: "" }])).toBeUndefined();
  });

  it("is the host's for Kiro and OpenCode only", () => {
    expect(compactionWay("kiro")).toBe("kiro");
    expect(compactionWay("opencode")).toBe("opencode");
    expect(compactionWay("claude-acp")).toBeUndefined();
    expect(compactionWay("codex-acp")).toBeUndefined();
  });
});

describe("compaction commands", () => {
  it("adds compact to the commands the agent lists", () => {
    const { agent } = setUp();
    const update = agent(commandsUpdate([{ name: "context-gatherer", description: "" }])) as { params: { update: { availableCommands: Array<{ name: string }> } } };
    expect(update.params.update.availableCommands.map((command) => command.name)).toEqual(["context-gatherer", "compact"]);
  });

  it("leaves a list that has compact as it is", () => {
    const { agent } = setUp("opencode");
    const update = agent(commandsUpdate([{ name: "compact", description: "theirs" }])) as { params: { update: { availableCommands: unknown[] } } };
    expect(update.params.update.availableCommands).toEqual([{ name: "compact", description: "theirs" }]);
  });

  it("lists compact for a session whose agent lists no commands (Kiro v2)", async () => {
    const { client, agent, updates } = setUp();
    client({ id: 1, method: "session/new", params: { cwd: "/", mcpServers: [] } });
    agent({ id: 1, result: { sessionId: "s" } });
    expect(updates()).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(updates()).toEqual([{ sessionUpdate: "available_commands_update", availableCommands: [expect.objectContaining({ name: "compact" })] }]);
  });

  it("does not list compact again for a session whose agent listed its commands", async () => {
    const { client, agent, updates } = setUp();
    client({ id: 1, method: "session/load", params: { sessionId: "s", cwd: "/", mcpServers: [] } });
    agent(commandsUpdate([]));
    agent({ id: 1, result: {} });
    await new Promise((resolve) => setImmediate(resolve));
    expect(updates()).toEqual([]);
  });
});

describe("Kiro compaction", () => {
  it("compacts with v3's request and answers the prompt once the summary is written", () => {
    const { prompt, agent, toAgent, updates, answers } = setUp();
    expect(prompt(5, "/compact keep the plan")).toBe(true);
    expect(toAgent).toEqual([{ jsonrpc: "2.0", id: "kiro-compact-2", method: "_kiro/session/compact", params: { sessionId: "s", value: "keep the plan" } }]);
    expect(updates()).toEqual([{ sessionUpdate: "tool_call", toolCallId: "compact-1", title: COMPACTION_TITLE, kind: "think", status: "in_progress" }]);
    const summary = { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "summarization_completed", conversationSummary: "## Goal\nShip it" } } } } };
    expect(agent(summary)).toEqual({ jsonrpc: "2.0", ...summary });
    expect(agent({ id: "kiro-compact-2", result: { success: true } })).toBeUndefined();
    expect(updates()[1]).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "compact-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "## Goal\nShip it" } }] });
    expect(answers()).toEqual([{ jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } }]);
  });

  it("falls back to v2's command, and finishes on its status notice", () => {
    const { prompt, agent, toAgent, updates, answers } = setUp();
    prompt(5, "/compact");
    agent({ id: "kiro-compact-2", error: { code: -32601, message: "Method not found" } });
    expect(toAgent[1]).toEqual({ jsonrpc: "2.0", id: "kiro-compact-3", method: "_kiro.dev/commands/execute", params: { sessionId: "s", command: { command: "compact", args: {} } } });
    expect(agent({ id: "kiro-compact-3", result: { success: true, message: "Compacting conversation..." } })).toBeUndefined();
    expect(answers()).toEqual([]);
    agent({ method: "_kiro.dev/compaction/status", params: { sessionId: "s", status: { type: "started" }, summary: null } });
    expect(answers()).toEqual([]);
    agent({ method: "_kiro.dev/compaction/status", params: { sessionId: "s", status: { type: "completed" }, summary: "## OBJECTIVE\nShip it" } });
    expect(updates()[1]).toEqual(expect.objectContaining({ status: "completed", content: [{ type: "content", content: { type: "text", text: "## OBJECTIVE\nShip it" } }] }));
    expect(answers()).toEqual([{ jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } }]);
    // The engine is known now: the next compaction asks v2 at once.
    prompt(6, "/compact");
    expect(toAgent[2]).toEqual(expect.objectContaining({ method: "_kiro.dev/commands/execute" }));
  });

  it("shows why Kiro did not compact as the step's failure", () => {
    const { prompt, agent, updates, answers } = setUp();
    prompt(5, "/compact");
    agent({ id: "kiro-compact-2", error: { code: -32601, message: "Method not found" } });
    agent({ id: "kiro-compact-3", result: { success: false, message: "Conversation too short to compact." } });
    expect(updates()[1]).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "compact-1", status: "failed", content: [{ type: "content", content: { type: "text", text: "Conversation too short to compact." } }] });
    expect(answers()).toEqual([{ jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } }]);
  });

  it("answers a stopped compaction as cancelled", () => {
    const { prompt, client, agent, answers, updates } = setUp();
    prompt(5, "/compact");
    expect(client({ method: "session/cancel", params: { sessionId: "s" } })).toBe(false);
    expect(answers()).toEqual([{ jsonrpc: "2.0", id: 5, result: { stopReason: "cancelled" } }]);
    expect(updates()[1]).toEqual(expect.objectContaining({ status: "failed" }));
    // Kiro's late answer goes nowhere.
    expect(agent({ id: "kiro-compact-2", result: { success: true } })).toBeUndefined();
    expect(answers()).toHaveLength(1);
  });

  it("passes other prompts on", () => {
    const { prompt, toAgent, toClient } = setUp();
    expect(prompt(5, "compact the code please")).toBe(false);
    expect(prompt(6, "/compaction")).toBe(false);
    expect(toAgent).toEqual([]);
    expect(toClient).toEqual([]);
  });
});

describe("OpenCode compaction", () => {
  it("lets OpenCode run /compact and shows it as a step", () => {
    const { prompt, agent, toAgent, updates } = setUp("opencode");
    expect(prompt(5, "/compact")).toBe(false);
    expect(toAgent).toEqual([]);
    expect(updates()).toEqual([{ sessionUpdate: "tool_call", toolCallId: "compact-1", title: COMPACTION_TITLE, kind: "think", status: "in_progress" }]);
    const chunk = (sessionUpdate: string, text: string) => agent({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate, content: { type: "text", text } } } });
    expect(chunk("agent_thought_chunk", "I should follow the template")).toBeUndefined();
    expect(chunk("agent_message_chunk", "## Objective\n")).toBeUndefined();
    expect(chunk("agent_message_chunk", "- Ship it")).toBeUndefined();
    expect(agent({ id: 5, result: { stopReason: "end_turn" } })).toEqual({ jsonrpc: "2.0", id: 5, result: { stopReason: "end_turn" } });
    expect(updates()[1]).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "compact-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "## Objective\n- Ship it" } }] });
    prompt(6, "/compact");
    agent({ id: 6, result: { stopReason: "cancelled" } });
    expect(updates()[3]).toEqual(expect.objectContaining({ toolCallId: "compact-2", status: "failed" }));
    // The next answer is an answer again.
    expect(chunk("agent_message_chunk", "hi")).toEqual(expect.objectContaining({ method: "session/update" }));
  });
});
