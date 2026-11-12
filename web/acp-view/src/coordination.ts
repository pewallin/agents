// Coordinators and workers in the ACP view: what the app says of the pane's role and its
// workers (pushed into the page like the look), and the lines the coordination protocol puts into
// a conversation, recognised so the view shows them as what they are rather than as your words:
//   ⟢ agents · <summary> · read <file>                       a wake-up or message (agents-app-control)
//   ROLE: worker. You were started by a coordinator for task "<task>". Read your brief at <file>…
//   <cli> agent spawn|send|report|close …                     the agent's own coordination commands
import { create } from "zustand";
import { definePageEntry, PAGE_ENTRIES } from "./bridge";

export interface CoordinationPane {
  /** tmux pane id, %N. */
  pane: string;
  task?: string;
  title?: string;
  /** The agent's state as the app shows it (working, idle, attention, question, …). */
  status?: string;
  /** started, progress, done, blocked, ask-coordinator, ask-user, closed. */
  report?: string;
  reportLine?: string;
  /** The agent it runs (codex, claude, …). */
  agent?: string;
  /** The thread's title in the user's words (agent spawn --title); its task names it otherwise. */
  threadTitle?: string;
  /** Where its thread stands, as the app decides it for every view: needs-you, done, working,
   *  stopped or resolved. */
  threadState?: string;
  /** What it waits on while it needs the user: its question for them, its blocker, or the
   *  permission in its pane ("Waiting for permission: git push origin main"). */
  threadWaiting?: string;
}

export interface Coordination {
  role?: "coordinator" | "worker";
  task?: string;
  /** The pane's own thread title, for a worker. */
  threadTitle?: string;
  /** The coordinator's program by the name users see, and its colour now (#rrggbb): the colour
   *  is decoration only, never used to decide anything. */
  programName?: string;
  programColor?: string;
  /** The pane's own latest report, for a worker. */
  report?: string;
  reportLine?: string;
  coordinator?: CoordinationPane;
  workers: CoordinationPane[];
}

export const useCoordination = create<Coordination>(() => ({ workers: [] }));

// The app hands the page the pane's coordination whenever it changes (WorkspaceACPViewCoordination).
if (typeof window !== "undefined") {
  definePageEntry(PAGE_ENTRIES.applyCoordination, (value: Coordination) => {
    useCoordination.setState({ ...value, workers: value.workers ?? [] }, true);
  });
}

/** A worker waits on the user: a permission or question in its pane, or a report asking them. */
export function needsUser(worker: CoordinationPane): boolean {
  return worker.status === "attention" || worker.status === "question" || worker.status === "approval" || worker.report === "ask-user";
}

/** Where a worker stands, in one word: from its agent's state and its latest report. */
export type WorkerState = "needs-you" | "blocked" | "done" | "working" | "idle";

export function workerState(worker: CoordinationPane): WorkerState {
  // The app's word wins: the tabs column, its thread list and these chips then never disagree.
  switch (worker.threadState) {
    case "needs-you": return "needs-you";
    case "done": case "resolved": return "done";
    case "working": return "working";
    case "stopped": return "idle";
  }
  if (needsUser(worker)) return "needs-you";
  if (worker.report === "blocked") return "blocked";
  if (worker.status === "working" || worker.status === "compacting" || worker.status === "pending") return "working";
  if (worker.report === "done" || worker.report === "closed" || worker.status === "done") return "done";
  return "idle";
}

/** The worker whose pane is `pane` (%N). */
export function workerInPane(coordination: Coordination, pane: string): CoordinationPane | undefined {
  return coordination.workers.find((worker) => worker.pane === pane);
}

export function workerNamed(coordination: Coordination, name: string): CoordinationPane | undefined {
  return coordination.workers.find((worker) => worker.task === name)
    ?? (coordination.coordinator?.task === name ? coordination.coordinator : undefined);
}

const MARKER = "⟢ agents · ";
const READ = " · read ";

/** A wake-up or message line: its summary and the file with the whole of it. */
export function parseDelivery(text: string): { summary: string; file?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(MARKER)) return null;
  const rest = trimmed.slice(MARKER.length);
  const at = rest.lastIndexOf(READ);
  if (at < 0) return { summary: rest.split("\n")[0] };
  return { summary: rest.slice(0, at).trim(), file: rest.slice(at + READ.length).split(/\s/)[0] };
}

