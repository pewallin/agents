import { describe, expect, it } from "vitest";
import { emptySession, reduce, type SessionAction } from "./session-state";
import { buildTurns, changesOf, countLines, describeCall, duration, shortPath } from "./turns";
import { commentsMessage, diffRows } from "./review";

const text = (t: string) => ({ type: "text" as const, text: t });

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
      .toEqual({ verb: "Körde", target: "bun test" });
    expect(describeCall({ id: "t", title: "Read file", kind: "read", status: "completed", content: [], locations: [{ path: "/repo/src/a.ts" }] }, "/repo"))
      .toEqual({ verb: "Läste", target: "src/a.ts" });
  });

  it("counts lines and writes durations and paths as people read them", () => {
    expect(countLines(null, "x\ny\n")).toEqual({ added: 2, removed: 0 });
    expect(duration(134_000)).toBe("2 min 14 s");
    expect(duration(12_400)).toBe("12 s");
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
      .toBe("Kommentarer på ändringarna:\n- src/a.ts, vid `return rows;`: Använd formatJson");
  });
});
