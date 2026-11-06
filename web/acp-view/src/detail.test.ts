import { describe, expect, it } from "vitest";
import { lastLines, nextDetailLevel, testResult, turnSummary } from "./detail";
import type { Turn } from "./turns";

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
