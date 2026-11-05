// The hand-off session of an agent pane, for an agent that cannot share its session with its TUI
// (`agents acp-session --agent <id> --tui '<command>'`). The pane runs the agent's TUI as usual,
// with the pane's ACP host kept warm beside it. One of them has the session at a time:
//
//   view   POST /api/handoff {session} (the app's switch): refused while the agent works, else
//          the TUI is stopped and the view loads the session. The pane shows a plain transcript
//          of what happens in the view, so tmux on its own still shows the agent.
//   TUI    Enter in the pane, or POST /api/return: the view's clients end and the TUI goes on
//          with the same session (the agent's resume option).
//
// The agent's TUI ending on its own ends the pane's command, as it would without this.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
}

const BUSY_STATES = new Set(["working", "approval", "question"]);

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
    if (mode !== "view" || !sessionId || !agent.resume) return;
    mode = "switching";
    reader?.close();
    reader = undefined;
    process.stdin.pause();
    host?.closeClients();
    process.stdout.write(`\n\nBack to ${agent.name} in the terminal…\n`);
    resetTerminal();
    mode = "tui";
    startTui(agent.resume(tuiCommand, sessionId));
  };

  const handOff = async (id: string): Promise<{ status: number; message?: string }> => {
    if (mode === "view") {
      return id === sessionId
        ? { status: 200 }
        : { status: 409, message: `The view has another ${agent.name} session.` };
    }
    if (mode !== "tui") return { status: 409, message: `${agent.name} is switching; try again.` };
    const state = reportedAgentState(agent.stateAgent, paneId);
    if (state && BUSY_STATES.has(state)) {
      return { status: 409, message: `${agent.name} is ${state === "working" ? "working" : "waiting for an answer"} in the terminal; switch when it is idle.` };
    }
    mode = "switching";
    sessionId = id;
    await stopTui();
    // The agent may hold its session (a lock file) a moment after its TUI ends: the view's
    // session/load would find it still in use.
    const lock = agent.sessionLock?.(id);
    if (lock) log(await waitForLockRelease(lock) ? `lock ${lock} released` : `lock ${lock} still held after 3 s`);
    resetTerminal();
    process.stdout.write(`${agent.name} is in the ACP view (session ${id}).\nPress Enter here to go back to the terminal.\n`);
    mode = "view";
    process.stdin.resume();
    reader = createInterface({ input: process.stdin });
    reader.on("line", () => { void giveBack(); });
    log(`handed session ${id} to the view`);
    return { status: 200 };
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
        onActivity: reportViewActivity(agent.stateAgent, paneId),
        handoff: { inView: () => mode === "view", handOff, giveBack },
        onAgentLine: (line) => { if (mode === "view") transcript.agentLine(line); },
        onClientLine: (line) => { if (mode === "view") transcript.clientLine(line); },
        log,
      });
      log(`host ${host.url} for ${agent.name} in ${paneId}`);
    } catch (error) {
      log(`host did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  startTui(tuiCommand);
  return await new Promise<never>(() => {});
}
