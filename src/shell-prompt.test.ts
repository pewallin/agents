import { describe, expect, it } from "vitest";
import { parseTtyMode, readPaneLook, shellState, STILL_PROMPT_MS, type PaneLook } from "./shell-prompt.js";

const look = (screen: string, cursorX: number, cursorY: number, alternate = false): PaneLook => ({ tty: "/dev/ttys001", alternate, cursorX, cursorY, screen });
const lineEditor = { canonical: false, echo: false };
const readLine = { canonical: true, echo: true };
const readKey = { canonical: false, echo: true };

// macOS `stty -a` and Linux `stty -a`, abridged.
const MAC_STTY_PROMPT = "speed 38400 baud; 40 rows; 120 columns;\nlflags: -icanon isig -iexten -echo echoe echok echoke -echonl echoctl\n\t-echoprt -altwerase -noflsh -tostop -flusho -pendin -nokerninfo\n";
const MAC_STTY_READ = "speed 38400 baud; 40 rows; 120 columns;\nlflags: icanon isig iexten echo echoe -echok echoke -echonl echoctl\n";
const LINUX_STTY_READ = "speed 38400 baud; rows 40; columns 120; line = 0;\nisig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop -echoprt\n";

describe("shellState", () => {
  it("takes a line editor waiting for a command for the prompt, whatever the prompt looks like", () => {
    expect(shellState(look("🖥 mac-mini ➜ /tmp/proj git:(main) ✗ ", 33, 0), lineEditor, 0)).toBe("prompt");
    expect(shellState(look("", 0, 0), lineEditor, 0)).toBe("prompt");
  });

  it("never takes a question for the prompt, line editor or not", () => {
    const question = look("Last login: today\n[oh-my-zsh] Would you like to update? [Y/n] ", 46, 1);
    expect(shellState(question, readKey, 5_000)).toBe("question");
    expect(shellState(question, lineEditor, 5_000)).toBe("question");
  });

  it("does not take a read in a startup file for the prompt, even one that asks no recognised question", () => {
    expect(shellState(look("Enter your name: ", 17, 0), readLine, 5_000)).toBe("busy");
    expect(shellState(look("Pick a profile> ", 16, 0), readKey, 5_000)).toBe("busy");
  });

  it("does not take a full-screen program for the prompt", () => {
    expect(shellState(look("% ", 2, 0, true), lineEditor, 5_000)).toBe("busy");
  });

  it("takes a still prompt mark with the cursor after it for the prompt of a shell without a line editor", () => {
    const dash = look("$ ", 2, 0);
    expect(shellState(dash, readLine, STILL_PROMPT_MS)).toBe("prompt");
    expect(shellState(dash, undefined, STILL_PROMPT_MS)).toBe("prompt");
    expect(shellState(dash, readLine, STILL_PROMPT_MS - 1)).toBe("busy");
    // The cursor elsewhere, or output under it: a program still running.
    expect(shellState(look("$ ", 0, 0), readLine, STILL_PROMPT_MS)).toBe("busy");
    expect(shellState(look("$ \nloading…", 2, 0), readLine, STILL_PROMPT_MS)).toBe("busy");
    expect(shellState(look("Loading plugins", 15, 0), readLine, STILL_PROMPT_MS)).toBe("busy");
  });
});

describe("parseTtyMode", () => {
  it("reads canonical input and echo from stty -a on macOS and Linux", () => {
    expect(parseTtyMode(MAC_STTY_PROMPT)).toEqual(lineEditor);
    expect(parseTtyMode(MAC_STTY_READ)).toEqual(readLine);
    expect(parseTtyMode(LINUX_STTY_READ)).toEqual(readLine);
    expect(parseTtyMode("stty: /dev/ttys001: Operation not permitted")).toBeUndefined();
  });
});

describe("readPaneLook", () => {
  it("keeps the screen's leading blank lines, which the cursor's row counts", () => {
    const answers: Record<string, string> = { "display-message": "/dev/ttys004\t0\t2\t2", "capture-pane": "\n\n% \n\n" };
    expect(readPaneLook("%4", (args) => answers[args[0]])).toEqual({ tty: "/dev/ttys004", alternate: false, cursorX: 2, cursorY: 2, screen: "\n\n% \n\n" });
    expect(readPaneLook("%4", () => undefined)).toBeUndefined();
  });
});
