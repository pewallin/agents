import { describe, expect, it } from "vitest";
import { emptySession, reduce, type SessionAction } from "./session-state";
import { buildTurns, changesOf, conversationChanges, countLines, describeCall, duration, oneLine, shortPath } from "./turns";
import { commentsMessage, diffRows } from "./review";

const text = (t: string) => ({ type: "text" as const, text: t });

describe("the activity trail", () => {
  it("leaves out blank thinking and keeps one blank line between paragraphs", () => {
    const actions: SessionAction[] = [
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Count rows"), messageId: "u1" } },
      { type: "update", update: { sessionUpdate: "agent_thought_chunk", content: text("**Checking row counts**\n\n\n\nThen sum them.") } },
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "completed", rawInput: { command: "ls" } } },
      { type: "update", update: { sessionUpdate: "agent_thought_chunk", content: text("   \n ") } },
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "wc", kind: "execute", status: "completed", rawInput: { command: "wc -l" } } },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("12 rows.") } },
    ];
    const state = actions.reduce(reduce, emptySession());
    const [turn] = buildTurns(state);
    expect(turn.steps.map((step) => step.type)).toEqual(["thought", "tool", "tool"]);
    expect(turn.steps[0]).toMatchObject({ text: "**Checking row counts**\n\nThen sum them." });
  });

  it("shows a long command on one line, cut at a character with an ellipsis", () => {
    const command = "python3 - <<'PY'\nimport os\nprint('👩‍👩‍👧‍👦' * 3)\nPY";
    expect(oneLine(command, 400)).toBe("python3 - <<'PY' import os print('👩‍👩‍👧‍👦' * 3) PY");
    const cut = oneLine("x".repeat(20) + "👩‍👩‍👧‍👦" + "y".repeat(20), 21);
    expect(cut).toBe(`${"x".repeat(20)}👩‍👩‍👧‍👦…`);
  });
});

describe("turns", () => {
  it("splits the session at what you wrote; remarks before more work join the steps, the last words are the answer", () => {
    const actions: SessionAction[] = [
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Lägg till --json"), messageId: "u1" } },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("Jag tittar."), messageId: "a1" } },
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit", kind: "edit", status: "completed",
        content: [{ type: "diff", path: "/repo/src/status.ts", oldText: "a\nb\n", newText: "a\nB\nc\n" }] } },
      { type: "update", update: { sessionUpdate: "agent_message_chunk", content: text("Klart."), messageId: "a2" } },
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Tack"), messageId: "u2" } },
    ];
    const turns = buildTurns(actions.reduce(reduce, emptySession()));
    expect(turns).toHaveLength(2);
    expect(turns[0].steps.map((step) => step.type)).toEqual(["remark", "tool"]);
    expect(turns[0].answer.map((item) => item.text)).toEqual(["Klart."]);
    expect(turns[0].changes).toEqual([expect.objectContaining({ path: "/repo/src/status.ts", added: 2, removed: 1 })]);
    expect(turns[1].user?.text).toBe("Tack");
  });

  it("keeps each change to a file and adds up its lines", () => {
    const call = (id: string, oldText: string | null, newText: string) => ({ id, title: "Edit", kind: "edit" as const, status: "completed" as const, locations: [],
      content: [{ type: "diff" as const, path: "/r/fib.py", oldText, newText }] });
    const [change] = changesOf([call("a", null, "x\n"), call("b", "x\n", "x\ny\n")]);
    expect(change).toMatchObject({ added: 2, removed: 0 });
    expect(change.edits).toHaveLength(2);
  });

  it("names a call by verb and what it acted on", () => {
    expect(describeCall({ id: "t", title: "Run", kind: "execute", status: "completed", content: [], locations: [], rawInput: { command: ["bun", "test"] } }))
      .toEqual({ verb: "Ran", target: "bun test" });
    expect(describeCall({ id: "t", title: "Read file", kind: "read", status: "completed", content: [], locations: [{ path: "/repo/src/a.ts" }] }, "/repo"))
      .toEqual({ verb: "Read", target: "src/a.ts" });
  });

  it("counts lines and writes durations and paths as people read them", () => {
    expect(countLines(null, "x\ny\n")).toEqual({ added: 2, removed: 0 });
    expect(duration(134_000)).toBe("2m 14s");
    expect(duration(12_400)).toBe("12s");
    expect(shortPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });
});

