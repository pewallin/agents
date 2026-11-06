import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kiroSessionLock, kiroSessionLocks } from "./acp-host-cli.js";
import { agentWords, codexResumeCommand, isPtyWrapper, planAcpRestart, sessionHeldBy, type PaneProcess } from "./acp-restart.js";

const AGENTS_BIN = "/Users/me/.agents/agents-cli/app/agents";

function plan(
  processes: PaneProcess[],
  state: Record<string, { state?: string; externalSessionId?: string }>,
  panePid = 100,
  heldSession?: (registryId: string, pids: number[]) => string | undefined,
) {
  return planAcpRestart({ paneId: "%7", panePid, processes, stateOf: (agent) => state[agent], heldSession, agentsCommand: AGENTS_BIN });
}

describe("acp-restart", () => {
  it("names an agent by its executable, or by the script node runs", () => {
    expect(agentWords("/opt/homebrew/bin/claude --model opus")).toEqual({ name: "claude", words: ["/opt/homebrew/bin/claude", "--model", "opus"] });
    expect(agentWords("node /Users/me/.nvm/versions/node/v24/bin/codex --model gpt-6.1 -a never")).toEqual({ name: "codex", words: ["/Users/me/.nvm/versions/node/v24/bin/codex", "--model", "gpt-6.1", "-a", "never"] });
    expect(agentWords("kiro-cli chat -a --v3")?.name).toBe("kiro-cli");
    expect(agentWords("-zsh")).toBeUndefined();
    expect(agentWords("vim notes.md")).toBeUndefined();
  });

  it("resumes Codex on its session with its own options, a resume it had replaced", () => {
    expect(codexResumeCommand(["codex", "--model", "gpt-6.1", "resume", "old"], "thread-1")).toBe("codex --model gpt-6.1 resume thread-1");
    expect(codexResumeCommand(["codex", "resume", "--last", "-a", "never"], "t")).toBe("codex -a never resume t");
  });

  it("restarts Codex started by hand in the pane's shell, under codex-session, typed into that shell", () => {
    const result = plan([
      { pid: 100, ppid: 1, args: "-zsh" },
      { pid: 200, ppid: 100, args: "node /x/bin/codex --model gpt-6.1" },
      { pid: 201, ppid: 200, args: "/x/vendor/codex --model gpt-6.1" },
    ], { codex: { state: "idle", externalSessionId: "thread-1" } });
    expect(result).toEqual({
      ok: true, agent: "codex", stateAgent: "codex", sessionId: "thread-1", agentPid: 200, viaShell: true,
      command: `${AGENTS_BIN} codex-session --command '/x/bin/codex --model gpt-6.1 resume thread-1'`,
    });
  });

  it("restarts a hand-off agent that is the pane's own command under acp-session --tui, by a respawn", () => {
    const result = plan([
      { pid: 100, ppid: 1, args: "kiro-cli chat -a --v3 --resume-id sess_old" },
    ], { kiro: { state: "idle", externalSessionId: "sess_new" } });
    expect(result).toMatchObject({ ok: true, agent: "kiro-cli", viaShell: false, agentPid: 100 });
    expect(result.ok && result.command).toBe(`${AGENTS_BIN} acp-session --agent kiro --tui 'kiro-cli chat -a --v3 --resume-id sess_new'`);
  });

  it("says why it cannot: a working agent, no known session, no agent, or a host that is gone", () => {
    const claude = [{ pid: 100, ppid: 1, args: "zsh" }, { pid: 200, ppid: 100, args: "claude" }];
    expect(plan(claude, { claude: { state: "working", externalSessionId: "s" } })).toMatchObject({ ok: false, reason: expect.stringContaining("working") });
    expect(plan(claude, { claude: { state: "idle" } })).toMatchObject({ ok: false, reason: expect.stringContaining("not reported its session") });
    expect(plan([{ pid: 100, ppid: 1, args: "zsh" }, { pid: 200, ppid: 100, args: "htop" }], {})).toMatchObject({ ok: false, reason: "This pane runs no agent with an ACP view." });
    expect(plan([{ pid: 100, ppid: 1, args: "/x/agents acp-session --agent claude-acp --tui claude" }, { pid: 200, ppid: 100, args: "claude" }], { claude: { state: "idle", externalSessionId: "s" } }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("already runs with its ACP view") });
  });

  // Kiro's shell integration (kiro-cli-term) runs the pane's shell in a pty of its own: the pane's
  // process is the wrapper, the shell its child, and Kiro the shell's (Peter's coordinator, 2026-11-06).
  const wrapped: PaneProcess[] = [
    { pid: 42197, ppid: 40694, args: "zsh (kiro-cli-term)" },
    { pid: 42292, ppid: 42197, args: "-zsh" },
    { pid: 58321, ppid: 42292, args: "kiro-cli chat -a" },
    { pid: 58330, ppid: 58321, args: "/Users/me/.local/bin/kiro-cli-chat chat -a" },
    { pid: 58353, ppid: 58330, args: "/Users/me/Library/Application Support/kiro-cli/bun /Users/me/Library/Application Support/kiro-cli/tui.js chat -a" },
    { pid: 58370, ppid: 58353, args: "/Users/me/.local/bin/kiro-cli-chat acp --trust-all-tools" },
  ];

  it("finds Kiro behind its shell integration's pty and types the restart into the wrapped shell", () => {
    const result = plan(wrapped, { kiro: { state: "idle", externalSessionId: "a28d" } }, 42197);
    expect(result).toMatchObject({ ok: true, agent: "kiro-cli", agentPid: 58321, viaShell: true, sessionId: "a28d" });
    expect(result.ok && result.command).toBe(`${AGENTS_BIN} acp-session --agent kiro --tui 'kiro-cli chat -a --resume-id a28d'`);
  });

  it("resumes the session Kiro's processes hold, before one its state reported, and without any report", () => {
    const held = (registryId: string, pids: number[]) => registryId === "kiro" && pids.includes(58370) ? "held" : undefined;
    expect(plan(wrapped, { kiro: { state: "idle", externalSessionId: "older" } }, 42197, held)).toMatchObject({ ok: true, sessionId: "held" });
    expect(plan(wrapped, {}, 42197, held)).toMatchObject({ ok: true, sessionId: "held" });
    expect(plan([{ pid: 100, ppid: 1, args: "kiro-cli chat --resume-id named" }], {})).toMatchObject({ ok: true, sessionId: "named" });
  });

  it("respawns the pane when the pty wrapper runs Kiro itself: no shell stays to type into", () => {
    const result = plan([
      { pid: 1335, ppid: 1, args: "zsh (kiro-cli-term)" },
      { pid: 1362, ppid: 1335, args: "kiro-cli chat -a" },
    ], { kiro: { state: "idle", externalSessionId: "s" } }, 1335);
    expect(result).toMatchObject({ ok: true, agentPid: 1362, viaShell: false });
    expect(isPtyWrapper("zsh (kiro-cli-term)")).toBe(true);
    expect(isPtyWrapper("-zsh")).toBe(false);
  });

  it("reads which session a process holds from the lock files, the newest when two name it", () => {
    const directory = mkdtempSync(join(tmpdir(), "acp-restart-locks-"));
    try {
      writeFileSync(join(directory, "stale.lock"), JSON.stringify({ pid: 58370, started_at: "2026-06-01T00:00:00Z" }));
      utimesSync(join(directory, "stale.lock"), new Date("2026-06-01"), new Date("2026-06-01"));
      writeFileSync(join(directory, "live.lock"), JSON.stringify({ pid: 58370, started_at: "2026-11-06T10:47:05Z" }));
      writeFileSync(join(directory, "other.lock"), JSON.stringify({ pid: 1 }));
      writeFileSync(join(directory, "notes.json"), "{}");
      const locks = ["stale", "live", "other", "missing"].map((sessionId) => ({ sessionId, path: join(directory, `${sessionId}.lock`) }));
      expect(sessionHeldBy(locks, [58321, 58370])).toBe("live");
      expect(sessionHeldBy(locks, [2])).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finds Kiro's session locks where Kiro 2 and Kiro 3 keep them", () => {
    const root = mkdtempSync(join(tmpdir(), "kiro-sessions-"));
    try {
      mkdirSync(join(root, "cli"));
      writeFileSync(join(root, "cli", "a28d7390.lock"), JSON.stringify({ pid: 1 }));
      writeFileSync(join(root, "cli", "a28d7390.json"), "{}");
      // Kiro 3.1: <root>/<workspace hash>/<session>/.lock beside session.json; .index is no session.
      mkdirSync(join(root, "b46ad781d995a6ec", "sess_6200"), { recursive: true });
      mkdirSync(join(root, "b46ad781d995a6ec", ".index"), { recursive: true });
      mkdirSync(join(root, "b46ad781d995a6ec", "sess_closed"), { recursive: true });
      writeFileSync(join(root, "b46ad781d995a6ec", "sess_6200", ".lock"), JSON.stringify({ pid: 5024 }));
      writeFileSync(join(root, "b46ad781d995a6ec", ".index", ".lock"), "");
      expect(kiroSessionLocks(root).map((lock) => lock.sessionId).sort()).toEqual(["a28d7390", "sess_6200"]);
      expect(sessionHeldBy(kiroSessionLocks(root), [5011, 5024])).toBe("sess_6200");
      expect(kiroSessionLock("sess_6200", root)).toBe(join(root, "b46ad781d995a6ec", "sess_6200", ".lock"));
      expect(kiroSessionLock("sess_closed", root)).toBe(join(root, "cli", "sess_closed.lock"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
