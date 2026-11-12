import { describe, expect, it } from "vitest";
import { parseTerminalQuestion, SETTLE_MS, TerminalReader } from "./terminal-question.js";

// AgentsAppCore's TerminalQuestionTests.swift reads the same screens: keep them alike.
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

/** Claude Code 2.1.319's folder trust: a menu without numbers. */
const CLAUDE_TRUST_UNNUMBERED = `
────────────────────────────────────────────────────────────
 Accessing workspace:

 /private/tmp/anq/untrusted

 Quick safety check: Is this a project you created or one you trust?

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel



`;

/** A TUI's prompt with a message of two lines over its key hint. */
const COMPOSER = `
• Done.

› first line of a message
  second line

  enter to send · ctrl+j newline
`;

/** Codex shows the user's message beside its prompt mark: a numbered one is no menu. */
const CODEX_NUMBERED_MESSAGE = `
› 1. fix the bug
  2. add tests

• Working (3s • esc to interrupt)

› Ask Codex to do anything

  gpt-5.5 high · 85% context left
`;

const CLAUDE_IDLE = `
● Done: 1. built it, 2. tested it.

╭──────────────────────────────────────────────────────────╮
│ >                                                        │
╰──────────────────────────────────────────────────────────╯
  ? for shortcuts
`;

describe("parseTerminalQuestion", () => {
  it("reads Codex's hooks review", () => {
    expect(parseTerminalQuestion(CODEX_HOOKS)).toEqual({
      kind: "menu",
      text: [
        "Hooks need review", "1 hook is new or changed.", "Hooks can run outside the sandbox after you trust them.",
        "› 1. Review hooks", "2. Trust all and continue", "3. Continue without trusting (hooks won't run)",
      ],
    });
  });

  it("reads a menu inside a dialog's frame", () => {
    expect(parseTerminalQuestion(CLAUDE_TRUST)).toEqual({
      kind: "menu",
      text: ["Do you trust the files in this folder?", "/Users/peter/code/project", "❯ 1. Yes, proceed", "2. No, exit"],
    });
  });

  it("reads a menu without numbers above its Enter hint", () => {
    expect(parseTerminalQuestion(CLAUDE_TRUST_UNNUMBERED)).toEqual({
      kind: "menu",
      text: [
        "Accessing workspace:", "/private/tmp/anq/untrusted", "Quick safety check: Is this a project you created or one you trust?",
        "Claude Code'll be able to read, edit, and execute files here.", "Security guide",
        "❯ No, exit", "Yes, I trust this folder",
      ],
    });
    expect(parseTerminalQuestion(COMPOSER)).toBeNull();
    expect(parseTerminalQuestion("› only one\n\nEnter to confirm\n")).toBeNull();
    expect(parseTerminalQuestion("a\nb\n\nEnter to confirm\n")).toBeNull();
  });

  it("takes the selection wherever it is", () => {
    expect(parseTerminalQuestion("Pick one\n  1. A\n› 2. B\n  3. C\n")?.kind).toBe("menu");
  });

  it("takes no list without one selection, and none above a TUI's prompt or its output, for a menu", () => {
    expect(parseTerminalQuestion("Steps:\n1. Build it\n2. Test it\n3. Ship it\n")).toBeNull();
    expect(parseTerminalQuestion("> 1. quoted\n> 2. list\n")).toBeNull();
    expect(parseTerminalQuestion(CODEX_NUMBERED_MESSAGE)).toBeNull();
    expect(parseTerminalQuestion(CLAUDE_IDLE)).toBeNull();
    expect(parseTerminalQuestion("Pick one\n› 1. A\n  2. B\nline\nline\nline\nline\n")).toBeNull();
    expect(parseTerminalQuestion("ERROR: No saved session found with ID 0199.\n")).toBeNull();
  });

  it("reads a yes/no question on the last line", () => {
    expect(parseTerminalQuestion("Last login: today\n[oh-my-zsh] Would you like to update? [Y/n] \n\n\n")).toEqual({
      kind: "yes-no",
      text: ["Last login: today", "[oh-my-zsh] Would you like to update? [Y/n]"],
    });
    for (const line of ["Continue? [y/N] ", "Overwrite config (y/n)?", "Proceed [Y/n/q]:", "Really? (yes/no) ", "Delete it? [N/y]"]) {
      expect(parseTerminalQuestion(`some output\n${line}\n`)?.kind, line).toBe("yes-no");
    }
  });

  it("takes no yes/no question that is not on the last line or not at its end", () => {
    expect(parseTerminalQuestion("Continue? [y/N] y\nInstalling…\n")).toBeNull();
    expect(parseTerminalQuestion("The installer asks [Y/n] and then exits.\n")).toBeNull();
    expect(parseTerminalQuestion("Use [y/n] prompts sparingly\n$ \n")).toBeNull();
  });

  it("reads a line that asks for a key", () => {
    for (const line of ["Press Enter to continue", "Press any key to continue . . .", "Hit RETURN to go on", "press enter"]) {
      expect(parseTerminalQuestion(`Logged in.\n${line}\n`)?.kind, line).toBe("continue");
    }
    expect(parseTerminalQuestion("To go on, press Enter\n")).toBeNull();
    expect(parseTerminalQuestion("Press Enter to continue\n$ \n")).toBeNull();
  });

  it("reads nothing on an empty screen", () => {
    expect(parseTerminalQuestion("\n\n  \n")).toBeNull();
  });
});

describe("TerminalReader", () => {
  const reader = (screen: () => string, modified: () => number | undefined, now: () => number, tty: string | undefined = "/dev/ttys001") => {
    let captures = 0;
    const read = new TerminalReader("%1", {
      tty: () => tty,
      modified,
      capture: () => { captures += 1; return screen(); },
      now,
    });
    return { read: () => read.read(), captures: () => captures };
  };

  it("captures a screen once per change, after it has come to rest", () => {
    let modified = 1_000;
    let now = 1_000 + SETTLE_MS;
    let screen = CODEX_HOOKS;
    const pane = reader(() => screen, () => modified, () => now);
    expect(pane.read().question?.kind).toBe("menu");
    expect(pane.read().question?.kind).toBe("menu");
    expect(pane.captures()).toBe(1);
    // Answered: the screen moves, and asks nothing while it does.
    screen = "• Working (1s • esc to interrupt)\n› Ask Codex\n";
    modified = now;
    now += 100;
    expect(pane.read().question).toBeNull();
    expect(pane.captures()).toBe(1);
    now += SETTLE_MS;
    expect(pane.read()).toEqual({ question: null, tail: ["• Working (1s • esc to interrupt)", "› Ask Codex"] });
    expect(pane.captures()).toBe(2);
  });

  it("captures every time when the pane's tty cannot be read", () => {
    const pane = reader(() => "Continue? [y/N]\n", () => undefined, () => 0, undefined);
    expect(pane.read().question?.kind).toBe("yes-no");
    expect(pane.read().question?.kind).toBe("yes-no");
    expect(pane.captures()).toBe(2);
  });
});
