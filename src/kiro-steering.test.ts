import { describe, expect, it } from "vitest";
import { KiroSteering, steerText } from "./kiro-steering.js";

function setUp() {
  const toAgent: Array<Record<string, unknown>> = [];
  const toClient: Array<Record<string, unknown>> = [];
  const steering = new KiroSteering((line) => toAgent.push(JSON.parse(line)), (line) => toClient.push(JSON.parse(line)));
  const client = (message: Record<string, unknown>) => steering.clientLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const agent = (message: Record<string, unknown>) => {
    const passed = steering.agentLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
    return passed === undefined ? undefined : JSON.parse(passed) as Record<string, unknown>;
  };
  const steer = (id: number, text = "Use tabs") => client({
    id, method: "_session/steering",
    params: { sessionId: "s", prompt: [{ type: "text", text }], _meta: { steering: { idleBehavior: "promptRequired" } } },
  });
  return { steering, toAgent, toClient, client, agent, steer };
}

describe("Kiro steering", () => {
  it("says Kiro takes steering in its initialize answer", () => {
    const { client, agent } = setUp();
    expect(client({ id: 1, method: "initialize", params: {} })).toBe(false);
    const answer = agent({ id: 1, result: { protocolVersion: 1, _meta: { kiro: { checkpoints: true } } } });
    expect(answer?.result).toEqual({ protocolVersion: 1, _meta: { kiro: { checkpoints: true }, steering: { supported: true } } });
  });

  it("steers the running turn with Kiro's own request", () => {
    const { client, agent, steer, toAgent, toClient } = setUp();
    client({ id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [] } });
    expect(steer(3)).toBe(true);
    expect(toAgent).toEqual([{ jsonrpc: "2.0", id: "kiro-steer-1", method: "_session/steer", params: { sessionId: "s", message: "Use tabs" } }]);
    expect(agent({ id: "kiro-steer-1", result: { queued: true, messageId: "steer-1" } })).toBeUndefined();
    expect(toClient).toEqual([{ jsonrpc: "2.0", id: 3, result: { outcome: "steered" } }]);
  });

  it("asks for a prompt when no turn runs, without asking Kiro", () => {
    const { steer, toAgent, toClient } = setUp();
    steer(3);
    expect(toAgent).toEqual([]);
    expect(toClient).toEqual([{ jsonrpc: "2.0", id: 3, result: { outcome: "promptRequired" } }]);
  });

  it("takes a steer back that Kiro queued after the turn ended, and asks for a prompt", () => {
    const { client, agent, steer, toAgent, toClient } = setUp();
    client({ id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [] } });
    steer(3);
    agent({ id: 2, result: { stopReason: "end_turn" } });
    agent({ id: "kiro-steer-1", result: { queued: true } });
    expect(toAgent[1]).toEqual({ jsonrpc: "2.0", id: "kiro-steer-2", method: "_session/steer/clear", params: { sessionId: "s" } });
    expect(agent({ id: "kiro-steer-2", result: {} })).toBeUndefined();
    expect(toClient).toEqual([{ jsonrpc: "2.0", id: 3, result: { outcome: "promptRequired" } }]);
  });

  it("counts a steer the turn took before it ended as steered (v3 and v2 notices)", () => {
    for (const injected of [
      { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: { kiro: { kind: "steering_injected", messageId: "steer-1" } } } } },
      { method: "_kiro.dev/session/update", params: { sessionId: "s", update: { sessionUpdate: "AgentExecutionSteeringInjected", messageId: "steer-1" } } },
    ]) {
      const { client, agent, steer, toClient } = setUp();
      client({ id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [] } });
      steer(3);
      expect(agent(injected)).toEqual({ jsonrpc: "2.0", ...injected });
      agent({ id: 2, result: { stopReason: "end_turn" } });
      agent({ id: "kiro-steer-1", result: { queued: true } });
      expect(toClient).toEqual([{ jsonrpc: "2.0", id: 3, result: { outcome: "steered" } }]);
    }
  });

  it("asks for a prompt when Kiro drops the steer, and passes Kiro's error on", () => {
    const { client, agent, steer, toClient } = setUp();
    client({ id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [] } });
    steer(3);
    agent({ id: "kiro-steer-1", result: { queued: false, dropped: "turn ended" } });
    steer(4);
    agent({ id: "kiro-steer-2", error: { code: -32603, message: "Internal error" } });
    expect(toClient).toEqual([
      { jsonrpc: "2.0", id: 3, result: { outcome: "promptRequired" } },
      { jsonrpc: "2.0", id: 4, error: { code: -32603, message: "Internal error" } },
    ]);
  });

  it("steers with text and links, and refuses an image", () => {
    expect(steerText([{ type: "text", text: "See" }, { type: "resource_link", uri: "file:///r/a.ts", name: "a.ts" }])).toBe("See\nfile:///r/a.ts");
    expect(steerText([{ type: "image", data: "AAAA", mimeType: "image/png" }])).toBeUndefined();
    const { client, steer, toClient } = setUp();
    client({ id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [] } });
    client({ id: 3, method: "_session/steering", params: { sessionId: "s", prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } });
    expect(toClient[0]).toMatchObject({ id: 3, error: { code: -32602 } });
    steer(4);
  });

  it("leaves other messages as they are", () => {
    const { client, agent } = setUp();
    expect(client({ id: 5, method: "session/load", params: { sessionId: "s" } })).toBe(false);
    expect(agent({ id: 5, result: { modes: null } })).toEqual({ jsonrpc: "2.0", id: 5, result: { modes: null } });
  });
});
