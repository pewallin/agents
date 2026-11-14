// @ts-nocheck
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeControlParams, topicHelp } from "./app-commands.js";
import { parseCommand } from "./command.js";

describe("agents app commands", () => {
  it("reads a bare pane number as a local pane", () => {
    expect(normalizeControlParams("pane.close", { pane: "%5" }).pane).toBe("local:%5");
    expect(normalizeControlParams("pane.close", { pane: "5" }).pane).toBe("local:%5");
    expect(normalizeControlParams("pane.move", { pane: "local:%5", beside: "%2" }).beside).toBe("local:%2");
  });

  it("turns a direction into a split", () => {
    expect(normalizeControlParams("workspace.open-web-page", { url: "localhost:3000", direction: "down" }))
      .toEqual({ url: "localhost:3000", axis: "vertical", placement: "split" });
    expect(normalizeControlParams("workspace.split-active-pane", { direction: "right" })).toEqual({ axis: "horizontal" });
  });

  it("resolves paths where the command runs", () => {
    expect(normalizeControlParams("workspace.open-file-preview", { path: "README.md" }).path).toBe(path.resolve("README.md"));
    expect(normalizeControlParams("workspace.create", { cwd: "~/src" }).cwd).toBe(path.join(os.homedir(), "src"));
  });

  it("parses the commands an agent reaches for", () => {
    expect(parseCommand(["ls"])).toEqual({ kind: "ls" });
    expect(parseCommand(["open", "README.md", "--direction", "right"]))
      .toEqual({ kind: "invoke", controlID: "workspace.open-file-preview", params: { direction: "right", path: "README.md" } });
    expect(parseCommand(["open", "localhost:8080"]).controlID).toBe("workspace.open-web-page");
    expect(parseCommand(["open", "https://example.com"]).controlID).toBe("workspace.open-web-page");
    expect(parseCommand(["workspace", "rename", "Shop work"]))
      .toEqual({ kind: "invoke", controlID: "workspace.rename", params: { name: "Shop work" } });
    expect(parseCommand(["workspace", "new", "--cwd", "../api", "--name", "API"]))
      .toEqual({ kind: "workspace-new", params: { cwd: "../api", name: "API" } });
    expect(parseCommand(["review", "--base", "main"])).toEqual({ kind: "review", params: { base: "main" } });
    expect(parseCommand(["surface", "send-text", "ls", "--pane", "%1", "--submit"]))
      .toEqual({ kind: "invoke", controlID: "surface.send-text", params: { pane: "%1", submit: "true", text: "ls" } });
  });

  it("answers --help with the command's own help", () => {
    expect(parseCommand(["workspace", "split", "--help"])).toEqual({ kind: "help", topic: "workspace" });
    expect(parseCommand(["controls", "invoke", "pane.close", "--help"])).toEqual({ kind: "help", topic: "pane.close" });
    expect(parseCommand(["help", "review"])).toEqual({ kind: "help", topic: "review" });
    expect(topicHelp("review")).toContain("diff view");
  });
});
