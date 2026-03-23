import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getWorkspacePathState, prepareWorkspaceDir, getRestorableWorkspacesFromStates } from "./workspace.js";
import type { StateEntry } from "./state.js";

describe("workspace path helpers", () => {
  it("classifies existing directories as valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-ws-valid-"));
    try {
      expect(getWorkspacePathState(dir)).toBe("valid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies missing directories under an existing parent as creatable", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-ws-creatable-"));
    const target = join(root, "new-project", "nested");
    try {
      expect(getWorkspacePathState(target)).toBe("creatable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies files as invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-ws-file-"));
    const file = join(root, "README.md");
    writeFileSync(file, "hi");
    try {
      expect(getWorkspacePathState(file)).toBe("invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates missing project directories and initializes git", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-ws-init-"));
    const target = join(root, "demo-app");
    try {
      expect(prepareWorkspaceDir(target)).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(join(target, ".git"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses paths under a file ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-ws-blocked-"));
    const fileParent = join(root, "not-a-dir");
    writeFileSync(fileParent, "x");
    const target = join(fileParent, "child");
    try {
      expect(getWorkspacePathState(target)).toBe("invalid");
      expect(prepareWorkspaceDir(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("getRestorableWorkspacesFromStates", () => {
  const now = Math.floor(Date.now() / 1000);

  it("returns empty for entries without workspace snapshots", () => {
    const entries: StateEntry[] = [
      { state: "idle", ts: now, agent: "claude", session: "%1" },
      { state: "working", ts: now, agent: "pi", session: "%2" },
    ];
    expect(getRestorableWorkspacesFromStates(entries)).toEqual([]);
  });

  it("extracts restorable workspaces from entries with workspace data", () => {
    const entries: StateEntry[] = [
      {
        state: "idle", ts: now, agent: "claude", session: "%1",
        context: "Fixing bugs",
        workspace: { cwd: "/Users/test/code/myapp", command: "claude" },
      },
      {
        state: "working", ts: now, agent: "pi", session: "%5",
        workspace: { cwd: "/Users/test/code/other", command: "pi" },
      },
    ];
    const result = getRestorableWorkspacesFromStates(entries);
    expect(result).toHaveLength(2);
    expect(result[0].agent).toBe("claude");
    expect(result[0].cwd).toBe("/Users/test/code/myapp");
    expect(result[0].command).toBe("claude");
    expect(result[0].context).toBe("Fixing bugs");
    expect(result[1].agent).toBe("pi");
    expect(result[1].cwd).toBe("/Users/test/code/other");
  });

  it("skips entries with incomplete workspace data (no cwd)", () => {
    const entries: StateEntry[] = [
      {
        state: "idle", ts: now, agent: "claude", session: "%1",
        workspace: { command: "claude" } as any,
      },
    ];
    expect(getRestorableWorkspacesFromStates(entries)).toEqual([]);
  });

  it("skips entries with incomplete workspace data (no command)", () => {
    const entries: StateEntry[] = [
      {
        state: "idle", ts: now, agent: "claude", session: "%1",
        workspace: { cwd: "/some/path" } as any,
      },
    ];
    expect(getRestorableWorkspacesFromStates(entries)).toEqual([]);
  });

  it("deduplicates by agent:session key", () => {
    const entries: StateEntry[] = [
      {
        state: "idle", ts: now, agent: "claude", session: "%1",
        workspace: { cwd: "/a", command: "claude" },
      },
      {
        state: "working", ts: now - 10, agent: "claude", session: "%1",
        workspace: { cwd: "/b", command: "claude" },
      },
    ];
    const result = getRestorableWorkspacesFromStates(entries);
    expect(result).toHaveLength(1);
    expect(result[0].cwd).toBe("/a"); // first one wins
  });
});