describe("review", () => {
  it("keeps a few lines of context around changes and numbers both sides", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const next = old.replace("l10\n", "L10\n");
    const rows = diffRows(old, next);
    expect(rows.filter((row) => row.kind === "del").map((row) => [row.oldLine, row.text])).toEqual([[10, "l10"]]);
    expect(rows.filter((row) => row.kind === "add").map((row) => [row.newLine, row.text])).toEqual([[10, "L10"]]);
    expect(rows.filter((row) => row.kind === "same")).toHaveLength(6);
    expect(rows.at(0)?.kind).toBe("same");
  });

  it("turns line comments into one message for the agent", () => {
    expect(commentsMessage([{ path: "/repo/src/a.ts", line: 4, code: "  return rows;", text: "Använd formatJson" }], "/repo"))
      .toBe("Comments on the changes:\n- src/a.ts, at `return rows;`: Använd formatJson");
  });
});

describe("mergeChanges", () => {
  it("takes git's counts for files it saw and adds the files only git saw", async () => {
    const { mergeChanges } = await import("./turns");
    const agent = [{ path: "/r/a.ts", added: 9, removed: 9, edits: [{ oldText: "a", newText: "b" }] }, { path: "/tmp/x", added: 1, removed: 0, edits: [] }];
    const merged = mergeChanges(agent, [{ path: "/r/a.ts", added: 2, removed: 1 }, { path: "/r/run.sh", added: 3, removed: 0 }], { from: "a", to: "b" });
    expect(merged).toEqual([
      { path: "/r/a.ts", added: 2, removed: 1, edits: [{ oldText: "a", newText: "b" }], snapshot: { from: "a", to: "b" } },
      { path: "/tmp/x", added: 1, removed: 0, edits: [] },
      { path: "/r/run.sh", added: 3, removed: 0, edits: [], snapshot: { from: "a", to: "b" } },
    ]);
    expect(mergeChanges(agent, undefined)).toBe(agent);
  });
});

describe("changedLines", () => {
  it("does not show a last line without its newline as changed", async () => {
    const { changedLines } = await import("./chips");
    const shown = changedLines({ path: "/r/notes.md", added: 1, removed: 0, edits: [{ oldText: "one\ntwo", newText: "one\ntwo\nthree" }] });
    expect(shown).toEqual({ lines: [{ sign: "+", text: "three" }], more: 0 });
  });
});

describe("countLines at the end of a file", () => {
  it("counts a line appended after a last line without its newline as one added line", () => {
    expect(countLines("one\ntwo", "one\ntwo\nthree")).toEqual({ added: 1, removed: 0 });
  });
});

describe("the conversation's changes", () => {
  it("joins a file changed in several turns, spanning git's snapshots when the first and last have one", () => {
    const edit = (newText: string) => ({ oldText: null, newText });
    const turns = [
      { changes: [{ path: "a.ts", added: 2, removed: 0, edits: [edit("x")], snapshot: { from: "t0", to: "t1" } }, { path: "b.ts", added: 1, removed: 0, edits: [edit("b")] }] },
      { changes: [] },
      { changes: [{ path: "a.ts", added: 1, removed: 1, edits: [edit("y")], snapshot: { from: "t2", to: "t3" } }, { path: "b.ts", added: 3, removed: 1, edits: [edit("c")] }] },
    ];
    expect(conversationChanges(turns)).toEqual([
      { path: "a.ts", added: 3, removed: 1, edits: [], snapshot: { from: "t0", to: "t3" } },
      { path: "b.ts", added: 4, removed: 1, edits: [edit("b"), edit("c")] },
    ]);
  });
});

describe("tool output", async () => {
  const { unfenced } = await import("./turns");
  it("drops one fence around the whole output, as Claude writes it", () => {
    expect(unfenced("```\nExit code 1\ncat: x: No such file\n```")).toBe("Exit code 1\ncat: x: No such file");
    expect(unfenced("```console\n$ ls\na\n```\n")).toBe("$ ls\na");
    expect(unfenced("plain\n```\nnot all\n```")).toBe("plain\n```\nnot all\n```");
    expect(unfenced("```\na\n```\ntext\n```\nb\n```")).toBe("```\na\n```\ntext\n```\nb\n```");
  });
});
