import { describe, expect, it } from "vitest";
import { resolveTmuxReportBinding } from "./report-binding.js";

describe("resolveTmuxReportBinding", () => {
  it("rejects inherited pane identity backed only by legacy agent metadata", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%94",
      reportedAgent: "pi",
      paneCwd: "/Users/peter/code/shape",
      commandId: "pi",
      commandContentKind: "agent",
      foregroundAgent: undefined,
    })).toEqual({
      owned: false,
      requestedSession: "%94",
      reason: "unverified-pane",
    });
  });

  it("accepts matching identity stamped by a managed launcher", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%47",
      reportedAgent: "pi",
      paneCwd: "/repo",
      commandId: "pi",
      commandContentKind: "agent",
      commandOwner: "launcher",
      liveAgent: "pi",
    })).toEqual({
      owned: true,
      requestedSession: "%47",
      paneCwd: "/repo",
      reason: "managed-command",
    });
  });

  it("rejects stale launcher metadata after the managed agent exits", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%47",
      reportedAgent: "pi",
      paneCwd: "/repo",
      commandId: "pi",
      commandContentKind: "agent",
      commandOwner: "launcher",
    })).toEqual({
      owned: false,
      requestedSession: "%47",
      reason: "unverified-pane",
    });
  });

  it("accepts a matching foreground agent without existing metadata", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%48",
      reportedAgent: "codex",
      paneCwd: "/repo",
      foregroundAgent: "codex",
    })).toEqual({
      owned: true,
      requestedSession: "%48",
      paneCwd: "/repo",
      reason: "foreground-agent",
    });
  });
});
