import { describe, expect, it } from "vitest";
import { attention, emptySession, reduce, shownMessage, type SessionAction, type SessionState } from "./session-state";

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

  it("takes our prompt as delivered once the agent answers, though it never echoes it (Kiro)", () => {
    const state = run([
      { type: "promptSent", blocks: [text("Kör")], at: 5 },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("Ok"), messageId: "m1" } },
    ]);
    expect(state.items[0]).toMatchObject({ type: "user", text: "Kör", local: true, answered: true });
    // A late echo still confirms it rather than adding it twice.
    const echoed = run([{ type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Kör"), messageId: "u1" } }], state);
    expect(echoed.items.filter((item) => item.type === "user")).toHaveLength(1);
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
      { type: "promptSent", blocks: [text("Kör testerna")], at: 10 },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Kör testerna"), messageId: "u1" } },
    ]);
    expect(state.items).toEqual([{ type: "user", id: "u1", text: "Kör testerna", attachments: [], unechoed: 0, local: false, at: 10 }]);
    expect(state.prompting).toBe(true);
  });

  it("needs you while a permission waits, works during a turn, idles after", () => {
    let state = run([{ type: "promptSent", blocks: [text("x")] }]);
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

  it("keeps the session's cost through usage updates that carry none", () => {
    const state = run([
      { type: "update", update: { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.4, currency: "USD" } } },
      { type: "update", update: { sessionUpdate: "usage_update", used: 20, size: 100 } },
    ]);
    expect(state.usage).toEqual({ used: 20, size: 100, cost: { amount: 0.4, currency: "USD" } });
  });

  it("takes Copilot's update_todo checklist as the plan", () => {
    const state = run([
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Update todo", kind: "think", status: "pending", rawInput: { todos: "- [x] Read\n- [ ] Fix" } } },
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "ls", kind: "execute", status: "pending", rawInput: { command: "ls" } } },
    ]);
    expect(state.plan.map((entry) => [entry.content, entry.status])).toEqual([["Read", "completed"], ["Fix", "pending"]]);
  });
});

describe("the agent's own state", () => {
  it("makes a turn the pane's TUI runs work in the view too, and nothing else", () => {
    let state = reduce(emptySession(), { type: "agentState", state: "working" });
    expect(attention(state)).toBe("working");
    state = reduce(state, { type: "agentState", state: "approval" });
    expect(attention(state)).toBe("working");
    state = reduce(state, { type: "agentState", state: "idle" });
    expect(attention(state)).toBe("idle");
    state = reduce(state, { type: "agentState", state: null });
    expect(attention(state)).toBe("idle");
  });
});

describe("a turn the pane's TUI starts", () => {
  const active = { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "active" } } } } as never;
  const idle = { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "idle" } } } } as never;
  const tool = { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute", status: "in_progress" } as never;
  const prompt = { sessionUpdate: "user_message_chunk", content: { type: "text", text: "from the tui" } } as never;

  it("gets a marker of where it began when its prompt does not come, before its first work", () => {
    let state = reduce(emptySession(), { type: "update", update: active, at: 1 });
    expect(attention(state)).toBe("working");
    expect(state.items).toEqual([]);
    state = reduce(state, { type: "update", update: tool, at: 2 });
    expect(state.items.map((item) => item.type)).toEqual(["user", "tool"]);
    expect(state.items[0]).toMatchObject({ external: true, at: 2 });
  });

  it("starts with its own prompt when Codex passes it on, before or after saying the thread is active", () => {
    let after = reduce(emptySession(), { type: "update", update: active, at: 1 });
    after = reduce(after, { type: "update", update: prompt, at: 2 });
    after = reduce(after, { type: "update", update: tool, at: 3 });
    expect(after.items.map((item) => item.type === "user" && item.external ? "external" : item.type)).toEqual(["user", "tool"]);
    let before = reduce(emptySession(), { type: "update", update: prompt, at: 1 });
    before = reduce(before, { type: "update", update: active, at: 2 });
    before = reduce(before, { type: "update", update: tool, at: 3 });
    expect(before.items.map((item) => item.type === "user" && item.external ? "external" : item.type)).toEqual(["user", "tool"]);
  });

  it("gets no marker when Codex says the thread is active after the turn's first events", () => {
    let state = reduce(emptySession(), { type: "update", update: prompt, at: 1 });
    state = reduce(state, { type: "update", update: tool, at: 2 });
    state = reduce(state, { type: "update", update: active, at: 3 });
    state = reduce(state, { type: "update", update: { ...(tool as object), sessionUpdate: "tool_call_update", status: "completed" } as never, at: 4 });
    expect(state.items.filter((item) => item.type === "user" && item.external)).toHaveLength(0);
    // The next turn, after the thread was idle, starts afresh.
    state = reduce(state, { type: "update", update: idle, at: 5 });
    state = reduce(state, { type: "update", update: active, at: 6 });
    state = reduce(state, { type: "update", update: { ...(tool as object), toolCallId: "t2" } as never, at: 7 });
    expect(state.items.filter((item) => item.type === "user" && item.external)).toHaveLength(1);
  });

  it("gets no marker for a turn of ours", () => {
    let state = reduce(emptySession(), { type: "promptSent", blocks: [text("hi")], at: 1 });
    state = reduce(state, { type: "update", update: active, at: 2 });
    state = reduce(state, { type: "update", update: tool, at: 3 });
    state = reduce(state, { type: "update", update: idle, at: 4 });
    expect(state.items.filter((item) => item.type === "user" && item.external)).toHaveLength(0);
  });
});

