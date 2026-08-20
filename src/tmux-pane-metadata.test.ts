import { describe, expect, it } from "vitest";
import {
  buildTmuxPaneCommandMetadata,
  parseTmuxPaneReportMetadata,
  tmuxPaneBackfillLaunchCommand,
  tmuxPaneCommandLaunchSetOptionArguments,
  tmuxPaneCommandMetadataSetOptionArguments,
  tmuxPaneRestoredAgentMetadataSetOptionArguments,
} from "./tmux-pane-metadata.js";

describe("tmux pane command metadata", () => {
  it("classifies supported agent commands as agent panes", () => {
    const metadata = buildTmuxPaneCommandMetadata({
      command: "pi --yolo",
      launchCommand: "pi --yolo",
      cwd: "/repo",
    });

    expect(metadata).toEqual({
      id: "pi",
      title: "Pi",
      contentKind: "agent",
      cwd: "/repo",
      launchCommand: "pi --yolo",
    });
  });

  it("normalizes kiro command names to the shared agent id", () => {
    const metadata = buildTmuxPaneCommandMetadata({
      command: "kiro-cli chat --tui",
      cwd: "/repo",
    });

    expect(metadata.id).toBe("kiro");
    expect(metadata.title).toBe("Kiro");
    expect(metadata.contentKind).toBe("agent");
  });

  it("renders tmux set-option calls for app inventory metadata", () => {
    const metadata = buildTmuxPaneCommandMetadata({
      agent: "pi",
      command: "pi",
      cwd: "/repo",
    });

    expect(tmuxPaneCommandMetadataSetOptionArguments("%37", metadata)).toContainEqual([
      "set-option",
      "-p",
      "-q",
      "-t",
      "%37",
      "@agents_command_content_kind",
      "agent",
    ]);
    expect(tmuxPaneCommandMetadataSetOptionArguments("%37", metadata)).toContainEqual([
      "set-option",
      "-p",
      "-q",
      "-t",
      "%37",
      "@agents_command_owner",
      "launcher",
    ]);
  });

  it("renders narrow launch metadata updates without replacing inventory identity", () => {
    expect(tmuxPaneCommandLaunchSetOptionArguments("%37", "codex resume thread-123", "/repo")).toEqual([
      ["set-option", "-p", "-q", "-t", "%37", "@agents_command_cwd", "/repo"],
      ["set-option", "-p", "-q", "-t", "%37", "@agents_command_launch", "codex resume thread-123"],
    ]);
  });

  it("claims app ownership only through the restore-specific metadata path", () => {
    const args = tmuxPaneRestoredAgentMetadataSetOptionArguments("%25", {
      agent: "codex",
      command: "codex resume saved-thread",
      launchCommand: "codex resume saved-thread",
      cwd: "/repo",
    });

    expect(args).toContainEqual([
      "set-option", "-p", "-q", "-t", "%25", "@agents_command_owner", "launcher",
    ]);
    expect(args).toContainEqual([
      "set-option", "-p", "-q", "-t", "%25", "@agents_owned", "app_owned",
    ]);
  });

  it("only preserves a specific backfill launch when it belongs to the reported agent", () => {
    expect(tmuxPaneBackfillLaunchCommand("kiro", "kiro-cli chat -a --v3")).toBe("kiro-cli chat -a --v3");
    expect(tmuxPaneBackfillLaunchCommand("codex", "pi --yolo")).toBe("codex");
  });

  it("parses pane ownership evidence without treating legacy metadata as launcher-owned", () => {
    expect(parseTmuxPaneReportMetadata([
      "/Users/peter/code/shape",
      "pi",
      "agent",
      "",
      "zsh",
      "app_owned",
      "pi --yolo --session session-123",
    ].join("\u001f"))).toEqual({
      paneCwd: "/Users/peter/code/shape",
      paneOwner: "app_owned",
      commandId: "pi",
      commandContentKind: "agent",
      commandLaunch: "pi --yolo --session session-123",
      foregroundCommand: "zsh",
    });
  });
});
