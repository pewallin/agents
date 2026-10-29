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

  it("keeps a row whose executable name holds spaces", () => {
    vi.mocked(exec).mockReturnValue([
      "10 1 zsh (kiro-cli-term) ttys010 0.0 1024 zsh (kiro-cli-term)",
      "11 10 zsh ttys011 0.0 1024 -zsh",
    ].join("\n"));
    const tree = buildProcessTree();
    expect(tree.byPid.get(10)).toMatchObject({ comm: "zsh (kiro-cli-term)", tty: "ttys010", args: "zsh (kiro-cli-term)" });
    expect(tree.byPid.get(11)).toMatchObject({ comm: "zsh", tty: "ttys011", args: "-zsh" });
  });

  it("accepts a Copilot extension's report through the hook library's shells", () => {
    // npm's Copilot is a Node loader that runs the native binary; the extension runs as a child of
    // that binary and reports through `bash -c '… agents_hook_run "$@"' … copilot report …`.
    const hook = "/bin/bash -c . \"$1\"; shift; agents_hook_run \"$@\" agents-hook /repo/extensions/lib/agents-hook.sh copilot report --agent copilot --state idle --session %0";
    vi.mocked(exec).mockReturnValue([
      "10 1 zsh (kiro-cli-term) ttys010 0.0 1024 zsh (kiro-cli-term)",
      "11 10 zsh ttys011 0.0 1024 -zsh",
      "12 11 node ttys011 0.0 1024 node /usr/local/bin/copilot --yolo",
      "13 12 copilot ttys011 0.0 1024 /usr/local/lib/node_modules/@github/copilot-darwin-arm64/copilot --yolo",
      "14 13 copilot ttys011 0.0 1024 /usr/local/lib/node_modules/@github/copilot-darwin-arm64/copilot /cache/preloads/extension_bootstrap.mjs",
      `15 14 bash ttys011 0.0 1024 ${hook}`,
      `16 15 bash ttys011 0.0 1024 ${hook}`,
      "17 16 node ttys011 0.0 1024 node /repo/dist/cli.js report --agent copilot --state idle --session %0",
    ].join("\n"));
    expect(findPrimaryAgentForReporterInTree(10, 17, buildProcessTree())?.agentName).toBe("copilot");
  });

  it("rejects a Copilot that a Copilot started through a tool shell", () => {
    vi.mocked(exec).mockReturnValue([
      "10 1 zsh ttys010 0.0 1024 -zsh",
      "11 10 copilot ttys010 0.0 1024 copilot",
      "12 11 bash ?? 0.0 1024 bash -c copilot -p review",
      "13 12 copilot ?? 0.0 1024 copilot -p review",
      "14 13 node ?? 0.0 1024 node /repo/dist/cli.js report --agent copilot",
    ].join("\n"));
    expect(findPrimaryAgentForReporterInTree(10, 14, buildProcessTree())).toBeNull();
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
