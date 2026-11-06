import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACP_AGENTS } from "./acp-host-cli.js";
import { reportedAgentState, TranscriptPrinter } from "./acp-handoff.js";

describe("acp hand-off", () => {
  it("resumes each agent's TUI on the session, keeping the pane's own options", () => {
    expect(ACP_AGENTS["claude-acp"].resume!("claude --model opus --continue", "abc")).toBe("claude --model opus --resume abc");
    expect(ACP_AGENTS["claude-acp"].resume!("claude --resume old-id", "abc")).toBe("claude --resume abc");
    expect(ACP_AGENTS.opencode.resume!("opencode -s ses_old", "ses_new")).toBe("opencode --session ses_new");
    expect(ACP_AGENTS["pi-acp"].resume!("pi --continue", "019a")).toBe("pi --session 019a");
    expect(ACP_AGENTS["github-copilot-cli"].resume!("copilot", "x y")).toBe("copilot --resume 'x y'");
  });

  it("shares Codex live and hands every other agent over", () => {
    expect(ACP_AGENTS["codex-acp"].resume).toBeUndefined();
    for (const id of ["claude-acp", "opencode", "pi-acp", "github-copilot-cli", "kiro"]) {
      expect(ACP_AGENTS[id].resume, id).toBeDefined();
    }
  });

  it("reads the agent's reported state in the pane", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-state-"));
    writeFileSync(join(dir, "opencode-%3.json"), JSON.stringify({ state: "working" }));
    expect(reportedAgentState("opencode", "%3", dir)).toBe("working");
    expect(reportedAgentState("opencode", "%4", dir)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the view's conversation as plain text", () => {
    let out = "";
    const printer = new TranscriptPrinter((text) => { out += text; });
    const update = (sessionUpdate: string, extra: object) =>
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate, ...extra } } });
    printer.clientLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "Hej" }] } }));
    printer.agentLine(update("agent_message_chunk", { content: { type: "text", text: "Hej " } }));
    printer.agentLine(update("agent_message_chunk", { content: { type: "text", text: "själv" } }));
    printer.agentLine(update("tool_call", { toolCallId: "t", title: "Read README.md" }));
    printer.agentLine("not json");
    expect(out).toBe("\n\n› Hej\n\n• Hej själv\n  ⚙ Read README.md");
    out = "";
    printer.agentLine(update("session_info_update", { title: "Fix the\nlogin" }));
    expect(out).toBe("\x1b]2;Fix the login\x07");
  });
});

describe("the session a TUI command picks", () => {
  it("is the id it names, unknown when it names none, and none for a new session", () => {
    const claude = ACP_AGENTS["claude-acp"].pickedSession!;
    expect(claude("claude --model opus")).toBeUndefined();
    expect(claude("claude --resume abc-1")).toBe("abc-1");
    expect(claude("claude --session-id=abc-2 --model opus")).toBe("abc-2");
    expect(claude("claude --continue")).toBe("unknown");
    expect(claude("claude --resume")).toBe("unknown");
    expect(ACP_AGENTS.opencode.pickedSession!("opencode --fork ses_1")).toBe("unknown");
  });
});

