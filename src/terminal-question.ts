// What a pane's terminal asks while the pane shows its ACP view: a question its agent's TUI, or
// the shell before the agent starts, waits on. A question in the terminal is answered in the
// terminal: the view asks Agents Next to show it (docs/acp-view-client.md, "A question in the
// terminal"), and the app goes back to the view once it is answered.
//
// Agents Next reads the pane by the same rules before the view's host is up and while it waits
// for the answer (AgentsAppCore's TerminalQuestion.swift): change them together.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

/**
 *   menu      a numbered menu with one option selected (Codex's "Hooks need review", Claude's
 *             folder trust), at the bottom of the screen
 *   yes-no    a last line that ends in [Y/n], (y/N) and the like (a shell's `read -q`, an updater)
 *   continue  a last line that starts with "Press Enter" or "Press any key"
 */
export type TerminalQuestionKind = "menu" | "yes-no" | "continue";

export interface TerminalQuestion {
  kind: TerminalQuestionKind;
  /** The question's lines as the screen shows them, without a dialog's frame. */
  text: string[];
}

export interface TerminalScreen {
  /** The question the terminal waits on, if it shows one. */
  question: TerminalQuestion | null;
  /** The last lines on the pane's screen, for an agent stuck without a question (an error it stopped on). */
  tail: string[];
}

/** The marks TUIs put beside the selected option of a menu. */
const SELECTED_MARKS = "›❯▶➤➜→>";
const OPTION_LINE = new RegExp(`^([${SELECTED_MARKS}])?\\s*(\\d{1,2})[.)]\\s+(\\S.*)$`);
/** A line that starts with a selection mark: a TUI's prompt, which no menu has under it. */
const MARKED_LINE = new RegExp(`^[${SELECTED_MARKS}](\\s|$)`);
/** How many lines a menu has under its options at most: its key hints. */
const MENU_HINT_LINES = 3;
/** A menu's key hint: Enter picks the selected option ("Enter to confirm", "enter confirm"). */
const ENTER_HINT = /\benter\b.{0,12}\b(?:confirm|select|choose|continue|accept)/i;
/** How many options a menu without numbers has at most. */
const MENU_OPTIONS = 9;
/** y/n in brackets at the end of the line ([Y/n], (y/N), [yes/no], [y/n/q], [N/y]), then ":", "?" or ">". */
const YES_NO = /[[(]\s*(?:(?:y|yes)\s*\/\s*(?:n|no)(?:\s*\/\s*\w+)*|(?:n|no)\s*\/\s*(?:y|yes))\s*[\])]\s*[:?>]?$/i;
/** "Press Enter to continue", "Press any key…", "Hit return": a whole line, and a short one. */
const CONTINUE = /^(?:press|hit)\s+(?:enter|return|any key|a key)\b.{0,60}$/i;
/** A dialog's frame: box-drawing characters and the spaces inside them. */
const FRAME = /^[\s│┃║|╭╮╰╯┌┐└┘─━═]+|[\s│┃║|╭╮╰╯┌┐└┘─━═]+$/g;

function clean(line: string): string {
  return line.replace(FRAME, "");
}

function nonEmpty(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

/**
 * The question on a pane's screen, read from its last lines: a question waits at the bottom of
 * the screen, where the cursor is. An agent's own output above its prompt is not one.
 */
export function parseTerminalQuestion(screen: string): TerminalQuestion | null {
  const lines = screen.split("\n").map(clean);
  const shown = nonEmpty(lines).map((line) => line.trim());
  const last = shown.at(-1);
  if (!last) return null;
  if (YES_NO.test(last)) return { kind: "yes-no", text: shown.slice(-4) };
  if (CONTINUE.test(last)) return { kind: "continue", text: shown.slice(-4) };
  return parseMenu(lines);
}

/**
 * The menu at the bottom of a screen: a run of numbered lines from 1, with exactly one of them
 * marked as selected and at most a few hint lines under it, none of them a TUI's prompt. A list
 * in an agent's output carries no mark, and a numbered message beside a TUI's prompt mark (Codex
 * shows the user's messages so) has the TUI's prompt under it.
 */
function parseMenu(lines: string[]): TerminalQuestion | null {
  return parseNumberedMenu(lines) ?? parseMarkedMenu(lines);
}

/**
 * A menu without numbers (Claude's folder trust: "❯ No, exit" over "Yes, I trust this folder"):
 * a block of lines with exactly one marked as selected, right above a key hint that says Enter
 * picks it. A TUI's prompt has no such hint under it ("enter to send" is none).
 */
function parseMarkedMenu(lines: string[]): TerminalQuestion | null {
  let hint = lines.length - 1;
  for (let seen = 0; hint >= 0; hint -= 1) {
    const line = lines[hint].trim();
    if (line.length === 0) continue;
    if (!MARKED_LINE.test(line) && ENTER_HINT.test(line)) break;
    if ((seen += 1) >= MENU_HINT_LINES) return null;
  }
  let end = hint - 1;
  while (end >= 0 && lines[end].trim().length === 0) end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1].trim().length > 0 && end - start + 1 < MENU_OPTIONS) start -= 1;
  if (end < 0) return null;
  const options = lines.slice(start, end + 1).map((line) => line.trim());
  if (options.length < 2 || options.filter((line) => MARKED_LINE.test(line)).length !== 1) return null;
  return { kind: "menu", text: [...nonEmpty(lines.slice(0, start)).slice(-6).map((line) => line.trim()), ...options] };
}

