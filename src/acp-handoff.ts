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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { acpHostMetadataPath, startAcpHost, type AcpHost } from "./acp-host.js";
import { reportViewActivity, type AcpAgentEntry } from "./acp-host-cli.js";
import { getStateDir } from "./paths.js";

export interface HandoffSessionInput {
  agent: AcpAgentEntry;
  paneId: string;
  cwd: string;
  tuiCommand: string;
  runtimeTempDir: string;
  host?: { webRoot: string; agentCommand: { command: string; args: string[]; env: NodeJS.ProcessEnv } };
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

/** Prints what happens in the view as plain text: the prompts, the agent's answers, its tools. */
export class TranscriptPrinter {
  private role: "you" | "agent" | "tool" | undefined;

  constructor(private readonly write: (text: string) => void) {}

  agentLine(line: string): void {
    const update = parse(line)?.params?.update as Record<string, unknown> | undefined;
    if (parse(line)?.method !== "session/update" || !update) return;
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk" || kind === "agent_message_chunk") {
      const text = textOf(update.content);
      if (!text) return;
      this.start(kind === "user_message_chunk" ? "you" : "agent");
      this.write(text);
    } else if (kind === "tool_call" && typeof update.title === "string") {
      this.role = "tool";
      this.write(`\n  ⚙ ${update.title}`);
    }
  }

  clientLine(line: string): void {
    const message = parse(line);
    if (message?.method !== "session/prompt") return;
    const prompt = (message.params as { prompt?: unknown[] } | undefined)?.prompt ?? [];
    const text = prompt.map(textOf).filter(Boolean).join("\n");
    if (!text) return;
    this.start("you");
    this.write(text);
  }