/** The tasks a summary names ("Worker ios-tests is done; Worker ui is blocked"). */
export function tasksIn(summary: string): string[] {
  return [...summary.matchAll(/\bWorker ([\w.-]+?)(?='s\b|[\s;,:]|$)/g)].map((match) => match[1]);
}

/** The first prompt a coordinator gives a worker: its task and brief. */
export function parseWorkerPrompt(text: string): { task: string; brief: string; respawn: boolean } | null {
  const match = text.trim().match(/^ROLE: worker\. You (were started by a coordinator for|take over) task "([^"]+)"[^]*?brief at (\S+?)(?: and|\.?\s)/);
  if (!match) return null;
  return { task: match[2], brief: match[3].replace(/[.,]$/, ""), respawn: match[1] === "take over" };
}

export type AgentEvent =
  | { kind: "spawn"; task?: string; pane?: string; agent?: string }
  | { kind: "send"; task?: string; steer: boolean }
  | { kind: "report"; state: string; line?: string }
  | { kind: "close"; tasks: string[] };

/** Splits a shell command into words, as far as the view needs: quotes and backslashes. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let has = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index];
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; has = true; }
    else if (char === "\\" && index + 1 < command.length) { word += command[++index]; has = true; }
    else if (/\s/.test(char)) { if (has || word) words.push(word); word = ""; has = false; }
    else if (char === ";" || char === "|" || char === "&") { if (has || word) words.push(word); word = ""; has = false; words.push(char); }
    else { word += char; has = true; }
  }
  if (has || word) words.push(word);
  return words;
}

/** An agent's own coordination command (agents-app-control agent …), and what its output says. */
export function parseAgentCommand(command: string, output = ""): AgentEvent | null {
  const words = shellWords(command);
  const at = words.findIndex((word, index) => word === "agent" && /agents-app-control$|^agents$|^app-control$/.test((words[index - 1] ?? "").split("/").pop() ?? ""));
  if (at < 0) return null;
  const sub = words[at + 1];
  const rest = words.slice(at + 2);
  const end = rest.findIndex((word) => word === ";" || word === "|" || word === "&");
  const args = end < 0 ? rest : rest.slice(0, end);
  const flag = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
  const has = (name: string) => args.includes(`--${name}`);
  let result: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(output.trim().split("\n").filter((line) => line.startsWith("{")).pop() ?? "{}") as { result?: Record<string, unknown> };
    result = parsed.result ?? {};
  } catch { /* not JSON */ }
  const paneOf = (value: unknown) => (typeof value === "string" ? value.replace(/^[\w-]+:/, "") : undefined);
  switch (sub) {
    case "spawn":
    case "respawn":
      return { kind: "spawn", task: (result.task as string | undefined) ?? flag("task"), pane: paneOf(result.newPane ?? result.pane), agent: flag("agent") ?? flag("harness") };
    case "send":
      return { kind: "send", task: flag("to"), steer: flag("mode") === "steer" };
    case "report": {
      const state = has("done") ? "done" : has("blocked") ? "blocked" : flag("ask") ? `ask-${flag("ask")}` : "progress";
      const line = args.find((word, index) => !word.startsWith("--") && !(args[index - 1] ?? "").startsWith("--ask"));
      return { kind: "report", state, line };
    }
    case "close":
      return { kind: "close", tasks: args.filter((word) => !word.startsWith("--")) };
    default:
      return null;
  }
}

/** A coordination event as a sentence, with the task and pane it is about. */
export function describeAgentEvent(event: AgentEvent): string {
  switch (event.kind) {
    case "spawn": return `Started worker ${event.task ?? ""}`.trim();
    case "send": return `${event.steer ? "Steered" : "Sent a message to"} ${event.task ?? "a worker"}`;
    case "report":
      return event.state === "done" ? "Reported done to the coordinator"
        : event.state === "blocked" ? "Reported blocked to the coordinator"
          : event.state === "ask-coordinator" ? "Asked the coordinator"
            : event.state === "ask-user" ? "Asked you, through the coordinator"
              : "Reported progress to the coordinator";
    case "close": return `Closed ${event.tasks.length ? event.tasks.join(", ") : "its workers"}`;
  }
}