describe("a turn the view stops", () => {
  it("is marked stopped by its user item, once", () => {
    let state = reduce(emptySession(), { type: "promptSent", blocks: [text("go")], at: 1 });
    const id = state.items[0].id;
    state = reduce(state, { type: "stopped" });
    state = reduce(state, { type: "stopped" });
    expect(state.stoppedTurns).toEqual([id]);
  });
});

describe("what the agent sends besides text", () => {
  it("shows a resource link as a link in its text and keeps an image under it", () => {
    let state = reduce(emptySession(), { type: "update", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "See" } } });
    state = reduce(state, { type: "update", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "resource_link", uri: "file:///r/shot.png", name: "shot.png" } } });
    state = reduce(state, { type: "update", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "image", mimeType: "image/png", data: "AAAA" } } });
    expect(state.items).toEqual([{ type: "agent", id: "m1", text: "See [shot.png](file:///r/shot.png) ", images: [{ mimeType: "image/png", data: "AAAA" }] }]);
  });
});

describe("a turn the terminal started", () => {
  it("shows the line the agents CLI typed into the terminal", () => {
    let state = reduce(emptySession(), { type: "typedInTerminal", text: "⟢ agents · Worker ui is done · read /p/m.md", at: 1000 });
    state = reduce(state, { type: "update", update: { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "active" } } } } as never, at: 1500 });
    state = reduce(state, { type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it" } }, at: 2000 });
    expect(state.items[0]).toMatchObject({ type: "user", external: true, text: "⟢ agents · Worker ui is done · read /p/m.md" });
    expect(state.typedInTerminal).toBeUndefined();
  });

  it("keeps the images and files sent with a prompt, and the agent's echo of them adds none", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: "AAAA" };
    const link = { type: "resource_link" as const, uri: "file:///tmp/agents/Pasted%20notes.pdf", name: "Pasted notes.pdf" };
    const mention = { type: "resource_link" as const, uri: "file:///r/src/app.ts", name: "app.ts" };
    const state = run([
      { type: "promptSent", blocks: [text("Titta på @src/app.ts"), mention, image, link], at: 10 },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Titta på @src/app.ts"), messageId: "u1" } },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: mention, messageId: "u1" } },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: image, messageId: "u1" } },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: link, messageId: "u1" } },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      type: "user", id: "u1", text: "Titta på @src/app.ts", local: false,
      attachments: [
        { kind: "image", name: "", mimeType: "image/png", data: "AAAA" },
        { kind: "file", name: "Pasted notes.pdf", path: "/tmp/agents/Pasted notes.pdf" },
      ],
    });
  });

  it("shows the images of a message replayed from the history, and an image-only message", () => {
    const state = run([
      { type: "loading" },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Vad är detta?"), messageId: "u1" } },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "AAAA" }, messageId: "u1" } },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("En katt"), messageId: "m1" } },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/jpeg", data: "BBBB" }, messageId: "u2" } },
      { type: "loaded" },
    ]);
    const users = state.items.filter((item) => item.type === "user");
    expect(users).toMatchObject([
      { text: "Vad är detta?", attachments: [{ kind: "image", data: "AAAA" }] },
      { text: "", attachments: [{ kind: "image", mimeType: "image/jpeg", data: "BBBB" }] },
    ]);
  });

  it("shows the file and image links an agent keeps in its history as attachments, not text", () => {
    // Claude keeps an attached file as a link in the text; Codex an image as a data link and an
    // embedded file as its link and a <context> block. A mention's link is the mention's.
    const shown = shownMessage(
      "Jämför @src/app.ts [@app.ts](file:///r/src/app.ts) [@shot.png](file:///tmp/agents/shot.png)\n[@image](data:image/png;base64,AAAA)\n"
        + "[@notes.md](file:///r/notes.md)\n<context ref=\"file:///r/notes.md\">\n# Notes\n</context>",
      [{ kind: "image", name: "", mimeType: "image/png", data: "AAAA" }],
    );
    expect(shown.text).toBe("Jämför @src/app.ts");
    expect(shown.attachments).toEqual([
      { kind: "image", name: "", mimeType: "image/png", data: "AAAA" },
      { kind: "image", name: "shot.png", path: "/tmp/agents/shot.png" },
      { kind: "file", name: "notes.md", path: "/r/notes.md" },
    ]);
  });
});