describe("a session Claude Code named but never wrote", () => {
  it("is known by its file in Claude's projects", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      mkdirSync(join(dir, "projects", "-tmp-proj"), { recursive: true });
      writeFileSync(join(dir, "projects", "-tmp-proj", "written.jsonl"), "{}\n");
      const written = ACP_AGENTS["claude-acp"].sessionWritten!;
      expect(written("written")).toBe(true);
      expect(written("named-only")).toBe(false);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("view activity in the app", () => {
  it("reports a question waiting in the view as approval, so the app's needs-you dot lights", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { reportViewActivity } = await import("./acp-host-cli.js");
    const dir = mkdtempSync(join(tmpdir(), "acp-activity-"));
    const previous = process.env.AGENTS_STATE_DIR;
    process.env.AGENTS_STATE_DIR = dir;
    try {
      const report = reportViewActivity("codex", "%7");
      report("needs-you");
      expect(JSON.parse(readFileSync(join(dir, "codex-%7.json"), "utf8")).state).toBe("approval");
      report("working");
      const written = JSON.parse(readFileSync(join(dir, "codex-%7.json"), "utf8"));
      expect(written.state).toBe("working");
      // The app reads a context as text: a report of its own carries none.
      expect(written.context).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.AGENTS_STATE_DIR; else process.env.AGENTS_STATE_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("waitForLockRelease", () => {
  it("goes on once the lock is gone or names an ended process, and waits while its process lives", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { waitForLockRelease } = await import("./acp-handoff.js");
    const dir = mkdtempSync(join(tmpdir(), "acp-lock-"));
    const lock = join(dir, "s.lock");
    expect(await waitForLockRelease(lock, 200)).toBe(true);
    writeFileSync(lock, String(process.pid));
    expect(await waitForLockRelease(lock, 300)).toBe(false);
    writeFileSync(lock, JSON.stringify({ pid: 999999 }));
    expect(await waitForLockRelease(lock, 300)).toBe(true);
    writeFileSync(lock, String(process.pid));
    setTimeout(() => rmSync(lock, { force: true }), 150);
    expect(await waitForLockRelease(lock, 2_000)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("tailOf", () => {
  it("reads a log's last lines, and says why when it cannot", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { tailOf } = await import("./acp-host.js");
    const dir = mkdtempSync(join(tmpdir(), "acp-tail-"));
    const file = join(dir, "a.log");
    writeFileSync(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
    expect(tailOf(file, 3)).toEqual(["line 97", "line 98", "line 99"]);
    expect(tailOf(join(dir, "missing.log"), 3)[0]).toMatch(/^\(ENOENT/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("kiroAcpArgs", () => {
  it("starts kiro-cli acp on the engine the pane's TUI runs, v3 with the CLI's own login", async () => {
    const { kiroAcpArgs, ACP_AGENTS: agents } = await import("./acp-host-cli.js");
    expect(kiroAcpArgs("kiro-cli chat -a --v3 --resume-id sess_1")).toEqual(["acp", "--agent-engine", "v3", "--auth-method", "cli"]);
    expect(kiroAcpArgs("kiro-cli chat --agent-engine v2")).toEqual(["acp", "--agent-engine", "v2"]);
    expect(kiroAcpArgs("kiro-cli chat --agent-engine=v3")).toEqual(["acp", "--agent-engine", "v3", "--auth-method", "cli"]);
    expect(kiroAcpArgs("kiro-cli chat")).toEqual(["acp"]);
    expect(kiroAcpArgs(undefined)).toEqual(["acp"]);
    const command = agents.kiro.command({ tuiCommand: "/opt/kiro/bin/kiro-cli chat -a --v3 --resume-id sess_1", runtimeTempDir: "/tmp" });
    expect(command.command).toBe("/opt/kiro/bin/kiro-cli");
    expect(command.args).toEqual(["acp", "--agent-engine", "v3", "--auth-method", "cli"]);
  });
});

describe("copilotAcpArgs", () => {
  it("starts copilot --acp with the TUI's options that shape a session, and none of its others", async () => {
    const { copilotAcpArgs } = await import("./acp-host-cli.js");
    expect(copilotAcpArgs("copilot --model gpt-5.6 --allow-all-tools --resume abc --effort=high --banner"))
      .toEqual(["--acp", "--model", "gpt-5.6", "--allow-all-tools", "--effort=high"]);
    expect(copilotAcpArgs("copilot --yolo --no-sandbox --add-dir /code")).toEqual(["--acp", "--yolo", "--no-sandbox", "--add-dir", "/code"]);
    expect(copilotAcpArgs("copilot")).toEqual(["--acp"]);
    expect(copilotAcpArgs(undefined)).toEqual(["--acp"]);
  });
});
