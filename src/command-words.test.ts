import { describe, expect, it } from "vitest";
import { commandWords, shellCommand, splitCommandArgv } from "./command-words.js";

describe("command words", () => {
  it("keeps a quoted value one word", () => {
    expect(commandWords(`claude --append-system-prompt "be brief" --model 'opus 4'`)).toEqual(["claude", "--append-system-prompt", "be brief", "--model", "opus 4"]);
    expect(commandWords(`kiro-cli chat --agent=a\\ b ""`)).toEqual(["kiro-cli", "chat", "--agent=a b", ""]);
    expect(commandWords(undefined)).toEqual([]);
    expect(commandWords(`x "open`)).toEqual(["x", "open"]);
  });

  it("refuses an unfinished command for running it", () => {
    expect(() => splitCommandArgv(`x "open`)).toThrow(/unterminated quote/);
    expect(() => splitCommandArgv(`x \\`)).toThrow(/trailing escape/);
    expect(() => splitCommandArgv("  ")).toThrow(/No command/);
  });

  it("goes back to a command that reads the same", () => {
    const words = ["claude", "--append-system-prompt", "it's brief", "~/bin", "$HOME/x"];
    expect(shellCommand(words)).toBe(`claude --append-system-prompt 'it'\\''s brief' ~/bin $HOME/x`);
    expect(commandWords(shellCommand(["a b", "c"]))).toEqual(["a b", "c"]);
  });
});
