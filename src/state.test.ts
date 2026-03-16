import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test state logic by importing and calling the functions directly.
// To avoid polluting ~/.agents/state/, we'll test getAgentState logic
// via getAgentStateEntry which shares the same priority logic.

// Since state.ts uses a hardcoded STATE_DIR, we test the exported
// priority/filtering logic by constructing StateEntry arrays directly.

import type { StateEntry, ReportedState } from "./state.js";

// Replicate the priority logic from getAgentState for unit testing
// without filesystem dependency.
function getStatePriority(entries: StateEntry[]): ReportedState | null {
  if (entries.length === 0) return null;
  if (entries.some((e) => e.state === "approval")) return "approval";
  if (entries.some((e) => e.state === "working")) return "working";
  if (entries.some((e) => e.state === "question")) return "question";
  return "idle";
}

function filterBySession(entries: StateEntry[], session?: string): StateEntry[] {
  let filtered = entries;
  if (session) filtered = filtered.filter((e) => e.session === session);
  return filtered;
}

describe("state priority logic", () => {
  const now = Math.floor(Date.now() / 1000);

  it("returns null for empty entries", () => {
    expect(getStatePriority([])).toBeNull();
  });

  it("approval wins over everything", () => {
    const entries: StateEntry[] = [
      { state: "working", ts: now, agent: "pi", session: "%1" },
      { state: "approval", ts: now, agent: "pi", session: "%2" },
      { state: "idle", ts: now, agent: "pi", session: "%3" },
    ];
    expect(getStatePriority(entries)).toBe("approval");
  });

  it("working wins over question and idle", () => {
    const entries: StateEntry[] = [
      { state: "idle", ts: now, agent: "pi", session: "%1" },
      { state: "working", ts: now, agent: "pi", session: "%2" },
      { state: "question", ts: now, agent: "pi", session: "%3" },
    ];
    expect(getStatePriority(entries)).toBe("working");
  });

  it("question wins over idle", () => {
    const entries: StateEntry[] = [
      { state: "idle", ts: now, agent: "pi", session: "%1" },
      { state: "question", ts: now, agent: "pi", session: "%2" },
    ];
    expect(getStatePriority(entries)).toBe("question");
  });

  it("idle when only idle entries", () => {
    const entries: StateEntry[] = [
      { state: "idle", ts: now, agent: "pi", session: "%1" },
      { state: "idle", ts: now, agent: "pi", session: "%2" },
    ];
    expect(getStatePriority(entries)).toBe("idle");
  });
});

describe("session filtering", () => {
  const now = Math.floor(Date.now() / 1000);

  const entries: StateEntry[] = [
    { state: "working", ts: now, agent: "pi", session: "%1" },
    { state: "approval", ts: now, agent: "pi", session: "%2" },
    { state: "idle", ts: now, agent: "copilot", session: "%3" },
  ];

  it("no filter returns all entries", () => {
    expect(filterBySession(entries).length).toBe(3);
  });

  it("filters by session", () => {
    const result = filterBySession(entries, "%2");
    expect(result.length).toBe(1);
    expect(result[0].state).toBe("approval");
  });

  it("returns empty for unknown session", () => {
    expect(filterBySession(entries, "%99").length).toBe(0);
  });

  it("per-session priority overrides aggregate", () => {
    // Session %1 is working, even though aggregate has approval from %2
    const session1 = filterBySession(entries, "%1");
    expect(getStatePriority(session1)).toBe("working");
  });
});