function parseNumberedMenu(lines: string[]): TerminalQuestion | null {
  let end = lines.length - 1;
  for (let below = 0; end >= 0; end -= 1) {
    const line = lines[end].trim();
    if (line.length === 0) continue;
    if (OPTION_LINE.test(line)) break;
    if (MARKED_LINE.test(line) || (below += 1) > MENU_HINT_LINES) return null;
  }
  if (end < 0) return null;
  let start = end;
  let expected = Number(OPTION_LINE.exec(lines[end].trim())![2]) - 1;
  while (expected >= 1 && start > 0) {
    const above = OPTION_LINE.exec(lines[start - 1].trim());
    if (!above || Number(above[2]) !== expected) break;
    start -= 1;
    expected -= 1;
  }
  const options = lines.slice(start, end + 1).map((line) => line.trim());
  if (expected !== 0 || options.length < 2) return null;
  if (options.filter((line) => OPTION_LINE.exec(line)![1] !== undefined).length !== 1) return null;
  return { kind: "menu", text: [...nonEmpty(lines.slice(0, start)).slice(-6).map((line) => line.trim()), ...options] };
}

/** How long a screen stays as it is before it is read: one still being drawn asks nothing yet. */
export const SETTLE_MS = 400;

export interface TerminalReaderIO {
  /** The pane's tty (tmux's pane_tty), whose modification time is when it last took output. */
  tty?: (paneId: string) => string | undefined;
  /** When `path` was last written to, in ms; undefined when it cannot be read. */
  modified?: (path: string) => number | undefined;
  capture?: (paneId: string) => string;
  now?: () => number;
}

/**
 * Reads a pane's screen only when it has changed and come to rest: its tty's modification time
 * says when it last took output, which costs a stat, and the screen is captured (a tmux command)
 * once per change. A screen that moves (a spinner, streaming output) asks nothing.
 */
export class TerminalReader {
  private ttyPath: string | undefined;
  private ttyKnown = false;
  private readAt: number | undefined;
  private screen: TerminalScreen = { question: null, tail: [] };
  private readonly io: Required<TerminalReaderIO>;

  constructor(private readonly paneId: string, io: TerminalReaderIO = {}) {
    this.io = {
      tty: io.tty ?? paneTty,
      modified: io.modified ?? modifiedAt,
      capture: io.capture ?? capture,
      now: io.now ?? Date.now,
    };
  }

  read(): TerminalScreen {
    if (!this.ttyKnown) {
      this.ttyPath = this.io.tty(this.paneId);
      this.ttyKnown = true;
    }
    const modified = this.ttyPath ? this.io.modified(this.ttyPath) : undefined;
    if (modified !== undefined && modified === this.readAt) return this.screen;
    if (modified !== undefined && this.io.now() - modified < SETTLE_MS) return { question: null, tail: this.screen.tail };
    const text = this.io.capture(this.paneId);
    this.readAt = modified;
    this.screen = { question: parseTerminalQuestion(text), tail: nonEmpty(text.split("\n")).slice(-12) };
    return this.screen;
  }
}

function capture(paneId: string): string {
  return execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", paneId], { encoding: "utf8", timeout: 3_000 });
}

function paneTty(paneId: string): string | undefined {
  try {
    return execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{pane_tty}"], { encoding: "utf8", timeout: 3_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function modifiedAt(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}
