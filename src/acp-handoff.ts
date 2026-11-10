// The hand-off session of an agent pane, for an agent that cannot share its session with its TUI
// (`agents acp-session --agent <id> --tui '<command>'`). The pane runs the agent's TUI as usual,
// with the pane's ACP host kept warm beside it. One of them has the session at a time:
//
//   view   POST /api/handoff {session} (the app's switch): refused while the agent works, else
//          the TUI is stopped and the view loads the session. A TUI with no session yet ("current",
//          or one named but never written) leaves the view to start one in the pane's directory.
//          The pane shows a plain transcript of what happens in the view, so tmux on its own still
//          shows the agent.
//   TUI    Enter in the pane, or POST /api/return: the view's clients end and the TUI goes on
//          with the same session (the agent's resume option): the one the view started, if it
//          prompted in it, else a new one as the pane's command starts it.
//
// The agent's TUI ending on its own ends the pane's command, as it would without this.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { acpHostMetadataPath, readAcpHostMetadata, startAcpHost, type AcpHost } from "./acp-host.js";
import { reportViewActivity, type AcpAgentEntry } from "./acp-host-cli.js";
import type { AcpLaunchSettings } from "./acp-launch-settings.js";
import { getStateDir } from "./paths.js";
import { reportState, type ReportedState } from "./state.js";

export interface HandoffSessionInput {
  agent: AcpAgentEntry;
  paneId: string;
  cwd: string;
  tuiCommand: string;
  runtimeTempDir: string;
  host?: { webRoot: string; agentCommand: { command: string; args: string[]; env: NodeJS.ProcessEnv }; launchSettings?: AcpLaunchSettings };
  /** Why there is no host, shown nowhere but the log: the TUI runs regardless. */
  problem?: string;
  /** The app opens the pane in its ACP view: the agent starts there, its TUI only on the way
   *  back, on the session the view started. */
  startInView?: boolean;
  /** A spawned worker's brief: in the view, the first prompt of the host's session. */
  firstPrompt?: string;
  /** The TUI command with the brief, for a worker that starts in the terminal after all. */
  firstTuiCommand?: string;
}

const BUSY_STATES = new Set(["working", "approval", "question"]);

/** The pane option of a pane whose host holds its agent's session (agents-app-control prompts it). */
export const HOSTED_OPTION = "@agents_acp_hosted";

/** The agent's last reported state in this pane, from its status hooks. */
export function reportedAgentState(stateAgent: string, paneId: string, stateDir = getStateDir()): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, `${stateAgent}-${paneId}.json`), "utf8")) as { state?: unknown };
    return typeof value.state === "string" ? value.state : undefined;
  } catch {
    return undefined;
  }
}

/** Text from an agent as plain text for a terminal: no escape sequences, no control
 *  characters but newline and tab. A pane's terminal parses every byte written to it; an
 *  agent's text (a quoted log, a tool's output, a stray OSC) is not ours to send it. */
