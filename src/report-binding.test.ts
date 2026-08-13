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

  it("only requests process scanning for ownerless app-owned panes", () => {
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
