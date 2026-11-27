import { describe, expect, it } from "vitest";
import { turnsInLog } from "./program-usage.js";

describe("a coordinator's turns", () => {
  it("tells wakes from the user's own turns, with what each cost where the agent says it", () => {
    const lines = [
      { v: 1, n: 1, at: "2026-11-27T10:00:00Z", kind: "start" },
      { v: 1, n: 2, at: "2026-11-27T10:00:01Z", kind: "user", text: "vad har vi nu?" },
      { v: 1, n: 3, at: "2026-11-27T10:00:09Z", kind: "turnEnd", ms: 8000, usage: { used: 40000, size: 200000, cost: { amount: 0.5, currency: "USD" } } },
      { v: 1, n: 4, at: "2026-11-27T10:05:00Z", kind: "user", text: '<agents-event kind="thread" thread="t1" from="worker:t1" words="data">Worker t1 answered the user: "ok"</agents-event>' },
      { v: 1, n: 5, at: "2026-11-27T10:05:03Z", kind: "turnEnd", ms: 3000, usage: { used: 41000, size: 200000, cost: { amount: 0.56, currency: "USD" } } },
      { v: 1, n: 6, at: "2026-11-27T10:06:00Z", kind: "user", text: '<agents-event kind="message" from="user" words="verbatim">From the user</agents-event>' },
      { v: 1, n: 7, at: "2026-11-27T10:06:05Z", kind: "turnEnd", ms: 5000 },
    ];
    const turns = turnsInLog(lines, "s1", "claude");
    expect(turns.map((turn) => [turn.kind, turn.event ?? ""])).toEqual([["user", ""], ["wake", "thread"], ["user", "message"]]);
    expect(turns[1].cost).toBeCloseTo(0.06);
    expect(turns[0].ms).toBe(8000);
  });
});
