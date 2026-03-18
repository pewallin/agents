import { describe, it, expect } from "vitest";
import { getDetector, filterAgents } from "./scanner.js";
import type { AgentPane } from "./scanner.js";

describe("getDetector", () => {
  it("returns hook detector for claude", () => {
    const d = getDetector("claude");
    expect(d).toBeDefined();
  });

  it("returns hook detector for copilot", () => {
    const d = getDetector("copilot");
    expect(d).toBeDefined();
  });

  it("returns generic detector for unknown agents", () => {
    const d = getDetector("codex");
    expect(d).toBeDefined();
  });

  it("is case-insensitive", () => {
    const a = getDetector("Claude");
    const b = getDetector("claude");
    expect(a).toBe(b);
  });
});

// ── filterAgents tests ────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentPane> & { pane: string; tmuxPaneId: string }): AgentPane {
  return {
    paneId: "dustbot:0",
    title: "",
    agent: "pi",
    status: "idle",
    windowId: "dustbot:0",
    ...overrides,
  };
}

describe("filterAgents", () => {
  const selfPane = "%10";
  const selfWindow = "dustbot:0";

  const agents: AgentPane[] = [
    makeAgent({ pane: "dustbot:pi.0", tmuxPaneId: "%10", windowId: "dustbot:0" }), // self
    makeAgent({ pane: "dustbot:claude.0", tmuxPaneId: "%11", windowId: "dustbot:1" }),
    makeAgent({ pane: "belgium:pi.0", tmuxPaneId: "%20", windowId: "belgium:0" }),
    makeAgent({ pane: "belgium:copilot.1", tmuxPaneId: "%21", windowId: "belgium:1" }),
  ];

  it("removes self pane and agents in own window", () => {
    const result = filterAgents(agents, selfPane, selfWindow);
    // %10 is self, removed. %11 is in dustbot:1 (different window), kept.
    // Sorted by pane name: belgium:copilot, belgium:pi, dustbot:claude
    expect(result.map((a) => a.tmuxPaneId)).toEqual(["%21", "%20", "%11"]);
  });

  it("re-adds previewed agent with original name", () => {
    // %20 is previewed — it's been swapped into the dashboard window
    const agentsWithSwap = agents.map((a) =>
      a.tmuxPaneId === "%20" ? { ...a, windowId: "dustbot:0" } : a
    );
    const result = filterAgents(agentsWithSwap, selfPane, selfWindow, {
      agentTmuxId: "%20",
      splitPaneId: "%50",
      agentPane: "belgium:pi.0",
      agentPaneId: "belgium:0",
    });
    const found = result.find((a) => a.tmuxPaneId === "%20");
    expect(found).toBeDefined();
    expect(found!.pane).toBe("belgium:pi.0");
  });

  it("filters out placeholder panes from preview", () => {
    const withPlaceholder = [
      ...agents,
      makeAgent({ pane: "placeholder", tmuxPaneId: "%50", windowId: "belgium:0" }),
    ];
    const result = filterAgents(withPlaceholder, selfPane, selfWindow, {
      agentTmuxId: "%20",
      splitPaneId: "%50",
      agentPane: "belgium:pi.0",
      agentPaneId: "belgium:0",
    });
    expect(result.find((a) => a.tmuxPaneId === "%50")).toBeUndefined();
  });

  it("re-adds grid agents with original names", () => {
    const result = filterAgents(agents, selfPane, selfWindow, null, {
      agents: [
        { tmuxPaneId: "%20", pane: "belgium:pi.0", paneId: "belgium:0", windowId: "belgium:0" },
        { tmuxPaneId: "%21", pane: "belgium:copilot.1", paneId: "belgium:1", windowId: "belgium:1" },
      ],
      placeholderIds: ["%60", "%61"],
    });
    expect(result.find((a) => a.tmuxPaneId === "%20")?.pane).toBe("belgium:pi.0");
    expect(result.find((a) => a.tmuxPaneId === "%21")?.pane).toBe("belgium:copilot.1");
  });

  it("re-adds grid agents with original pane targets for enter-jump", () => {
    const swapped = agents.map((a) =>
      a.tmuxPaneId === "%20" ? { ...a, paneId: "dustbot:0", windowId: "dustbot:0" } : a
    );
    const result = filterAgents(swapped, selfPane, selfWindow, null, {
      agents: [
        { tmuxPaneId: "%20", pane: "belgium:pi.0", paneId: "belgium:0", windowId: "belgium:0" },
      ],
      placeholderIds: ["%60"],
    });
    const found = result.find((a) => a.tmuxPaneId === "%20");
    expect(found?.paneId).toBe("belgium:0");
    expect(found?.windowId).toBe("belgium:0");
  });

  it("results are sorted by pane name", () => {
    const result = filterAgents(agents, selfPane, selfWindow);
    const panes = result.map((a) => a.pane);
    expect(panes).toEqual([...panes].sort());
  });
});

describe("generic detector (screen-scraping)", () => {
  // Get the generic detector via an unknown agent name
  const detector = getDetector("codex");

  describe("isApproval", () => {
    it("matches (Y/n) prompt", () => {
      expect(detector.isApproval("Do you want to proceed? (Y/n)")).toBe(true);
    });

    it("matches (y/N) prompt", () => {
      expect(detector.isApproval("Continue? (y/N)")).toBe(true);
    });

    it("matches copilot selection UI", () => {
      expect(detector.isApproval("↑↓ to select · Enter to confirm")).toBe(true);
    });

    it("matches copilot navigation UI", () => {
      expect(detector.isApproval("↑↓ to navigate · Enter to select")).toBe(true);
    });

    it("matches Allow this action", () => {
      expect(detector.isApproval("Allow this action")).toBe(true);
    });

    it("matches claude permission prompt", () => {
      expect(detector.isApproval("△ Permission required")).toBe(true);
    });

    it("matches claude Allow once/always/Reject", () => {
      expect(detector.isApproval("Allow once  Allow always  Reject")).toBe(true);
    });

    it("does not match normal content", () => {
      expect(detector.isApproval("Hello world\nThis is some code")).toBe(false);
    });
  });

  describe("isWorking", () => {
    it("matches braille spinner in content", () => {
      expect(detector.isWorking("⠋ Loading...", "")).toBe(true);
    });

    it("matches spinner in title", () => {
      expect(detector.isWorking("", "⠋ Working")).toBe(true);
    });

    it("matches Working... keyword", () => {
      expect(detector.isWorking("Working...", "")).toBe(true);
    });

    it("matches Thinking... keyword", () => {
      expect(detector.isWorking("Thinking...", "")).toBe(true);
    });

    it("does not match idle content", () => {
      expect(detector.isWorking("❯ ", "terminal")).toBe(false);
    });
  });

  describe("isIdle", () => {
    it("matches shell prompt ❯", () => {
      expect(detector.isIdle("some output\n❯ ", "")).toBe(true);
    });

    it("matches shell prompt ›", () => {
      expect(detector.isIdle("some output\n› ", "")).toBe(true);
    });

    it("matches $ prompt", () => {
      expect(detector.isIdle("some output\n$ ", "")).toBe(true);
    });

    it("matches copilot tab agents prompt", () => {
      expect(detector.isIdle("some output\ntab agents  ctrl+p commands", "")).toBe(true);
    });

    it("does not match working content", () => {
      expect(detector.isIdle("⠋ Loading data from server", "")).toBe(false);
    });
  });
});
