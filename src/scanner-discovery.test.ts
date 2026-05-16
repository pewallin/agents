import { describe, expect, it } from "vitest";
import { findAgentLeafInTree, findAgentOnTtyProcessInTree } from "./scanner-discovery.js";
import type { ProcEntry, ProcessTree } from "./scanner-discovery.js";

function proc(
  pid: number,
  ppid: number,
  comm: string,
  tty: string,
  cpuPercent: number,
  memoryMB: number,
  args: string,
): ProcEntry {
  return { pid, ppid, comm, tty, cpuPercent, memoryMB, args };
}

function tree(entries: ProcEntry[]): ProcessTree {
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  const byTty = new Map<string, ProcEntry[]>();

  for (const entry of entries) {
    byPid.set(entry.pid, entry);
    const siblings = children.get(entry.ppid) || [];
    siblings.push(entry.pid);
    children.set(entry.ppid, siblings);
    if (entry.tty !== "??" && entry.tty !== "?") {
      const ttyEntries = byTty.get(entry.tty) || [];
      ttyEntries.push(entry);
      byTty.set(entry.tty, ttyEntries);
    }
  }

  return { byPid, children, byTty };
}

describe("findAgentLeafInTree", () => {
  it("prefers the deepest codex process over the node wrapper", () => {
    const processTree = tree([
      proc(41095, 1, "node", "ttys035", 0, 27, "node"),
      proc(42632, 41095, "node", "ttys035", 0, 0, "node /Users/peter/.nvm/versions/node/v22.20.0/bin/codex --full-auto"),
      proc(42633, 42632, "codex", "ttys035", 1, 73, "/Users/peter/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/vendor/codex/codex --full-auto"),
    ]);

    expect(findAgentLeafInTree(41095, processTree)).toEqual({
      agentName: "codex",
      process: processTree.byPid.get(42633),
    });
  });
});

describe("findAgentOnTtyProcessInTree", () => {
  it("prefers the deepest tty-matching agent process", () => {
    const processTree = tree([
      proc(69627, 1, "copilot", "ttys024", 0, 3, "copilot --yolo"),
      proc(69629, 69627, "copilot", "ttys024", 0, 6, "/Users/peter/.local/bin/copilot --yolo"),
      proc(69927, 69629, "copilot", "ttys024", 1, 18, "/Users/peter/.local/bin/copilot extension_bootstrap.mjs"),
    ]);

    expect(findAgentOnTtyProcessInTree("/dev/ttys024", processTree)).toEqual({
      agentName: "copilot",
      process: processTree.byPid.get(69927),
    });
  });

  it("normalizes kiro-cli-chat process names", () => {
    const processTree = tree([
      proc(71000, 1, "zsh", "ttys030", 0, 8, "zsh"),
      proc(71042, 71000, "kiro-cli-chat", "ttys030", 2, 90, "kiro-cli-chat chat --tui"),
    ]);

    expect(findAgentOnTtyProcessInTree("/dev/ttys030", processTree)).toEqual({
      agentName: "kiro",
      process: processTree.byPid.get(71042),
    });
  });
});
