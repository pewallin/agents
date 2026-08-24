import { describe, expect, it } from "vitest";
import { requiresTmuxReportProcessScan, resolveTmuxReportBinding } from "./report-binding.js";

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

  it("accepts matching identity stamped by a managed launcher without a pane-local process", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%47",
      reportedAgent: "pi",
      paneCwd: "/repo",
      commandId: "pi",
      commandContentKind: "agent",
      commandOwner: "launcher",
    })).toEqual({
      owned: true,
      requestedSession: "%47",
      paneCwd: "/repo",
      reason: "managed-command",
    });
  });

  it("rejects a nested agent report that conflicts with the launched session", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%12",
      reportedAgent: "codex",
      reportedExternalSessionId: "nested-review-session",
      expectedExternalSessionId: "interactive-session",
      paneCwd: "/repo",
      commandId: "codex",
      commandContentKind: "agent",
      commandOwner: "launcher",
    })).toEqual({
      owned: false,
      requestedSession: "%12",
      reason: "unverified-pane",
    });
  });

  it("accepts a managed report from the launched session", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%12",
      reportedAgent: "codex",
      reportedExternalSessionId: "interactive-session",
      expectedExternalSessionId: "interactive-session",
      paneCwd: "/repo",
      commandId: "codex",
      commandContentKind: "agent",
      commandOwner: "launcher",
    })).toMatchObject({
      owned: true,
      reason: "managed-command",
    });
  });

  it("accepts an ownerless app-owned pane with a matching live descendant agent", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%370",
      reportedAgent: "kiro",
      paneCwd: "/repo",
      paneOwner: "app_owned",
      commandId: "kiro",
      commandContentKind: "agent",
      liveAgent: "kiro",
    })).toEqual({
      owned: true,
      requestedSession: "%370",
      paneCwd: "/repo",
      reason: "app-owned-live-agent",
    });
  });

  it("accepts an ownerless pane with a matching live descendant behind a terminal proxy", () => {
    const input = {
      requestedSession: "%12",
      reportedAgent: "codex",
      paneCwd: "/repo",
      foregroundAgent: undefined,
      liveAgent: "codex",
    };

    expect(requiresTmuxReportProcessScan(input)).toBe(true);
    expect(resolveTmuxReportBinding(input)).toEqual({
      owned: true,
      requestedSession: "%12",
      paneCwd: "/repo",
      reason: "live-descendant-agent",
    });
  });

  it("rejects an ownerless pane when the live descendant is a different agent", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%12",
      reportedAgent: "codex",
      paneCwd: "/repo",
      liveAgent: "kiro",
    })).toEqual({
      owned: false,
      requestedSession: "%12",
      reason: "unverified-pane",
    });
  });

  it("requests process scanning for ownerless panes but not launcher-owned panes", () => {
    expect(requiresTmuxReportProcessScan({
      requestedSession: "%370",
      reportedAgent: "kiro",
      paneOwner: "app_owned",
    })).toBe(true);
    expect(requiresTmuxReportProcessScan({
      requestedSession: "%370",
      reportedAgent: "kiro",
      paneOwner: "app_owned",
      commandId: "kiro",
      commandContentKind: "agent",
      commandOwner: "launcher",
    })).toBe(false);
  });

  it("rejects an ownerless app-owned pane without a live descendant agent", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%94",
      reportedAgent: "pi",
      paneCwd: "/repo",
      paneOwner: "app_owned",
    })).toEqual({
      owned: false,
      requestedSession: "%94",
      reason: "unverified-pane",
    });
  });

  it("rejects an ownerless app-owned pane with a different live descendant agent", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%370",
      reportedAgent: "codex",
      paneCwd: "/repo",
      paneOwner: "app_owned",
      liveAgent: "kiro",
    })).toEqual({
      owned: false,
      requestedSession: "%370",
      reason: "unverified-pane",
    });
  });

  it("rejects launcher metadata owned by a different agent", () => {
    expect(resolveTmuxReportBinding({
      requestedSession: "%47",
      reportedAgent: "codex",
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
