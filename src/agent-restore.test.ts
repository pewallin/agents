import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyTmuxResurrectMetadataLaunches,
  normalizeTmuxResurrectContent,
  resolveAgentRestoreCommand,
  tmuxResurrectRestoreProcesses,
} from "./agent-restore.js";
import { reloadConfig } from "./config.js";
import type { StateEntry } from "./state.js";

function withIsolatedAgentsHome<T>(fn: (root: string, stateDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "agents-restore-test-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  const previousHome = process.env.AGENTS_HOME;
  const previousStateDir = process.env.AGENTS_STATE_DIR;
  const previousConfigPath = process.env.AGENTS_CONFIG_PATH;
  process.env.AGENTS_HOME = root;
  process.env.AGENTS_STATE_DIR = stateDir;
  process.env.AGENTS_CONFIG_PATH = join(root, "missing-config.json");
  reloadConfig();

  try {
    return fn(root, stateDir);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousHome;
    if (previousStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
    else process.env.AGENTS_STATE_DIR = previousStateDir;
    if (previousConfigPath === undefined) delete process.env.AGENTS_CONFIG_PATH;
    else process.env.AGENTS_CONFIG_PATH = previousConfigPath;
    reloadConfig();
    rmSync(root, { recursive: true, force: true });
  }
}

function writeState(stateDir: string, name: string, entry: StateEntry): void {
  writeFileSync(join(stateDir, name), JSON.stringify(entry));
}

function writeConfig(root: string, config: unknown): void {
  writeFileSync(join(root, "missing-config.json"), JSON.stringify(config));
  reloadConfig();
}

describe("resolveAgentRestoreCommand", () => {
  const now = Math.floor(Date.now() / 1000);

  it("uses a unique persisted session id for codex --last restores", () => {
    withIsolatedAgentsHome((_root, stateDir) => {
      writeState(stateDir, "codex-%1.json", {
        state: "idle",
        ts: now,
        agent: "codex",
        session: "%1",
        externalSessionId: "thread-unique",
        workspace: { cwd: "/repo", command: "codex" },
      });

      expect(resolveAgentRestoreCommand({
        agent: "codex",
        cwd: "/repo",
        originalArgv: ["codex", "resume", "--last", "--dangerously-bypass-approvals-and-sandbox"],
      })).toBe("codex --dangerously-bypass-approvals-and-sandbox resume thread-unique");
    });
  });

  it("maps one ambiguous codex --last restore to the newest known session, then starts fresh", () => {
    withIsolatedAgentsHome((_root, stateDir) => {
      writeState(stateDir, "codex-%1.json", {
        state: "idle",
        ts: now - 10,
        agent: "codex",
        session: "%1",
        externalSessionId: "thread-one",
        workspace: { cwd: "/repo", command: "codex" },
      });
      writeState(stateDir, "codex-%2.json", {
        state: "idle",
        ts: now,
        agent: "codex",
        session: "%2",
        externalSessionId: "thread-two",
        workspace: { cwd: "/repo", command: "codex" },
      });

      expect(resolveAgentRestoreCommand({
        agent: "codex",
        cwd: "/repo",
        originalArgv: ["codex", "resume", "--last", "--dangerously-bypass-approvals-and-sandbox"],
      })).toBe("codex --dangerously-bypass-approvals-and-sandbox resume thread-two");

      expect(resolveAgentRestoreCommand({
        agent: "codex",
        cwd: "/repo",
        originalArgv: ["codex", "resume", "--last", "--dangerously-bypass-approvals-and-sandbox"],
      })).toBe("codex --dangerously-bypass-approvals-and-sandbox");
    });
  });

  it("restores kiro-cli panes with explicit resume ids", () => {
    withIsolatedAgentsHome((_root, stateDir) => {
      writeState(stateDir, "kiro-%1.json", {
        state: "idle",
        ts: now,
        agent: "kiro",
        session: "%1",
        externalSessionId: "kiro-session-123",
        workspace: { cwd: "/repo", command: "kiro-cli chat --tui --agent agents-reporting" },
      });

      expect(resolveAgentRestoreCommand({
        agent: "kiro",
        cwd: "/repo",
        originalArgv: ["kiro-cli", "chat", "--tui", "--agent", "agents-reporting", "--resume"],
      })).toBe("kiro-cli chat --tui --agent agents-reporting --resume-id kiro-session-123");
    });
  });

});

describe("normalizeTmuxResurrectContent", () => {
  const now = Math.floor(Date.now() / 1000);

  it("rewrites pane full commands to explicit restore commands when pane state has a session id", () => {
    const content = [
      "pane\tagents\t0\t1\t:* \t0\tCodex\t:/repo\t1\tnode\t:node /Users/test/.local/bin/codex resume --last --dangerously-bypass-approvals-and-sandbox",
      "window\tagents\t0\t:agents\t1\t:* \tlayout\t:",
      "",
    ].join("\n");

    const result = normalizeTmuxResurrectContent(
      content,
      ({ sessionName, windowNumber, paneIndex }) => (
        sessionName === "agents" && windowNumber === "0" && paneIndex === "0" ? "%10" : undefined
      ),
      [
        {
          state: "idle",
          ts: now,
          agent: "codex",
          session: "%10",
          externalSessionId: "thread-saved",
          workspace: { cwd: "/repo", command: "codex" },
        },
      ],
    );

    expect(result.panes).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.content).toContain("\tnode\t:codex --dangerously-bypass-approvals-and-sandbox resume thread-saved");
  });
});

describe("tmux-resurrect metadata restore", () => {
  it("fills missing command launches from configured commands and preserves command cwd", () => {
    withIsolatedAgentsHome((root) => {
      writeConfig(root, {
        commands: [
          { id: "pi", title: "Pi", command: "pi --yolo" },
          { id: "lazygit", title: "LazyGit", command: "lazygit" },
        ],
      });
      const resurrectContent = [
        "pane\tproduct-master\t6\t1\t:* \t0\tpi\t:/wrong\t1\tzsh\t:",
        "pane\tproduct-master\t10\t1\t:* \t0\tgit\t:/repo\t1\tzsh\t:",
        "",
      ].join("\n");
      const metadataContent = [
        "product-master|6|0|uuid|pi|pi|command|/repo/curated||||||||||",
        "product-master|10|0|uuid|lazygit|LazyGit|command|/repo/docs||||||||||",
        "",
      ].join("\n");

      const result = applyTmuxResurrectMetadataLaunches(resurrectContent, metadataContent);

      expect(result.changed).toBe(2);
      expect(result.content).toContain("\t:/repo/curated\t1\tzsh\t:pi --yolo");
      expect(result.content).toContain("\t:/repo/docs\t1\tzsh\t:lazygit");
    });
  });

  it("does not replace an already explicit agent session command with a config fallback", () => {
    withIsolatedAgentsHome((root) => {
      writeConfig(root, {
        commands: [{ id: "pi", title: "Pi", command: "pi --yolo" }],
      });
      const resurrectContent = [
        "pane\tagents\t8\t1\t:* \t0\tpi\t:/repo\t1\tnode\t:pi --yolo --session saved-session",
        "",
      ].join("\n");
      const metadataContent = "agents|8|0|uuid|pi|pi|command|/repo||||||||||\n";

      const result = applyTmuxResurrectMetadataLaunches(resurrectContent, metadataContent);

      expect(result.changed).toBe(0);
      expect(result.content).toContain(":pi --yolo --session saved-session");
    });
  });

  it("prints config-driven agent and command restore processes", () => {
    withIsolatedAgentsHome((root) => {
      writeConfig(root, {
        profiles: {
          codex: { command: "codex --dangerously-bypass-approvals-and-sandbox" },
          pi: { command: "pi --yolo" },
        },
        commands: [
          { id: "hunk", title: "Hunk", command: "hunk diff" },
          { id: "shell", title: "Shell", command: "zsh" },
        ],
      });

      const processes = tmuxResurrectRestoreProcesses("", "");

      expect(processes).toContain("~codex -> agents resurrect agent codex *");
      expect(processes).toContain("~pi -> agents resurrect agent pi *");
      expect(processes).toContain("~hunk");
      expect(processes).not.toContain("~zsh");
    });
  });
});
