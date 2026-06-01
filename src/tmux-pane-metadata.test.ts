import { describe, expect, it } from "vitest";
import {
  buildTmuxPaneCommandMetadata,
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
  });
});