export function plainText(text: string): string {
  return text
    // CSI, OSC, DCS/SOS/PM/APC strings and any other escape, 7-bit and 8-bit.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/[\x9b][0-?]*[ -/]*[@-~]?/g, "")
    .replace(/[\x9d\x90\x98\x9e\x9f][\s\S]*?(?:\x07|\x9c|$)/g, "")
    .replace(/\x1b[\s\S]?/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    // Lone surrogates make no character.
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

/** How many lines of a loaded session's history the pane shows; the view has all of it. */
export const REPLAYED_LINES = 200;

/**
 * Prints what happens in the view as plain text: the prompts, the agent's answers, its tools.
 * Everything it writes is plain text (plainText), wrapped at `width` columns by itself, and
 * written in small pieces a moment apart: a terminal never gets a long line or a large burst.
 * A loaded session's history is shown as its last REPLAYED_LINES lines.
 */
export class TranscriptPrinter {
  private role: "you" | "agent" | "tool" | undefined;
  private column = 0;
  private replay: string[] | undefined;
  private queue = "";
  private flushing = false;

  constructor(
    private readonly write: (text: string) => void,
    private readonly width: () => number = () => Math.max(20, Math.min(process.stdout.columns || 100, 240)),
    private readonly pause: (next: () => void) => void = (next) => { setTimeout(next, 4); },
    private readonly chunk = 2048,
  ) {}

  agentLine(line: string): void {
    const update = parse(line)?.params?.update as Record<string, unknown> | undefined;
    if (parse(line)?.method !== "session/update" || !update) return;
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const text = textOf(update.content);
      if (!text) return;
      this.start(kind === "user_message_chunk" ? "you" : "agent");
      this.text(text);
    } else if (kind === "tool_call" && typeof update.title === "string") {
      this.role = "tool";
      this.text(`\n  ⚙ ${update.title.replace(/\s+/g, " ")}`);
    } else if (kind === "session_info_update" && typeof update.title === "string" && update.title.trim() && !this.replay) {
      this.title(update.title);
    }
  }

  /** The pane's title, as the agent's TUI sets it: tmux and the app show it for the pane. */
  title(text: string): void {
    const plain = plainText(text).replace(/\s+/g, " ").trim().slice(0, 120);
    if (plain) this.out(`\x1b]2;${plain}\x07`);
  }

  clientLine(line: string): void {
    const message = parse(line);
    if (message?.method !== "session/prompt") return;
    const prompt = (message.params as { prompt?: unknown[] } | undefined)?.prompt ?? [];
    const text = prompt.map(textOf).filter(Boolean).join("\n");
    if (!text) return;
    this.start("you");
    this.text(text);
  }

  /** Our own text for the pane (a notice, a terminal reset), in order with the transcript. */
  say(text: string): void {
    this.out(text);
  }

  /** Drops the history held back since `beginReplay`. */
  dropReplay(): void {
    this.replay = undefined;
  }

  /** What follows is a loaded session's history: held back, and shown by `endReplay`. */
  beginReplay(): void {
    this.replay = [];
  }

  /** Shows the end of the history held back since `beginReplay`. */
  endReplay(): void {
    const held = this.replay?.join("") ?? "";
    this.replay = undefined;
    const lines = held.replace(/^\n+|\n+$/g, "").split("\n");
    const earlier = lines.length - REPLAYED_LINES;
    const shown = earlier > 0 ? lines.slice(earlier) : lines;
    if (earlier > 0) this.out(`(${earlier} earlier lines are in the ACP view)\n`);
    if (shown.join("").trim()) this.out(`${shown.join("\n")}\n`);
    this.role = undefined;
    this.column = 0;
  }

  /** Flushes what is still queued; resolves once it is written. */
  async drained(): Promise<void> {
    while (this.queue || this.flushing) await new Promise((resolve) => this.pause(() => resolve(undefined)));
  }

  private start(role: "you" | "agent"): void {
    if (this.role === role) return;
    this.role = role;
    this.text(role === "you" ? "\n\n› " : "\n\n• ");
  }

  /** Agent text, made plain and wrapped at the pane's width. */
  private text(text: string): void {
    const width = this.width();
    let out = "";
    for (const character of plainText(text)) {
      if (character === "\n") {
        out += character;
        this.column = 0;
        continue;
      }
      const columns = character === "\t" ? 8 - (this.column % 8) : characterWidth(character);
      if (this.column + columns > width) {
        out += "\n";
        this.column = 0;
      }
      out += character;
      this.column += columns;
    }
    if (this.replay) this.replay.push(out);
    else this.out(out);
  }

  private out(text: string): void {
    if (!text) return;
    this.queue += text;
    if (!this.flushing) this.flush();
  }

  private flush(): void {
    if (!this.queue) {
      this.flushing = false;
      return;
    }
    this.flushing = true;
    // Never split a character's surrogate pair between two writes.
    let size = Math.min(this.chunk, this.queue.length);
    if (size < this.queue.length && /[\ud800-\udbff]/.test(this.queue[size - 1])) size -= 1;
    const piece = this.queue.slice(0, size);
    this.queue = this.queue.slice(size);
    this.write(piece);
    if (this.queue) this.pause(() => this.flush());
    else this.flushing = false;
  }
}

/** Columns a character takes in a terminal: two for wide ones (CJK, most emoji), else one. */
function characterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

function parse(line: string): { method?: string; params?: Record<string, unknown> } | undefined {
  try {
    return JSON.parse(line) as { method?: string; params?: Record<string, unknown> };
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (content && typeof content === "object" && (content as { type?: unknown }).type === "text") {
    return String((content as { text?: unknown }).text ?? "");
  }
  return "";
}

/** Waits up to `timeoutMs` for a session lock file to go, or to name a process that has ended. */
export async function waitForLockRelease(file: string, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!existsSync(file)) return true;
    const pid = lockOwner(file);
    if (pid !== undefined && (!processAlive(pid) || !startedAsLocked(file, pid))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Every process under `root`, from the process table. */
function processTree(root: number): number[] {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 3_000 })
      .split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter(([pid, ppid]) => pid > 0 && ppid >= 0);
    const found: number[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const [pid, ppid] of rows) {
        if (ppid === parent && !found.includes(pid)) {
          found.push(pid);
          queue.push(pid);
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

/** The process holding a session lock, as `pid (command)`, while it runs. */
function lockHolder(file: string): string | undefined {
  const pid = lockOwner(file);
  if (pid === undefined || !processAlive(pid)) return undefined;
  try {
    return `${pid} (${execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 3_000 }).trim().slice(0, 120)})`;
  } catch {
    return String(pid);
  }
}

/** Whether the process with the lock's pid is the one that took the lock: a lock records when
 *  its process started (Kiro: {"pid":N,"started_at":...}), and a pid used again by another
 *  process since does not hold it. Without a start time, the pid alone counts. */
function startedAsLocked(file: string, pid: number): boolean {
  let startedAt: number | undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { started_at?: unknown };
    if (typeof value.started_at === "number") startedAt = value.started_at > 1e12 ? value.started_at : value.started_at * 1000;
    else if (typeof value.started_at === "string") startedAt = Date.parse(value.started_at);
  } catch {
    return true;
  }
  if (startedAt === undefined || Number.isNaN(startedAt)) return true;
  try {
    const began = Date.parse(execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3_000 }).trim());
    // A lock is taken after its process starts, within its first minutes; one taken before it
    // started is another process's.
    return Number.isNaN(began) || startedAt >= began - 2_000;
  } catch {
    return true;
  }
}

/** The live process that holds a session lock, by its pid and start time; none for a lock
 *  nothing holds any more. */
export function liveLockHolder(file: string): number | undefined {
  const pid = lockOwner(file);
  return pid !== undefined && processAlive(pid) && startedAsLocked(file, pid) ? pid : undefined;
}

function lockOwner(file: string): number | undefined {
  try {
    const match = readFileSync(file, "utf8").match(/\d+/);
    return match ? Number(match[0]) : undefined;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a process is an `acp-session` (a pid can be another process's by now). */
function isAcpSessionProcess(pid: number): boolean {
  try {
    return / acp-session( |$)/.test(execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 3_000 }));
  } catch {
    return false;
  }
}

/** Leaves the terminal as a shell has it after a full-screen program that was stopped. */
function resetTerminal(transcript: TranscriptPrinter): void {
  transcript.say("\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b>\x1b[2J\x1b[H");
  if (process.stdin.isTTY) spawnSync("stty", ["sane"], { stdio: "inherit" });
}

/**
 * Where a hand-off pane's session is, as the app reads it from pane-N.status.json:
 *   stopping-tui      the TUI is being stopped to hand its session to the view
 *   waiting-for-lock  the agent still holds the session's lock
 *   loading           the host opens the session (or starts one) for the view
 *   in-view           the view has the session
 *   in-terminal       the TUI has it (with `error`: a hand-off that failed and came back)
 *   no-view           this pane has no view (`error` says why)
 * `step` is the line the app shows while it waits. Bump the version when a field changes meaning.
 */
export type AcpHandoffPhase = "stopping-tui" | "waiting-for-lock" | "loading" | "in-view" | "in-terminal" | "no-view";
export const ACP_HANDOFF_STATUS_VERSION = 1;
export interface AcpHandoffStatus {
  version: number;
  processId: number;
  agent: string;
  phase: AcpHandoffPhase;
  step: string;
  error?: string;
  at: string;
}

export async function runHandoffSession(input: HandoffSessionInput): Promise<never> {
  const { agent, paneId, cwd, tuiCommand, runtimeTempDir } = input;
  const logPath = acpHostMetadataPath(runtimeTempDir, paneId).replace(/\.json$/, ".log");
  const log = (message: string) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {}
  };
  // Where the pane's session is, for the app (pane-N.status.json, AcpHandoffStatus): the phase,
  // the line it shows for it, and why the view cannot open. The app goes by the phase.
  const statusPath = logPath.replace(/\.log$/, ".status.json");
  const status = (phase: AcpHandoffPhase, step: string, error?: string) => {
    try {
      const record: AcpHandoffStatus = { version: ACP_HANDOFF_STATUS_VERSION, processId: process.pid, agent: agent.id, phase, step, ...(error ? { error } : {}), at: new Date().toISOString() };
      writeFileSync(statusPath, JSON.stringify(record));
    } catch {}
  };
  if (input.problem) {
    log(`no ACP view for ${agent.name}: ${input.problem}`);
    status("no-view", "no view", `${agent.name} has no ACP view here: ${input.problem}`);
  }

  let mode: "tui" | "switching" | "view" = "tui";
  let sessionId: string | undefined;
  /** The host is starting its own session: the view waits for it. */
  let hostedStarting = false;
  /** Why the host's session last failed to start. */
  let lastHostError: string | undefined;
  /** The session a view started and prompted in, when the TUI had none to give. */
  let startedSession: string | undefined;
  /** The session the TUI has, as far as its command says: "current" is that one. Unknown for a
   *  command that picks one without naming it (--continue): then only the app's id will do. */
  const picked = agent.pickedSession?.(tuiCommand);
  let tuiSession: string | undefined = picked === "unknown" ? undefined : picked;
  let tuiSessionUnknown = picked === "unknown";
  /** The session that goes on from `id` (Kiro 3's copy of a Kiro 2 session), asked only when a
   *  session changes hands: asking Kiro takes a moment. */
  const continued = (id: string | undefined) => id && agent.continuedSession ? agent.continuedSession(id) : id;
  let tui: ChildProcess | undefined;
  let reader: Interface | undefined;
  let host: AcpHost | undefined;
  const transcript = new TranscriptPrinter((text) => process.stdout.write(text));

  const finish = async (code: number) => {
    try { rmSync(statusPath, { force: true }); } catch {}
    await host?.close();
    process.exit(code);
  };

  const startTui = (command: string) => {
    log(`TUI: ${command}`);
    const child = spawn("/bin/sh", ["-c", `exec ${command}`], { stdio: "inherit", cwd, env: process.env });
    tui = child;
    child.once("exit", (code, signal) => {
      if (tui !== child || mode !== "tui") return;
      void finish(code ?? (signal ? 128 + 15 : 1));
    });
  };

  /** Ends the TUI and every process it runs (Kiro v3's TUI runs the ACP child that holds the
   *  session's lock): the view loads the session only once none of them has it. */
  const stopTui = async () => {
    const child = tui;
    tui = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const tree = child.pid ? processTree(child.pid) : [];
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
    const left = tree.filter(processAlive);
    if (left.length === 0) return;
    log(`the TUI left ${left.join(" ")} running; ending them`);
    for (const pid of left) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    const deadline = Date.now() + 3_000;
    while (tree.some(processAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    for (const pid of tree.filter(processAlive)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  };

  const giveBack = async () => {
    if (mode !== "view" || !agent.resume) return;
    mode = "switching";
    reader?.close();
    reader = undefined;
    process.stdin.pause();
    host?.closeClients();
    transcript.say(`\n\nBack to ${agent.name} in the terminal…\n`);
    resetTerminal(transcript);
    // All of the transcript is written before the TUI writes to the pane: one writer at a time.
    await transcript.drained();
    mode = "tui";
    const id = continued(sessionId ?? startedSession);
    sessionId = undefined;
    startedSession = undefined;
    tuiSession = id;
    tuiSessionUnknown = false;
    setHosted(false);
    status("in-terminal", "in the terminal");
    // A session the view never prompted in was never written: nothing to resume.
    const resumable = id && agent.sessionWritten?.(id) !== false;
    startTui(resumable ? agent.resume(tuiCommand, id) : tuiCommand);
  };

  /** Marks the pane as one whose host holds the agent's session: lines for the agent go to the
   *  host as prompts (agents-app-control), not typed into the pane. */
  const setHosted = (on: boolean) => {
    try {
      execFileSync("tmux", on
        ? ["set-option", "-p", "-t", paneId, HOSTED_OPTION, "1"]
        : ["set-option", "-p", "-u", "-t", paneId, HOSTED_OPTION], { timeout: 3_000, stdio: "ignore" });
    } catch {
      // Without tmux the pane has no lines to take.
    }
  };


  // `retry`: the refusal passes by itself (the agent is busy or switching): the app waits and asks again.
  const handOff = async (id: string): Promise<{ status: number; message?: string; session?: string | null; retry?: boolean }> => {
    // The host is opening its session (a pane that starts in the view): the app asks again.
    if (mode === "view" && hostedStarting) return { status: 409, message: `${agent.name} is opening its session; try again.`, retry: true };
    if (mode === "view") {
      const current = sessionId ?? startedSession ?? null;
      return id === "current" || id === current || (current !== null && continued(id) === current)
        ? { status: 200, session: current }
        : { status: 409, message: `The view has another ${agent.name} session.` };
    }
    if (mode !== "tui") return { status: 409, message: `${agent.name} is switching; try again.`, retry: true };
    const state = reportedAgentState(agent.stateAgent, paneId);
    if (state && BUSY_STATES.has(state)) {
      return { status: 409, message: `${agent.name} is ${state === "working" ? "working" : "waiting for an answer"} in the terminal; switch when it is idle.`, retry: true };
    }
    if (id === "current" && tuiSessionUnknown) {
      return { status: 409, message: `${agent.name} has not said which session it has open; switch once it has run a turn.`, retry: true };
    }
    mode = "switching";
    status("stopping-tui", `Stopping ${agent.name} in the terminal…`);
    const asked = continued(id === "current" ? tuiSession : id);
    sessionId = !asked || agent.sessionWritten?.(asked) === false ? undefined : asked;
    startedSession = undefined;
    await stopTui();
    // The agent may hold its session (a lock file) a moment after its TUI ends: the view's
    // session/load would find it still in use.
    const lock = sessionId ? agent.sessionLock?.(sessionId) : undefined;
    if (lock) {
      status("waiting-for-lock", `Waiting for ${agent.name} to release the session…`);
      if (await waitForLockRelease(lock, 8_000)) log(`lock ${lock} released`);
      else log(`lock ${lock} still held after 8 s, by ${lockHolder(lock) ?? "an unknown process"}; loading the session regardless`);
    }
    status("loading", sessionId ? "Loading the session…" : `Starting ${agent.name}…`);
    resetTerminal(transcript);
    // The host holds the session while the view has it: the view attaches to it, and lines for
    // the agent (its coordinator's, its watches') reach it as prompts through the host.
    const hostedId = await hostSession(sessionId);
    if (!hostedId) {
      const back = sessionId;
      mode = "tui";
      sessionId = undefined;
      await transcript.drained();
      startTui(back ? agent.resume!(tuiCommand, back) : tuiCommand);
      status("in-terminal", "back in the terminal", lastHostError ?? `${agent.name} could not open its session in the view`);
      return { status: 502, message: `${agent.name} could not open its session in the view (${lastHostError ?? "see the pane's log"}); it goes on in the terminal.` };
    }
    log(`handed session ${hostedId} to the view${sessionId ? "" : " (a new one: the TUI had none)"}`);
    sessionId = hostedId;
    inView();
    return { status: 200, session: sessionId };
  };

  /** Starts the host's own session on `existing`, or a new one; undefined when it cannot. */
  const hostSession = async (existing: string | undefined): Promise<string | undefined> => {
    if (!host) return undefined;
    mode = "view";
    hostedStarting = true;
    // A loaded session replays its history: the pane shows its end once the view has it (inView).
    if (existing) transcript.beginReplay();
    try {
      const id = await host.startHostedSession(existing);
      setHosted(true);
      return id;
    } catch (error) {
      lastHostError = error instanceof Error ? error.message : String(error);
      log(`the host's session did not start: ${lastHostError}`);
      transcript.dropReplay();
      host.closeClients();
      return undefined;
    } finally {
      hostedStarting = false;
    }
  };

  /** The pane's session as the agents state has it (`agents ls`, history, the app): an agent whose
   *  hooks do not run under ACP (Kiro) reports none while the view has it. */
  const reportSession = (id: string | undefined) => {
    if (!id) return;
    try {
      reportState(agent.stateAgent, paneId, (reportedAgentState(agent.stateAgent, paneId) as ReportedState | undefined) ?? "idle", { externalSessionId: id, activity: false });
    } catch {
      // The view works without it.
    }
  };

  /** The view has the session: the pane shows what happens there, and Enter goes back. */
  const inView = () => {
    reportSession(sessionId);
    status("in-view", "in the view");
    transcript.title(agent.name);
    transcript.say(`${agent.name} is in the ACP view (${sessionId ? `session ${sessionId}` : "a new session"}).\nPress Enter here to go on in the terminal.\n`);
    transcript.endReplay();
    mode = "view";
    process.stdin.resume();
    reader = createInterface({ input: process.stdin });
    reader.on("line", () => { void giveBack(); });
  };

  // Ctrl-C in the pane reaches this process too: it is the TUI's, or, in the view, a way back.
  process.on("SIGINT", () => { if (mode === "view") void giveBack(); });
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.on(signal, async () => {
      // A pane respawned (a resume) starts its next host at once: this one makes way first.
      await host?.close();
      await stopTui();
      await finish(128 + (signal === "SIGTERM" ? 15 : 1));
    });
  }

  // A pane whose terminal went away (the pane closed) takes no more writes: that ends nothing.
  process.stdout.on("error", (error) => log(`the pane took no more output: ${error.message}`));
  // One host per pane: another that still runs for it keeps it, and this agent runs in its terminal.
  // The host of the pane's command before this one (a respawned pane: a resume) may still be on
  // its way out; it is waited for.
  const otherHost = () => {
    const other = readAcpHostMetadata(acpHostMetadataPath(runtimeTempDir, paneId));
    return other !== undefined && other.processId !== process.pid && processAlive(other.processId)
      && isAcpSessionProcess(other.processId) ? other : undefined;
  };
  for (const deadline = Date.now() + 5_000; otherHost() && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const other = otherHost();
  const otherRuns = other !== undefined;
  if (otherRuns) {
    log(`host ${other.processId} still serves ${paneId}: no second host`);
    status("no-view", "no view", `another ACP host (process ${other.processId}) still serves this pane`);
  }
  if (input.host && !otherRuns) {
    try {
      host = await startAcpHost({
        paneId,
        agent: { id: agent.id, name: agent.name },
        runtimeTempDir,
        webRoot: input.host.webRoot,
        cwd,
        agentCommand: input.host.agentCommand,
        launchSettings: input.host.launchSettings,
        offersAllowAll: agent.offersAllowAll === true,
        // The host's own session is the only one its views use: a spare helps only an agent
        // whose spare can open it.
        warmSpare: agent.spareCanHost === true,
        spareCanHost: agent.spareCanHost === true,
        agentLogFiles: agent.logFiles?.(),
        agentStateFile: join(getStateDir(), `${agent.stateAgent}-${paneId}.json`),
        historyAgent: agent.stateAgent,
        onActivity: reportViewActivity(agent.stateAgent, paneId),
        handoff: { inView: () => mode === "view", handOff, giveBack },
        onAgentLine: (line) => { if (mode === "view") transcript.agentLine(line); },
        onClientLine: (line) => {
          if (mode !== "view") return;
          transcript.clientLine(line);
          if (!sessionId) {
            const message = parse(line);
            const prompted = message?.method === "session/prompt" ? message.params?.sessionId : undefined;
            if (typeof prompted === "string" && startedSession !== prompted) {
              startedSession = prompted;
              reportSession(prompted);
            }
          }
        },
        // While the host starts its own session the view waits for it (404, asked again).
        currentSession: async () => mode === "view" && !hostedStarting ? { id: sessionId ?? startedSession ?? null, persisted: true } : undefined,
        log,
      });
      log(`host ${host.url} for ${agent.name} in ${paneId}`);
    } catch (error) {
      log(`host did not start: ${error instanceof Error ? error.message : String(error)}`);
      status("no-view", "no view", `the ACP host did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // A command that picks a session without naming it starts in the terminal: the view would not
  // know which one to open.
  if (input.startInView && host && !tuiSessionUnknown) {
    // The host holds the session: the view attaches to it, and the brief and later lines for the
    // agent are its prompts.
    log(`${agent.name} starts in the view${tuiSession ? ` on session ${tuiSession}` : ""}`);
    // The app knows the pane's agent from its state before any TUI or hook reports it.
    reportViewActivity(agent.stateAgent, paneId)("idle");
    // The app shows the view's opening frame meanwhile, with this line on it.
    status("loading", tuiSession ? "Loading the session…" : `Starting ${agent.name}…`);
    sessionId = await hostSession(continued(tuiSession));
    inView();
    if (sessionId && input.firstPrompt) {
      // The app shows the view while the agent waits: a hand-off agent at work cannot be
      // switched to. Without a view the brief goes all the same, a little later.
      const attached = await host.viewAttached(30_000);
      log(`the brief goes to session ${sessionId}${attached ? "" : " (no view attached)"}`);
      void host.hostedPrompt(input.firstPrompt).catch((error: unknown) => log(`the brief did not reach ${agent.name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  } else {
    startTui(input.firstTuiCommand ?? tuiCommand);
    if (host) status("in-terminal", "in the terminal");
  }
  return await new Promise<never>(() => {});
}
