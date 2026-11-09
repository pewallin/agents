import { describe, expect, it } from "vitest";
import { answerTerminalPrompt, keysForOption, parseTerminalPrompt, readTerminalScreen } from "./terminal-prompt.js";

const CODEX_HOOKS = `
  Hooks need review
  1 hook is new or changed.
  Hooks can run outside the sandbox after you trust them.


› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)

  enter confirm · esc skip


`;

const CLAUDE_TRUST = `
╭──────────────────────────────────────────────────────────╮
│ Do you trust the files in this folder?                   │
│                                                          │
│ /Users/peter/code/project                                │
│                                                          │
│ ❯ 1. Yes, proceed                                        │
│   2. No, exit                                            │
│                                                          │
│ Enter to confirm · Esc to exit                           │
╰──────────────────────────────────────────────────────────╯
`;

describe("parseTerminalPrompt", () => {
  it("reads Codex's hooks review", () => {
    expect(parseTerminalPrompt(CODEX_HOOKS)).toEqual({
      text: ["Hooks need review", "1 hook is new or changed.", "Hooks can run outside the sandbox after you trust them."],
      options: [
        { index: 1, label: "Review hooks", selected: true },
        { index: 2, label: "Trust all and continue", selected: false },
        { index: 3, label: "Continue without trusting (hooks won't run)", selected: false },
      ],
      hint: ["enter confirm · esc skip"],
    });
  });

  it("reads a menu inside a dialog's frame", () => {
    const prompt = parseTerminalPrompt(CLAUDE_TRUST);
    expect(prompt?.text).toEqual(["Do you trust the files in this folder?", "/Users/peter/code/project"]);
    expect(prompt?.options).toEqual([
      { index: 1, label: "Yes, proceed", selected: true },
      { index: 2, label: "No, exit", selected: false },
    ]);
    expect(prompt?.hint).toEqual(["Enter to confirm · Esc to exit"]);
  });

  it("takes no numbered list without a selection for a menu", () => {
    expect(parseTerminalPrompt("Steps:\n1. Build it\n2. Test it\n3. Ship it\n")).toBeNull();
    expect(parseTerminalPrompt("> 1. quoted\n> 2. list\n")).toBeNull();
    expect(parseTerminalPrompt("ERROR: No saved session found with ID 0199.\n")).toBeNull();
  });

  it("takes the selection wherever it is", () => {
    const prompt = parseTerminalPrompt("Pick one\n  1. A\n› 2. B\n  3. C\n");
    expect(prompt?.options.map((option) => option.selected)).toEqual([false, true, false]);
  });
});

describe("keysForOption", () => {
  const prompt = parseTerminalPrompt(CODEX_HOOKS)!;

  it("moves from the selected option to the one picked, then confirms", () => {
    expect(keysForOption(prompt, 1)).toEqual(["Enter"]);
    expect(keysForOption(prompt, 3)).toEqual(["Down", "Down", "Enter"]);
    expect(keysForOption(parseTerminalPrompt("Q\n  1. A\n› 2. B\n")!, 1)).toEqual(["Up", "Enter"]);
  });

  it("has no keys for an option the menu has not", () => {
    expect(keysForOption(prompt, 4)).toBeUndefined();
  });
});

describe("readTerminalScreen", () => {
  it("keeps the last lines of a screen without a menu", () => {
    const screen = readTerminalScreen("%1", () => "\n\nERROR: No saved session found with ID x.\n\n");
    expect(screen).toEqual({ prompt: null, tail: ["ERROR: No saved session found with ID x."] });
  });
});

describe("answerTerminalPrompt", () => {
  it("sends the keys of the option when the screen still shows it", async () => {
    const sent: string[][] = [];
    const answer = await answerTerminalPrompt("%1", 2, "Trust all and continue", {
      read: () => CODEX_HOOKS,
      send: (_pane, keys) => sent.push(keys),
      settleMs: 0,
    });
    expect(answer.ok).toBe(true);
    expect(sent).toEqual([["Down"], ["Enter"]]);
  });

  it("sends nothing when the option is not on the screen any more", async () => {
    const sent: string[][] = [];
    const answer = await answerTerminalPrompt("%1", 2, "Trust all and continue", {
      read: () => CLAUDE_TRUST,
      send: (_pane, keys) => sent.push(keys),
      settleMs: 0,
    });
    expect(answer.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});
