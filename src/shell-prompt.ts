// Whether the shell in a new pane waits at its prompt: the one moment a spawn may type into it.
// A shell that is still starting may ask something (an updater's "[Y/n]" in .zshrc), and text
// typed then answers the question instead of reaching the prompt. So nothing is typed until the
// shell's line editor reads a command, and never while the screen shows a terminal question
// (terminal-question.ts): in Agents Next's ACP view the pane then shows its terminal until the
// question is answered.
//
// The line editor is the signal (zle, readline, libedit, fish): it puts the tty in raw mode
// without echo while it waits for a command, and a `read` in a startup file keeps echo on. A
// shell without a line editor (dash) waits in canonical mode with echo, as a `read` does: there
// the prompt is a still screen whose cursor stands after a prompt mark on its last line.
import { spawnSync } from "node:child_process";
import { parseTerminalQuestion } from "./terminal-question.js";

export type ShellState = "prompt" | "question" | "busy";

/** What tmux says of a pane: its tty, whether a full-screen program has the alternate screen,
 *  where its cursor is, and its visible screen. */
export interface PaneLook {
  tty: string;
  alternate: boolean;
  cursorX: number;
  cursorY: number;
  screen: string;
}

/** The tty's line discipline: canonical (line by line) input, and echo. */
export interface TtyMode {
  canonical: boolean;
  echo: boolean;
}

/** How long a screen without a line editor stands still before its prompt counts. */
export const STILL_PROMPT_MS = 1_000;
/** The marks a prompt ends with, before the cursor: $ # % > ❯ ➜ » λ. */
const PROMPT_END = /[$#%>❯➜»λ]\s?$/;

export function shellState(look: PaneLook, mode: TtyMode | undefined, stillMs: number): ShellState {
  if (parseTerminalQuestion(look.screen)) return "question";
  if (look.alternate) return "busy";
  if (mode && !mode.canonical && !mode.echo) return "prompt";
  // Raw mode with echo is a program that reads keys (`read -k`, a picker): never a prompt.
  if (mode && !mode.canonical) return "busy";
  return stillMs >= STILL_PROMPT_MS && cursorAfterPrompt(look) ? "prompt" : "busy";
}

/** The cursor stands at the end of the screen's last line, right after a prompt mark. */
function cursorAfterPrompt(look: PaneLook): boolean {
  const lines = look.screen.split("\n");
  const line = lines[look.cursorY] ?? "";
  if (lines.slice(look.cursorY + 1).some((below) => below.trim().length > 0)) return false;
  const before = [...line].slice(0, look.cursorX).join("");
  const after = [...line].slice(look.cursorX).join("");
  return after.trim().length === 0 && PROMPT_END.test(before);
}

/** The tty's mode, from `stty -a`: undefined when it cannot be read. */
export function parseTtyMode(stty: string): TtyMode | undefined {
  const flag = (name: string) => {
    const match = new RegExp(`(?:^|\\s)(-?)${name}(?=\\s|$)`).exec(stty);
    return match ? match[1] !== "-" : undefined;
  };
  const canonical = flag("icanon");
  const echo = flag("echo");
  return canonical === undefined || echo === undefined ? undefined : { canonical, echo };
}

export function readTtyMode(tty: string): TtyMode | undefined {
  const result = spawnSync("stty", ["-a", process.platform === "linux" ? "-F" : "-f", tty], { encoding: "utf8", timeout: 3_000 });
  return result.status === 0 ? parseTtyMode(result.stdout) : undefined;
}

const LOOK_FORMAT = "#{pane_tty}\t#{alternate_on}\t#{cursor_x}\t#{cursor_y}";

/** What tmux shows of `paneId`, through `tmux` (a runner that answers a command's output, or
 *  undefined when it failed); undefined for a pane tmux does not know. */
export function readPaneLook(paneId: string, tmux: (args: string[]) => string | undefined): PaneLook | undefined {
  const fields = tmux(["display-message", "-p", "-t", paneId, LOOK_FORMAT])?.split("\t");
  if (!fields || fields.length < 4) return undefined;
  const screen = tmux(["capture-pane", "-p", "-t", paneId]);
  if (screen === undefined) return undefined;
  return { tty: fields[0], alternate: fields[1] === "1", cursorX: Number(fields[2]) || 0, cursorY: Number(fields[3]) || 0, screen };
}
