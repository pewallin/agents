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

  it("uses configured profiles when restoring without a session id", () => {
    withIsolatedAgentsHome((root) => {
      writeConfig(root, {
        profiles: {
          claude: { command: "claude --dangerously-skip-permissions" },
          codex: { command: "codex --dangerously-bypass-approvals-and-sandbox" },
          copilot: { command: "copilot --yolo" },
          pi: { command: "pi --yolo" },
          opencode: { command: "opencode" },
          kiro: { command: "kiro-cli chat -a" },
        },
      });

      expect(resolveAgentRestoreCommand({ agent: "claude", cwd: "/repo", originalArgv: ["claude"] }))
        .toBe("claude --dangerously-skip-permissions");
      expect(resolveAgentRestoreCommand({ agent: "codex", cwd: "/repo", originalArgv: ["codex"] }))
        .toBe("codex --dangerously-bypass-approvals-and-sandbox");
      expect(resolveAgentRestoreCommand({ agent: "copilot", cwd: "/repo", originalArgv: ["copilot"] }))
        .toBe("copilot --yolo");
      expect(resolveAgentRestoreCommand({ agent: "pi", cwd: "/repo", originalArgv: ["pi"] }))
        .toBe("pi --yolo");
      expect(resolveAgentRestoreCommand({ agent: "opencode", cwd: "/repo", originalArgv: ["opencode"] }))
        .toBe("opencode");
      expect(resolveAgentRestoreCommand({ agent: "kiro", cwd: "/repo", originalArgv: ["kiro"] }))
        .toBe("kiro-cli chat -a");
    });
  });

  it("drops accidental Pi prompt positionals when restoring an existing session", () => {
    expect(resolveAgentRestoreCommand({
      agent: "pi",
      cwd: "/repo",
      originalArgv: ["pi", "--yolo", "--session", "pi-session-123", "tmux", "pane", "%40"],
    })).toBe("pi --yolo --session pi-session-123");
  });

  it("keeps Pi runtime flags while dropping prompt positionals during session restore", () => {
    expect(resolveAgentRestoreCommand({
      agent: "pi",
      cwd: "/repo",
      originalArgv: [
        "pi",
        "--yolo",
        "--model",
        "openai/gpt-5.5",
        "--thinking",
        "high",
        "--session",
        "pi-session-123",
        "tmux",
        "pane",
        "%40",
      ],
    })).toBe("pi --yolo --model openai/gpt-5.5 --thinking high --session pi-session-123");
  });

  it("accepts equals-style Pi session restore targets", () => {
    expect(resolveAgentRestoreCommand({
      agent: "pi",
      cwd: "/repo",
      originalArgv: ["pi", "--yolo", "--session=pi-session-123", "tmux", "pane", "%40"],
    })).toBe("pi --yolo --session pi-session-123");
  });

  it("drops other Pi session-target flags when restoring an existing session", () => {
    expect(resolveAgentRestoreCommand({
      agent: "pi",
      cwd: "/repo",
      externalSessionId: "pi-session-123",
      originalArgv: ["pi", "--yolo", "--fork", "old-session", "tmux", "pane", "%40"],
    })).toBe("pi --yolo --session pi-session-123");
  });

  it("drops OpenCode prompts when restoring an existing session", () => {
    expect(resolveAgentRestoreCommand({
      agent: "opencode",
      cwd: "/repo",
      originalArgv: ["opencode", "--prompt", "tmux pane %40", "--session=opencode-session-123"],
    })).toBe("opencode --session opencode-session-123");
  });

  it("keeps Pi prompt positionals when starting fresh without a session id", () => {
    expect(resolveAgentRestoreCommand({
      agent: "pi",
      cwd: "/repo",
      originalArgv: ["pi", "--yolo", "resume this task"],
    })).toBe("pi --yolo 'resume this task'");
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

  it("lets explicit pane metadata correct stale normalized agent session commands", () => {
    const resurrectContent = [
      "pane\tproduct-master\t4\t0\t: \t0\tpi\t:/repo\t1\tzsh\t:pi --yolo --session stale-belgium-session",
      "",
    ].join("\n");
    const metadataContent = [
      "product-master|4|0|uuid|pi|Pi|agent|/repo||||||||||pi --yolo --session product-session",
      "",
    ].join("\n");

    const result = applyTmuxResurrectMetadataLaunches(resurrectContent, metadataContent);

    expect(result.changed).toBe(1);
    expect(result.content).toContain(":pi --yolo --session product-session");
    expect(result.content).not.toContain("stale-belgium-session");
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
