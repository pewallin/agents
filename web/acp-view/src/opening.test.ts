import { describe, expect, it } from "vitest";
import { gateFromHost, initialGate, nextViewPhase, type ViewPhase } from "./opening";

describe("which session the view opens", () => {
  it("asks the host for the pane's session, or opens the one it was given", () => {
    expect(initialGate("current")).toEqual({ kind: "finding" });
    expect(initialGate("s1")).toEqual({ kind: "open", sessionId: "s1" });
    expect(initialGate(null)).toEqual({ kind: "no-session" });
  });

  it("starts one, waits for a running turn, starts with a first prompt, or opens it", () => {
    expect(gateFromHost({ sessionId: null })).toEqual({ kind: "starts-new" });
    expect(gateFromHost({ sessionId: "s1", persisted: false, busy: true })).toEqual({ kind: "first-prompt", sessionId: "s1" });
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
});