  private start(role: "you" | "agent"): void {
    if (this.role === role) return;
    this.role = role;
    this.write(role === "you" ? "\n\n› " : "\n\n• ");
  }
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
    if (pid !== undefined && !processAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

/** Leaves the terminal as a shell has it after a full-screen program that was stopped. */
function resetTerminal(): void {
  process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b>\x1b[2J\x1b[H");
  if (process.stdin.isTTY) spawnSync("stty", ["sane"], { stdio: "inherit" });
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
  if (input.problem) log(`no ACP view for ${agent.name}: ${input.problem}`);

  let mode: "tui" | "switching" | "view" = "tui";
  let sessionId: string | undefined;
  /** The host is starting its own session: the view waits for it. */
  let hostedStarting = false;
  /** The session a view started and prompted in, when the TUI had none to give. */
  let startedSession: string | undefined;
  /** The session the TUI has, as far as its command says: "current" is that one. Unknown for a
   *  command that picks one without naming it (--continue): then only the app's id will do. */
  const picked = agent.pickedSession?.(tuiCommand);
  let tuiSession: string | undefined = picked === "unknown" ? undefined : picked;
  let tuiSessionUnknown = picked === "unknown";
  let tui: ChildProcess | undefined;
  let reader: Interface | undefined;
  let host: AcpHost | undefined;
  const transcript = new TranscriptPrinter((text) => process.stdout.write(text));

  const finish = async (code: number) => {
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

  const stopTui = async () => {
    const child = tui;
    tui = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  };

  const giveBack = async () => {
    if (mode !== "view" || !agent.resume) return;
    mode = "switching";
    reader?.close();
    reader = undefined;
    process.stdin.pause();
    host?.closeClients();
    process.stdout.write(`\n\nBack to ${agent.name} in the terminal…\n`);
    resetTerminal();
    mode = "tui";
    const id = sessionId ?? startedSession;
    sessionId = undefined;
    startedSession = undefined;
    tuiSession = id;
    tuiSessionUnknown = false;
    setHosted(false);
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


  const handOff = async (id: string): Promise<{ status: number; message?: string; session?: string | null }> => {
    if (mode === "view") {
      const current = sessionId ?? startedSession ?? null;
      return id === "current" || id === current
        ? { status: 200, session: current }
        : { status: 409, message: `The view has another ${agent.name} session.` };
    }
    if (mode !== "tui") return { status: 409, message: `${agent.name} is switching; try again.` };
    const state = reportedAgentState(agent.stateAgent, paneId);
    if (state && BUSY_STATES.has(state)) {
      return { status: 409, message: `${agent.name} is ${state === "working" ? "working" : "waiting for an answer"} in the terminal; switch when it is idle.` };
    }
    if (id === "current" && tuiSessionUnknown) {
      return { status: 409, message: `${agent.name} has not said which session it has open; switch once it has run a turn.` };
    }
    mode = "switching";
    const asked = id === "current" ? tuiSession : id;
    sessionId = !asked || agent.sessionWritten?.(asked) === false ? undefined : asked;
    startedSession = undefined;
    await stopTui();
    // The agent may hold its session (a lock file) a moment after its TUI ends: the view's
    // session/load would find it still in use.
    const lock = sessionId ? agent.sessionLock?.(sessionId) : undefined;
    if (lock) log(await waitForLockRelease(lock) ? `lock ${lock} released` : `lock ${lock} still held after 3 s`);
    resetTerminal();
    // The host holds the session while the view has it: the view attaches to it, and lines for
    // the agent (its coordinator's, its watches') reach it as prompts through the host.
    const hostedId = await hostSession(sessionId);
    if (!hostedId) {
      const back = sessionId;
      mode = "tui";
      sessionId = undefined;
      startTui(back ? agent.resume!(tuiCommand, back) : tuiCommand);
      return { status: 502, message: `${agent.name} could not open its session in the view; it goes on in the terminal.` };
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
    try {
      const id = await host.startHostedSession(existing);
      setHosted(true);
      return id;
    } catch (error) {
      log(`the host's session did not start: ${error instanceof Error ? error.message : String(error)}`);
      host.closeClients();
      return undefined;
    } finally {
      hostedStarting = false;
    }
  };

  /** The view has the session: the pane shows what happens there, and Enter goes back. */
  const inView = () => {
    process.stdout.write(`${agent.name} is in the ACP view (${sessionId ? `session ${sessionId}` : "a new session"}).\nPress Enter here to go on in the terminal.\n`);
    mode = "view";
    process.stdin.resume();
    reader = createInterface({ input: process.stdin });
    reader.on("line", () => { void giveBack(); });
  };

  // Ctrl-C in the pane reaches this process too: it is the TUI's, or, in the view, a way back.
  process.on("SIGINT", () => { if (mode === "view") void giveBack(); });
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.on(signal, async () => {
      await stopTui();
      await finish(128 + (signal === "SIGTERM" ? 15 : 1));
    });
  }

  if (input.host) {
    try {
      host = await startAcpHost({
        paneId,
        agent: { id: agent.id, name: agent.name },
        runtimeTempDir,
        webRoot: input.host.webRoot,
        cwd,
        agentCommand: input.host.agentCommand,
        warmSpare: true,
        agentLogFiles: agent.logFiles?.(),
        agentStateFile: join(getStateDir(), `${agent.stateAgent}-${paneId}.json`),
        onActivity: reportViewActivity(agent.stateAgent, paneId),
        handoff: { inView: () => mode === "view", handOff, giveBack },
        onAgentLine: (line) => { if (mode === "view") transcript.agentLine(line); },
        onClientLine: (line) => {
          if (mode !== "view") return;
          transcript.clientLine(line);
          if (!sessionId) {
            const message = parse(line);
            const prompted = message?.method === "session/prompt" ? message.params?.sessionId : undefined;
            if (typeof prompted === "string") startedSession = prompted;
          }
        },
        // While the host starts its own session the view waits for it (404, asked again).
        currentSession: async () => mode === "view" && !hostedStarting ? { id: sessionId ?? startedSession ?? null, persisted: true } : undefined,
        log,
      });
      log(`host ${host.url} for ${agent.name} in ${paneId}`);
    } catch (error) {
      log(`host did not start: ${error instanceof Error ? error.message : String(error)}`);
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
    sessionId = await hostSession(tuiSession);
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
  }
  return await new Promise<never>(() => {});
}
