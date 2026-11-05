import { describe, expect, it } from "vitest";
import { agentWords, codexResumeCommand, planAcpRestart, type PaneProcess } from "./acp-restart.js";

const AGENTS_BIN = "/Users/me/.agents/agents-cli/app/agents";

function plan(processes: PaneProcess[], state: Record<string, { state?: string; externalSessionId?: string }>, panePid = 100) {
  return planAcpRestart({ paneId: "%7", panePid, processes, stateOf: (agent) => state[agent], agentsCommand: AGENTS_BIN });
}

describe("acp-restart", () => {
  it("names an agent by its executable, or by the script node runs", () => {
    expect(agentWords("/opt/homebrew/bin/claude --model opus")).toEqual({ name: "claude", words: ["/opt/homebrew/bin/claude", "--model", "opus"] });
    expect(agentWords("node /Users/me/.nvm/versions/node/v24/bin/codex --model gpt-6.1 -a never")).toEqual({ name: "codex", words: ["codex", "--model", "gpt-6.1", "-a", "never"] });
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
      command: `${AGENTS_BIN} codex-session --command 'codex --model gpt-6.1 resume thread-1'`,
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
});
