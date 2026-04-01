import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test state logic by importing and calling the functions directly.
// To avoid polluting ~/.agents/state/, we'll test getAgentState logic
// via getAgentStateEntry which shares the same priority logic.

// Since state.ts uses a hardcoded STATE_DIR, we test the exported
// priority/filtering logic by constructing StateEntry arrays directly.

import { clearContributorState, createStateSnapshot, deriveModelDisplay, getAgentState, getAgentStateEntry, getAgentStateProvenance, reportContributorState, reportState, upsertStateSnapshotEntry } from "./state.js";
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

describe("deriveModelDisplay", () => {
  it("prefers provider/modelId over label and legacy model", () => {
    expect(deriveModelDisplay({
      provider: "github-copilot",
      modelId: "gpt-5.4",
      modelLabel: "GPT-5.4",
      model: "GPT-5.4",
    })).toBe("github-copilot/gpt-5.4");
  });

  it("falls back from label to modelId to legacy model", () => {
    expect(deriveModelDisplay({ modelLabel: "Claude Opus 4.6", modelId: "claude-opus-4-6", model: "Opus 4.6" })).toBe("Claude Opus 4.6");
    expect(deriveModelDisplay({ modelId: "gpt-5-codex" })).toBe("gpt-5-codex");
    expect(deriveModelDisplay({ model: "GPT-5.4" })).toBe("GPT-5.4");
  });
});

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

describe("contributor state overlays", () => {
  const session = `%vitest-contrib-${Date.now()}`;

  afterEach(() => {
    clearContributorState("pi", session, "dustbot-sandbox");
  });

  it("elevates a primary state when a contributor reports approval", () => {
    reportState("pi", session, "working");
    reportContributorState("pi", session, "dustbot-sandbox", "approval", { detail: "sandbox approval" });

    const entry = getAgentStateEntry("pi", session);
    expect(entry?.state).toBe("approval");
    expect(entry?.detail).toBe("sandbox approval");
    expect(entry?.contextTokens).toBeUndefined();
  });

  it("clears contributor state when reporter returns to idle", () => {
    reportState("pi", session, "working");
    reportContributorState("pi", session, "dustbot-sandbox", "approval");
    reportContributorState("pi", session, "dustbot-sandbox", "idle");

    const entry = getAgentStateEntry("pi", session);
    expect(entry?.state).toBe("working");
  });
});

describe("state snapshots", () => {
  it("merges contributor overlays once and supports snapshot lookups", () => {
    const snapshot = createStateSnapshot(
      [
        { agent: "pi", session: "%1", state: "working", ts: 100, contextTokens: 1234, contextMax: 4000 },
      ],
      [
        { agent: "pi", session: "%1", reporter: "dustbot-sandbox", state: "approval", ts: 101, detail: "sandbox approval" },
      ],
    );

    expect(getAgentStateEntry("pi", "%1", snapshot)?.state).toBe("approval");
    expect(getAgentStateEntry("pi", "%1", snapshot)?.detail).toBe("sandbox approval");
    expect(getAgentStateEntry("pi", "%1", snapshot)?.contextTokens).toBe(1234);
    expect(getAgentState("pi", "%1", snapshot)).toBe("approval");
    expect(getAgentStateProvenance("pi", "%1", snapshot)).toEqual({
      source: "contributor",
      primary: { agent: "pi", session: "%1", state: "working", ts: 100, contextTokens: 1234, contextMax: 4000 },
      contributors: [
        { agent: "pi", session: "%1", reporter: "dustbot-sandbox", state: "approval", ts: 101, detail: "sandbox approval" },
      ],
      effectiveReporter: "dustbot-sandbox",
    });
  });

  it("updates snapshot indexes when an entry is upserted", () => {
    const snapshot = createStateSnapshot([], []);
    upsertStateSnapshotEntry(snapshot, {
      agent: "codex",
      session: "%2",
      state: "idle",
      ts: 200,
      detail: "2m",
    });

    expect(getAgentStateEntry("codex", "%2", snapshot)?.detail).toBe("2m");
    expect(getAgentState("codex", "%2", snapshot)).toBe("idle");
  });

  it("preserves contributor overlays when the primary entry is upserted", () => {
    const snapshot = createStateSnapshot(
      [
        { agent: "pi", session: "%3", state: "working", ts: 100 },
      ],
      [
        { agent: "pi", session: "%3", reporter: "dustbot-sandbox", state: "approval", ts: 101, detail: "sandbox approval" },
      ],
    );

    upsertStateSnapshotEntry(snapshot, {
      agent: "pi",
      session: "%3",
      state: "idle",
      ts: 102,
    });

    expect(getAgentStateEntry("pi", "%3", snapshot)?.state).toBe("approval");
    expect(getAgentStateEntry("pi", "%3", snapshot)?.detail).toBe("sandbox approval");
    expect(getAgentStateProvenance("pi", "%3", snapshot)?.source).toBe("contributor");
    expect(getAgentStateProvenance("pi", "%3", snapshot)?.primary?.state).toBe("idle");
  });
});
