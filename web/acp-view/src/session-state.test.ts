import { describe, expect, it } from "vitest";
import { attention, emptySession, reduce, type SessionAction, type SessionState } from "./session-state";

const run = (actions: SessionAction[], start: SessionState = emptySession()) => actions.reduce(reduce, start);
const text = (t: string) => ({ type: "text" as const, text: t });

describe("session state", () => {
  it("joins chunks of one message and starts a new one on another message id", () => {
    const state = run([
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("Hej "), messageId: "m1" } },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("där"), messageId: "m1" } },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("Nytt"), messageId: "m2" } },
    ]);
    expect(state.items.map((item) => item.type === "agent" && item.text)).toEqual(["Hej där", "Nytt"]);
  });

  it("keeps a tool call by id and merges its updates, timing a live call", () => {
    const state = run([
      { type: "update", at: 1_000, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run tests", kind: "execute", status: "in_progress" } },
      { type: "update", at: 3_500, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: text("ok") }] } },
    ]);
    expect(state.items).toEqual([{ type: "tool", id: "t1", at: 1_000 }]);
    expect(state.toolCalls.t1).toMatchObject({ title: "Run tests", kind: "execute", status: "completed", startedAt: 1_000, endedAt: 3_500 });
    expect(state.toolCalls.t1.content).toHaveLength(1);
  });

  it("gives a replayed history no times", () => {
    const state = run([
      { type: "loading" },
      { type: "update", at: 5, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "completed" } },
      { type: "loaded" },
    ]);
    expect(state.toolCalls.t1.startedAt).toBeUndefined();
    expect(state.replaying).toBe(false);
  });

  it("shows a prompt at once and takes the agent's echo of it as the same message", () => {
    const state = run([
      { type: "promptSent", text: "Kör testerna", at: 10 },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Kör testerna"), messageId: "u1" } },
    ]);
    expect(state.items).toEqual([{ type: "user", id: "u1", text: "Kör testerna", images: 0, local: false, at: 10 }]);
    expect(state.prompting).toBe(true);
  });

  it("needs you while a permission waits, works during a turn, idles after", () => {
    let state = run([{ type: "promptSent", text: "x" }]);
    expect(attention(state)).toBe("working");
    state = reduce(state, { type: "permissionRequested", request: { id: "p1", toolCall: { toolCallId: "t" }, options: [] } });
    expect(attention(state)).toBe("needs-you");
    state = reduce(state, { type: "permissionAnswered", id: "p1" });
    expect(attention(state)).toBe("working");
    state = reduce(state, { type: "promptEnded" });
    expect(attention(state)).toBe("idle");
  });

  it("follows a turn another client runs, as Codex reports it", () => {
    let state = run([{ type: "update", update: { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "active" } } } } }]);
    expect(state.activity).toBe("working");
    state = reduce(state, { type: "update", update: { sessionUpdate: "session_info_update", title: "Fix", _meta: { codex: { threadStatus: { type: "idle" } } } } });
    expect(state.activity).toBe("idle");
    expect(state.title).toBe("Fix");
  });

  it("keeps plans, usage, commands and config options", () => {
    const state = run([
      { type: "update", update: { sessionUpdate: "plan", entries: [{ content: "A", priority: "high", status: "completed" }] } },
      { type: "update", update: { sessionUpdate: "usage_update", used: 10, size: 100 } },
      { type: "update", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review", input: null }] } },
    ]);
    expect(state.plan).toHaveLength(1);
    expect(state.usage).toMatchObject({ used: 10, size: 100 });
    expect(state.commands[0].name).toBe("review");
  });
});
