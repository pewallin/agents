import { describe, expect, it } from "vitest";
import { emptySession, reduce, type SessionAction } from "./session-state";
import { buildTurns, changesOf, conversationChanges, countLines, describeCall, duration, oneLine, shortPath, thoughtSummary } from "./turns";
import { changedWords, commentsMessage, diffRows, linePieces, splitPath } from "./review";

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

  it("times thinking from its start to the next thing the agent does", () => {
    const actions: SessionAction[] = [
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Go"), messageId: "u1" }, at: 1000 },
      { type: "update", update: { sessionUpdate: "agent_thought_chunk", content: text("Plan it.") }, at: 2000 },
      { type: "update", update: { sessionUpdate: "agent_thought_chunk", content: text(" More.") }, at: 3000 },
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "in_progress", rawInput: { command: "ls" } }, at: 6500 },
      { type: "update", update: { sessionUpdate: "agent_thought_chunk", content: text("Still thinking") }, at: 7000 },
    ];
    const [turn] = buildTurns(actions.reduce(reduce, emptySession()));
    expect(turn.steps[0]).toMatchObject({ type: "thought", text: "Plan it. More.", startedAt: 2000, endedAt: 6500 });
    expect(turn.steps[2]).toMatchObject({ type: "thought", startedAt: 7000 });
    expect((turn.steps[2] as { endedAt?: number }).endedAt).toBeUndefined();
  });

  it("sums thinking up in one line: Codex's header, else its first words", () => {
    expect(thoughtSummary("**Checking row counts**\n\nThen sum them.")).toEqual({ title: "Checking row counts", body: "Then sum them." });
    expect(thoughtSummary("**Done**")).toEqual({ title: "Done", body: "" });
    expect(thoughtSummary("- I should read `a.ts` first.\nThen b.")).toEqual({ title: "I should read a.ts first.", body: "- I should read `a.ts` first.\nThen b." });
  });

  it("takes a diff's file:// path as the file's path, so a Kiro edit names one file", () => {
    const actions: SessionAction[] = [
      { type: "update", update: { sessionUpdate: "user_message_chunk", content: text("Write"), messageId: "u1" } },
      { type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write File", kind: "edit", status: "completed",
        locations: [{ path: "/repo/tmp/my notes.md" }],
        content: [{ type: "diff", path: "file:///repo/tmp/my%20notes.md", oldText: "", newText: "a\nb\n" }] } },
    ];
    const state = actions.reduce(reduce, emptySession());
    expect(state.toolCalls.t1.content[0]).toMatchObject({ path: "/repo/tmp/my notes.md" });
    const [turn] = buildTurns(state);
    expect(turn.changes).toEqual([expect.objectContaining({ path: "/repo/tmp/my notes.md", added: 2, removed: 0 })]);
    expect(describeCall(state.toolCalls.t1, "/repo")).toEqual({ verb: "Edited", target: "tmp/my notes.md" });
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
    // The lines before and after fold into gaps that hold them.
    expect(rows.at(0)?.kind).toBe("gap");
    expect(rows.at(0)?.hidden?.map((row) => row.text)).toEqual(["l1", "l2", "l3", "l4", "l5", "l6"]);
    expect(rows.at(-1)?.hidden).toHaveLength(7);
  });

  it("shows a run of unchanged lines too short to fold", () => {
    const old = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    const rows = diffRows(old, old.replace("b\n", "B\n").replace("i\n", "I\n"));
    expect(rows.some((row) => row.kind === "gap")).toBe(false);
  });

  it("marks the words that changed in a line paired with its old version", () => {
    const rows = diffRows("let total = count + 1;\n", "let total = count + 2;\n");
    expect(rows.find((row) => row.kind === "del")?.marks).toEqual([[20, 21]]);
    expect(rows.find((row) => row.kind === "add")?.marks).toEqual([[20, 21]]);
    expect(changedWords("return a;", "throw new Error(message);")).toBeNull();
  });

  it("names a file by its name and its folder, whole for git's paths", () => {
    expect(splitPath("web/acp-view/src/main.tsx", "/repo")).toEqual({ name: "main.tsx", dir: "web/acp-view/src" });
    expect(splitPath("/repo/src/a.ts", "/repo")).toEqual({ name: "a.ts", dir: "src" });
    expect(splitPath("README.md", "/repo")).toEqual({ name: "README.md", dir: "" });
  });

  it("splits a line's colours where its changed words start and end", () => {
    const pieces = linePieces("let x = 2;", [{ content: "let", color: "k" }, { content: " x = 2;", color: "t" }], [[2, 5]]);
    expect(pieces.map((piece) => [piece.content, piece.color, !!piece.marked])).toEqual([
      ["le", "k", false], ["t", "k", true], [" x", "t", true], [" = 2;", "t", false],
    ]);
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
