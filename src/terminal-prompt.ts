// What an agent's TUI asks in its pane while the pane's ACP view waits for its session: a menu
// it shows as it starts (Codex's "Hooks need review", Claude's folder trust), or the last lines
// it wrote when it stopped (a session it could not resume). The view shows it instead of an empty
// opening frame, and answers a menu from its buttons with the keys a person would press.
import { execFileSync } from "node:child_process";

export interface TerminalPromptOption {
  /** The number the TUI shows beside the option (1, 2, …). */
  index: number;
  label: string;
  selected: boolean;
}

export interface TerminalPrompt {
  /** The lines above the options: the question and what it says about it. */
  text: string[];
  options: TerminalPromptOption[];
  /** The lines under the options (the TUI's key hints). */
  hint: string[];
}

export interface TerminalScreen {
  /** A menu the TUI waits on, if it shows one. */
  prompt: TerminalPrompt | null;
  /** The last lines on the pane's screen, for a TUI that shows no menu (an error it stopped on). */
  tail: string[];
}

/** The marks TUIs put beside the selected option of a menu. */
const SELECTED_MARKS = "›❯▶➤➜→>";
const OPTION_LINE = new RegExp(`^([${SELECTED_MARKS}])?\\s*(\\d{1,2})[.)]\\s+(\\S.*)$`);
/** A dialog's frame: box-drawing characters and the spaces inside them. */
const FRAME = /^[\s│┃║|╭╮╰╯┌┐└┘─━═]+|[\s│┃║|╭╮╰╯┌┐└┘─━═]+$/g;

function clean(line: string): string {
  return line.replace(FRAME, "");
}

/**
 * The menu on a pane's screen: the last run of numbered lines, 1 up, with exactly one of them
 * marked as selected. A list in an agent's own output carries no such mark.
 */
export function parseTerminalPrompt(screen: string): TerminalPrompt | null {
  const lines = screen.split("\n").map(clean);
  for (let end = lines.length - 1; end >= 0; end -= 1) {
    const last = OPTION_LINE.exec(lines[end]);
    if (!last) continue;
    // The run of options that ends here, read upwards to option 1.
    let start = end;
    let expected = Number(last[2]) - 1;
    while (expected >= 1 && start > 0) {
      const above = OPTION_LINE.exec(lines[start - 1]);
      if (!above || Number(above[2]) !== expected) break;
      start -= 1;
      expected -= 1;
    }
    if (expected !== 0) continue;
    const options = lines.slice(start, end + 1).map((line) => {
      const match = OPTION_LINE.exec(line)!;
      return { index: Number(match[2]), label: match[3].trim(), selected: Boolean(match[1]) };
    });
    if (options.length < 2 || options.filter((option) => option.selected).length !== 1) continue;
    const text = nonEmpty(lines.slice(0, start)).slice(-8);
    const hint = nonEmpty(lines.slice(end + 1)).slice(0, 2);
    return { text, options, hint };
  }
  return null;
}

function nonEmpty(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
}

/** The keys that pick option `index` of `prompt` from the one selected now: arrows, then Enter. */
export function keysForOption(prompt: TerminalPrompt, index: number): string[] | undefined {
  const target = prompt.options.findIndex((option) => option.index === index);
  const selected = prompt.options.findIndex((option) => option.selected);
  if (target < 0 || selected < 0) return undefined;
  const moves = target - selected;
  return [...Array(Math.abs(moves)).fill(moves > 0 ? "Down" : "Up"), "Enter"];
}

function capture(paneId: string): string {
  return execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", paneId], { encoding: "utf8", timeout: 3_000 });
}

/** What the pane's screen shows now. */
export function readTerminalScreen(paneId: string, read: (paneId: string) => string = capture): TerminalScreen {
  const screen = read(paneId);
  return { prompt: parseTerminalPrompt(screen), tail: nonEmpty(screen.split("\n")).slice(-12) };
}

/**
 * Picks option `index` of the menu on the pane's screen, if the screen still shows that option
 * with that label (the menu may have changed since the view showed it), and answers the screen
 * the pane shows after.
 */
export async function answerTerminalPrompt(
  paneId: string,
  index: number,
  label: string,
  io: { read?: (paneId: string) => string; send?: (paneId: string, keys: string[]) => void; settleMs?: number } = {},
): Promise<{ ok: boolean; message?: string; screen: TerminalScreen }> {
  const read = io.read ?? capture;
  const send = io.send ?? ((pane, keys) => execFileSync("tmux", ["send-keys", "-t", pane, ...keys], { timeout: 3_000 }));
  const before = readTerminalScreen(paneId, read);
  const option = before.prompt?.options.find((candidate) => candidate.index === index);
  const keys = before.prompt && option?.label === label ? keysForOption(before.prompt, index) : undefined;
  if (!keys) return { ok: false, message: "The terminal shows something else now.", screen: before };
  // One key at a time: a TUI reads a burst of arrows as one.
  for (const key of keys) {
    send(paneId, [key]);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  await new Promise((resolve) => setTimeout(resolve, io.settleMs ?? 400));
  return { ok: true, screen: readTerminalScreen(paneId, read) };
}
