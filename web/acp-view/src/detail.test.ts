import { describe, expect, it } from "vitest";
import { canExpand, endingFailure, failedCalls, isOpened, lastLines, nextDetailLevel, setOpened, testResult, turnSummary } from "./detail";
import { exitCode, type Turn } from "./turns";

describe("testResult", () => {
  it("reads the summaries of common test runners", () => {
    expect(testResult("Executed 18 tests, with 0 failures (0 unexpected) in 2.41s")).toEqual({ passed: 18, failed: 0 });
    expect(testResult("✔ Test run with 25 tests in 3 suites passed after 0.5 seconds.")).toEqual({ passed: 25, failed: 0 });
    expect(testResult(" Tests  3 failed | 31 passed (34)")).toEqual({ passed: 31, failed: 3 });
    expect(testResult("===== 12 passed in 0.31s =====")).toEqual({ passed: 12, failed: 0 });
    expect(testResult("test result: ok. 7 passed; 0 failed; 0 ignored")).toEqual({ passed: 7, failed: 0 });
    expect(testResult("ℹ tests 4\nℹ suites 0\nℹ pass 4\nℹ fail 0\n")).toEqual({ passed: 4, failed: 0 });
    expect(testResult("nothing here")).toBeNull();
  });
});

describe("turnSummary", () => {
  it("folds a turn's steps into one line", () => {
    const call = (id: string, kind: string, extra: object = {}) => ({ type: "tool" as const, id, call: { id, title: id, kind, status: "completed", content: [], locations: [], ...extra } as never });
    const turn: Turn = {
      id: "t", steps: [
        call("1", "read", { locations: [{ path: "/a" }] }), call("2", "read", { locations: [{ path: "/b" }] }), call("3", "read", { locations: [{ path: "/a" }] }),
        call("4", "edit"), call("5", "edit"), call("6", "execute", { rawOutput: { stdout: "Tests  18 passed (18)" } }),
      ],
      answer: [], changes: [], startedAt: 0, endedAt: 134_000,
    };
    expect(turnSummary(turn)).toBe("Worked 2m 14s · read 2 files · 2 edits · 18 tests passed");
  });
});

describe("levels", () => {
  it("cycles Results, Steps, Everything", () => {
    expect(nextDetailLevel("results")).toBe("steps");
    expect(nextDetailLevel("everything")).toBe("results");
  });

  it("keeps the last lines of output", () => {
    expect(lastLines("a\nb\n\nc\nd\n", 3)).toEqual(["b", "c", "d"]);
  });
});

describe("failures", () => {
  const call = (id: string, status: string, extra: object = {}) => ({ type: "tool" as const, id, call: { id, title: id, kind: "execute", status, content: [], locations: [], ...extra } as never });
  const agent = (text: string) => ({ type: "agent" as const, id: "a", text });

  it("shows only a failure the turn ended on, not one the agent went on from", () => {
    const recovered: Turn = { id: "t", steps: [call("1", "failed"), call("2", "completed")], answer: [agent("Fixed it.")], changes: [] };
    expect(endingFailure(recovered)).toBeNull();
    expect(failedCalls(recovered)).toHaveLength(1);
    const answered: Turn = { id: "t", steps: [call("1", "failed")], answer: [agent("The build fails; here is why.")], changes: [] };
    expect(endingFailure(answered)).toBeNull();
    const ended: Turn = { id: "t", steps: [call("1", "completed"), call("2", "failed")], answer: [], changes: [] };
    expect(endingFailure(ended)?.id).toBe("2");
  });

  it("reads a command's exit code from Codex's raw output or Claude's text", () => {
    expect(exitCode({ id: "1", content: [], locations: [], rawOutput: { exit_code: 2 } } as never)).toBe(2);
    expect(exitCode({ id: "1", content: [{ type: "content", content: { type: "text", text: "Exit code 1\nerror: no such file" } }], locations: [] } as never)).toBe(1);
    expect(exitCode({ id: "1", content: [], locations: [] } as never)).toBeNull();
  });
});

describe("opening a step", () => {
  it("opens a running step whatever it has to show, a finished one when it has something", () => {
    expect(canExpand({ status: "in_progress" }, "", false)).toBe(true);
    expect(canExpand({ status: "pending" }, "", false)).toBe(true);
    expect(canExpand({ status: "completed" }, "", false)).toBe(false);
    expect(canExpand({ status: "completed" }, "out", false)).toBe(true);
    expect(canExpand({ status: "completed" }, "", true)).toBe(true);
  });

  it("keeps a step the reader opened open by its id, as output comes and when it ends", () => {
    expect(isOpened("call-1", "steps")).toBe(false);
    expect(isOpened("call-1", "everything")).toBe(true);
    setOpened("call-1", true);
    expect(isOpened("call-1", "steps")).toBe(true);
    setOpened("call-1", false);
    expect(isOpened("call-1", "everything")).toBe(false);
  });
});
