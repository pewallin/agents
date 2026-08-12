import { describe, expect, it } from "vitest";
import {
  buildTmuxPaneCommandMetadata,
  parseTmuxPaneReportMetadata,
  tmuxPaneCommandLaunchSetOptionArguments,
  tmuxPaneCommandMetadataSetOptionArguments,
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

  it("parses pane ownership evidence without treating legacy metadata as launcher-owned", () => {
    expect(parseTmuxPaneReportMetadata([
      "/Users/peter/code/shape",
      "pi",
      "agent",
      "",
      "zsh",
    ].join("\u001f"))).toEqual({
      paneCwd: "/Users/peter/code/shape",
      commandId: "pi",
      commandContentKind: "agent",
      foregroundCommand: "zsh",
    });
  });
});
