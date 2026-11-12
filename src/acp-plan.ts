// The pane agent's own todo list, as its ACP traffic carries it: a `plan` update (Claude Code's
// TodoWrite, Codex's update_plan) or a Markdown checklist in a tool call's input (Copilot's
// update_todo). The host keeps the latest beside its metadata, for `agents threads` to show a
// worker's step ("Step 3 of 5 · Write the tests") and its checklist; the ACP view parses the same
// traffic itself (web/acp-view/src/plan.ts).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PlanStepStatus = "completed" | "in_progress" | "pending";

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

export interface PlanFile {
  at: string;
  steps: PlanStep[];
}

const STATUSES = new Set<PlanStepStatus>(["completed", "in_progress", "pending"]);
const MAX_STEPS = 30;

function step(text: unknown, status: unknown): PlanStep | undefined {
  if (typeof text !== "string" || !text.trim()) return undefined;
  return { text: text.replace(/\s+/g, " ").trim().slice(0, 160), status: STATUSES.has(status as PlanStepStatus) ? status as PlanStepStatus : "pending" };
}

/** A checklist in a tool call's input (`{ todos: "- [x] Read\n- [ ] Fix" }`). */
export function planFromChecklist(todos: string): PlanStep[] | undefined {
  const steps: PlanStep[] = [];
  for (const line of todos.split("\n")) {
    const item = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX~-])\]\s+(.+?)\s*$/.exec(line);
    if (!item) continue;
    const mark = item[1].toLowerCase();
    const parsed = step(item[2], mark === "x" ? "completed" : mark === " " ? "pending" : "in_progress");
    if (parsed) steps.push(parsed);
  }
  return steps.length > 0 ? steps : undefined;
}

/** The plan an agent's line carries, if it carries one. */
export function planFromAgentLine(line: string): PlanStep[] | undefined {
  let message: { method?: unknown; params?: { update?: { sessionUpdate?: unknown; entries?: unknown; rawInput?: unknown } } };
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (message?.method !== "session/update") return undefined;
  const update = message.params?.update;
  if (update?.sessionUpdate === "plan" && Array.isArray(update.entries)) {
    return update.entries
      .map((entry: { content?: unknown; status?: unknown }) => step(entry?.content, entry?.status))
      .filter((entry): entry is PlanStep => Boolean(entry))
      .slice(0, MAX_STEPS);
  }
  if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
    const todos = (update.rawInput as { todos?: unknown } | undefined)?.todos;
    if (typeof todos === "string") return planFromChecklist(todos)?.slice(0, MAX_STEPS);
  }
  return undefined;
}

export function readPlanFile(path: string): PlanFile | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PlanFile>;
    return Array.isArray(value.steps) && typeof value.at === "string" ? value as PlanFile : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the latest plan the agent sent in its file; an empty plan removes it. */
export class AcpPlanRecorder {
  private last = "";

  constructor(private readonly path: string) {}

  agentLine(line: string): void {
    // Most lines are message chunks: only a plan or a tool call is parsed.
    if (!line.includes("\"plan\"") && !line.includes("todos")) return;
    const steps = planFromAgentLine(line);
    if (!steps) return;
    const key = JSON.stringify(steps);
    if (key === this.last) return;
    this.last = key;
    try {
      if (steps.length === 0) {
        rmSync(this.path, { force: true });
        return;
      }
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), steps } satisfies PlanFile), { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      // The view shows the plan without it.
    }
  }

  close(): void {
    rmSync(this.path, { force: true });
  }
}
