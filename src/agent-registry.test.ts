import { describe, expect, it } from "vitest";
import { acpViewAgent, agentLaunchCommand, handOffAgentId, normalizeAgentName, sameAgent } from "./agent-registry.js";

describe("the agent registry", () => {
  it("names an agent from its executable, path or reported name", () => {
    expect(normalizeAgentName("/opt/kiro/bin/kiro-cli")).toBe("kiro");
    expect(normalizeAgentName("kiro-cli-chat")).toBe("kiro");
    expect(normalizeAgentName("'Claude'")).toBe("claude");
    expect(normalizeAgentName("-zsh")).toBe("zsh");
    expect(normalizeAgentName("  ")).toBeUndefined();
    expect(sameAgent("kiro", "kiro-cli")).toBe(true);
    expect(sameAgent("codex", undefined)).toBe(false);
  });

  it("shares Codex live and hands every other agent over", () => {
    expect(acpViewAgent("codex")).toMatchObject({ registryId: "codex-acp", live: true });
    expect(handOffAgentId("codex")).toBeUndefined();
    expect(handOffAgentId("/usr/local/bin/kiro-cli")).toBe("kiro");
    expect(handOffAgentId("copilot")).toBe("github-copilot-cli");
    expect(handOffAgentId("zsh")).toBeUndefined();
  });

  it("runs an agent under the wrapper of its ACP view", () => {
    expect(agentLaunchCommand("codex --yolo", ["agents"])).toBe("agents codex-session --command 'codex --yolo'");
    expect(agentLaunchCommand(`claude --append-system-prompt "be brief"`, ["/a b/agents"]))
      .toBe(`'/a b/agents' acp-session --agent claude-acp --tui 'claude --append-system-prompt "be brief"'`);
    expect(agentLaunchCommand("htop", ["agents"])).toBe("htop");
    expect(agentLaunchCommand("claude", [])).toBe("claude");
  });
});
