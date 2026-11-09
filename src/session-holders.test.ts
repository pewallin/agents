import { describe, expect, it } from "vitest";
import { describeHolder, findSessionHolders, paneOfProcess, type HolderInputs } from "./session-holders.js";

// Pane %1 runs a shell (100) with Kiro under it (101 → 102); pane %2 runs Claude (200); pane %3
// runs Codex's codex-session (300) and its app-server (301). Process 900 runs outside tmux.
const inputs = (records: HolderInputs["records"] = [], panes: HolderInputs["panes"] = []): HolderInputs => ({
  panes,
  tmuxPanes: [
    { paneId: "%1", pid: 100, session: "work", window: "api" },
    { paneId: "%2", pid: 200, session: "work", window: "web" },
    { paneId: "%3", pid: 300, session: "side", window: "codex" },
  ],
  processes: [
    { pid: 100, ppid: 1 }, { pid: 101, ppid: 100 }, { pid: 102, ppid: 101 },
    { pid: 200, ppid: 1 }, { pid: 300, ppid: 1 }, { pid: 301, ppid: 300 }, { pid: 900, ppid: 1 },
  ],
  records,
});

describe("paneOfProcess", () => {
  it("finds the pane whose process is the process or one of its ancestors", () => {
    expect(paneOfProcess(102, inputs())?.paneId).toBe("%1");
    expect(paneOfProcess(200, inputs())?.paneId).toBe("%2");
    expect(paneOfProcess(900, inputs())).toBeUndefined();
    expect(paneOfProcess(12345, inputs())).toBeUndefined();
  });
});

describe("findSessionHolders", () => {
  it("names another pane whose agent reports the session, with where it is", () => {
    const holders = findSessionHolders("claude", ["s1", "s2"], "%1", inputs([], [
      { tmuxPaneId: "%2", agent: "claude", externalSessionId: "s1" },
      { tmuxPaneId: "%3", agent: "codex", externalSessionId: "s2" },
    ]));
    expect(holders.get("s1")).toEqual({ pane: "%2", session: "work", window: "web" });
    // Another agent's session of the same id is not this agent's.
    expect(holders.has("s2")).toBe(false);
  });

  it("does not count the pane's own session or its own processes", () => {
    const holders = findSessionHolders("kiro", ["k1", "k2"], "%1", inputs([{ sessionId: "k1", pid: 102 }], [
      { tmuxPaneId: "%1", agent: "kiro", externalSessionId: "k2" },
    ]));
    expect(holders.size).toBe(0);
  });

  it("locates a lock's process to its pane, or names it when it runs outside every pane", () => {
    const holders = findSessionHolders("codex", ["t1", "t2"], "%1", inputs([
      { sessionId: "t1", pid: 301 },
      { sessionId: "t2", pid: 900 },
    ]));
    expect(holders.get("t1")).toEqual({ pane: "%3", pid: 301, session: "side", window: "codex" });
    expect(holders.get("t2")).toEqual({ pid: 900 });
  });

  it("matches Kiro under its executable's name, and prefers the pane's report to a lock", () => {
    const holders = findSessionHolders("kiro", ["k1"], "%2", inputs([{ sessionId: "k1", pid: 900 }], [
      { tmuxPaneId: "%1", agent: "kiro-cli", externalSessionId: "k1" },
    ]));
    expect(holders.get("k1")).toEqual({ pane: "%1", session: "work", window: "api" });
  });
});

describe("describeHolder", () => {
  it("says which pane, or which process", () => {
    expect(describeHolder({ pane: "%2", session: "work", window: "web" })).toBe("pane %2 (work › web)");
    expect(describeHolder({ pane: "%2" })).toBe("pane %2");
    expect(describeHolder({ pid: 900 })).toBe("another process (900) outside Agents Next's panes");
  });
});
