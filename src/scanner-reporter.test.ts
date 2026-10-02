import { describe, expect, it, vi } from "vitest";
import { buildProcessTree, findPrimaryAgentForReporterInTree } from "./scanner-discovery.js";
import { exec } from "./shell.js";

vi.mock("./shell.js", () => ({ exec: vi.fn(), execAsync: vi.fn(), execFileCapture: vi.fn() }));

describe("live reporter process chains", () => {
  it("reads executable names without macOS comm path truncation", () => {
    vi.mocked(exec).mockReturnValue("10 1 zsh ttys010 0.0 1024 zsh (kiro-cli-term)");
    expect(buildProcessTree().byPid.get(10)?.comm).toBe("zsh");
    expect(exec).toHaveBeenLastCalledWith(expect.stringContaining("ucomm="));
  });

  it("accepts Kiro v3 ACP hooks through its bundled Bun TUI", () => {
    vi.mocked(exec).mockReturnValue([
      "10 1 zsh ttys010 0.0 1024 zsh (kiro-cli-term)",
      "11 10 zsh ttys011 0.0 1024 /bin/zsh --login",
      "12 11 kiro-cli ttys011 0.0 1024 kiro-cli chat",
      "13 12 kiro-cli-chat ttys011 0.0 1024 /home/operator/.local/bin/kiro-cli-chat chat",
      "14 13 bun ttys011 0.0 1024 /home/operator/Library/Application Support/kiro-cli/bun /home/operator/Library/Application Support/kiro-cli/tui.js chat",
      "15 14 kiro-cli-chat ?? 0.0 1024 /home/operator/.local/bin/kiro-cli-chat acp",
      "16 15 bash ?? 0.0 1024 bash /repo/extensions/kiro/report-state.sh",
      "17 16 node ?? 0.0 1024 node /repo/dist/cli.js report --agent kiro",
    ].join("\n"));
    expect(findPrimaryAgentForReporterInTree(10, 17, buildProcessTree())?.agentName).toBe("kiro");
  });

  it("rejects a nested Kiro launched through a tool shell", () => {
    vi.mocked(exec).mockReturnValue([
      "10 1 kiro-cli ttys010 0.0 1024 kiro-cli chat",
      "11 10 bash ?? 0.0 1024 bash -c kiro-cli chat",
      "12 11 kiro-cli-chat ?? 0.0 1024 kiro-cli-chat chat",
      "13 12 node ?? 0.0 1024 node /repo/dist/cli.js report --agent kiro",
    ].join("\n"));
    expect(findPrimaryAgentForReporterInTree(10, 13, buildProcessTree())).toBeNull();
  });

  it("rejects a nested Kiro reached through an unrelated Bun script", () => {
    vi.mocked(exec).mockReturnValue([
      "10 1 kiro-cli ttys010 0.0 1024 kiro-cli chat",
      "11 10 bun ?? 0.0 1024 /usr/local/bin/bun /tmp/tool.js",
      "12 11 kiro-cli-chat ?? 0.0 1024 kiro-cli-chat chat",
      "13 12 node ?? 0.0 1024 node /repo/dist/cli.js report --agent kiro",
    ].join("\n"));
    expect(findPrimaryAgentForReporterInTree(10, 13, buildProcessTree())).toBeNull();
  });
});
