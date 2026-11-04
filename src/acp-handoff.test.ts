import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  });
});
