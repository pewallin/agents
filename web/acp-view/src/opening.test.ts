import { describe, expect, it } from "vitest";
import { gateFromHost, historyArriving, HOST_ERRORS_BEFORE_GIVING_UP, HOST_SILENT_AFTER_MS, initialGate, nextViewPhase, SessionWait, type ViewPhase } from "./opening";

describe("which session the view opens", () => {
  it("asks the host for the pane's session, or opens the one it was given", () => {
    expect(initialGate("current")).toEqual({ kind: "finding" });
    expect(initialGate("s1")).toEqual({ kind: "open", sessionId: "s1" });
    expect(initialGate(null)).toEqual({ kind: "no-session" });
  });

  it("starts one, waits for a running turn, starts with a first prompt, or opens it", () => {
    expect(gateFromHost({ sessionId: null })).toEqual({ kind: "starts-new" });
    expect(gateFromHost({ sessionId: "s1", persisted: false })).toEqual({ kind: "first-prompt", sessionId: "s1" });
    // A first turn the TUI started (a worker's brief) is followed, not offered a first prompt.
    expect(gateFromHost({ sessionId: "s1", persisted: false, busy: true })).toEqual({ kind: "waiting-for-idle", sessionId: "s1" });
    expect(gateFromHost({ sessionId: "s1", busy: true })).toEqual({ kind: "waiting-for-idle", sessionId: "s1" });
    expect(gateFromHost({ sessionId: "s1" })).toEqual({ kind: "open", sessionId: "s1" });
  });
});

describe("how the view's connection stands", () => {
  const failure = { title: "The connection to Claude closed", detail: { message: "gone" } };
  const run = (...events: Parameters<typeof nextViewPhase>[1][]): ViewPhase =>
    events.reduce(nextViewPhase, { kind: "connecting" } as ViewPhase);

  it("opens once loaded, and fails when the connection ends", () => {
    expect(run({ type: "loaded" })).toEqual({ kind: "open" });
    expect(run({ type: "loaded" }, { type: "failed", failure })).toEqual({ kind: "failed", failure });
  });

  it("keeps saying another view has the session when the connection then ends", () => {
    expect(run({ type: "loaded" }, { type: "taken-over" }, { type: "failed", failure })).toEqual({ kind: "taken-over" });
    expect(run({ type: "open-elsewhere" }, { type: "failed", failure })).toEqual({ kind: "open-elsewhere" });
    expect(run({ type: "cannot-load", version: "0.0.406" }, { type: "taken-over" })).toEqual({ kind: "cannot-load", version: "0.0.406" });
  });

  it("connects again on a retry or a take-over, and a late load does not reopen a failure", () => {
    expect(run({ type: "failed", failure }, { type: "connect" })).toEqual({ kind: "connecting" });
    expect(run({ type: "taken-over" }, { type: "connect" }, { type: "loaded" })).toEqual({ kind: "open" });
    expect(run({ type: "failed", failure }, { type: "loaded" })).toEqual({ kind: "failed", failure });
  });

  it("keeps the first failure: a session that did not open is why its connection closed", () => {
    const notOpened = { title: "The session could not be opened", detail: { message: "The session did not open: no such session" } };
    expect(run({ type: "failed", failure: notOpened }, { type: "failed", failure })).toEqual({ kind: "failed", failure: notOpened });
  });
});

describe("whether the session's history is coming in as it loads", () => {
  it("is once a replay has brought something, and not for a session already open", () => {
    expect(historyArriving({ replaying: true, items: [], toolCalls: {} })).toBe(false);
    expect(historyArriving({ replaying: true, items: [{}], toolCalls: {} })).toBe(true);
    expect(historyArriving({ replaying: true, items: [], toolCalls: { t1: {} } })).toBe(true);
    expect(historyArriving({ replaying: false, items: [{}], toolCalls: {} })).toBe(false);
  });
});

describe("how long the view waits for the pane's session", () => {
  it("waits on while the agent has no session yet, however long that takes", () => {
    const wait = new SessionWait();
    for (let at = 0; at < 10 * 60_000; at += 1_000) expect(wait.failed(404, at)).toBe("ask-again");
  });

  it("says so a few seconds after the host stopped answering at all", () => {
    const wait = new SessionWait();
    expect(wait.failed(404, 0)).toBe("ask-again");
    expect(wait.failed(null, 1_000)).toBe("ask-again");
    expect(wait.failed(null, 1_000 + HOST_SILENT_AFTER_MS - 1)).toBe("ask-again");
    expect(wait.failed(null, 1_000 + HOST_SILENT_AFTER_MS)).toBe("host-silent");
  });

  it("counts the silence from the last answer: a host that answers again is waited for afresh", () => {
    const wait = new SessionWait();
    expect(wait.failed(null, 0)).toBe("ask-again");
    expect(wait.failed(404, HOST_SILENT_AFTER_MS - 100)).toBe("ask-again");
    expect(wait.failed(null, HOST_SILENT_AFTER_MS)).toBe("ask-again");
    expect(wait.failed(null, 2 * HOST_SILENT_AFTER_MS - 1)).toBe("ask-again");
  });

  it("gives a host that answers with errors many tries", () => {
    const wait = new SessionWait();
    for (let tries = 1; tries < HOST_ERRORS_BEFORE_GIVING_UP; tries += 1) expect(wait.failed(500, tries)).toBe("ask-again");
    expect(wait.failed(500, HOST_ERRORS_BEFORE_GIVING_UP)).toBe("host-failing");
  });
});
