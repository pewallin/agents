// The agent's own todo list as the view shows it above the field: the step under way and how
// many are done. Agents send it as an ACP `plan` update (Claude Code's tasks, Codex's update_plan)
// or keep it in a tool call of their own (Copilot's update_todo, OpenCode's todowrite), which the
// view reads as the plan and leaves out of the conversation.
import type { PlanEntry } from "@agentclientprotocol/sdk";

type PlanToolUpdate = { title?: string | null; rawInput?: unknown };

const PLAN_TOOL_TITLES = new Set(["todowrite", "todoread", "update_todo"]);

/** Whether a tool call keeps the agent's todo list: its row would only repeat the plan line. */
export function isPlanTool(update: PlanToolUpdate): boolean {
  if (update.title && PLAN_TOOL_TITLES.has(update.title.trim().toLowerCase())) return true;
  return planFromToolInput(update.rawInput) !== undefined;
}

/** A todo list in a tool call's input: Copilot's update_todo keeps a Markdown checklist
 *  (`{ todos: "- [x] Read\n- [ ] Fix" }`), OpenCode's todowrite a list
 *  (`{ todos: [{ content, status }] }`, a cancelled step left out, empty once cleared). */
export function planFromToolInput(rawInput: unknown): PlanEntry[] | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const todos = (rawInput as { todos?: unknown }).todos;
  if (Array.isArray(todos)) {
    const entries: PlanEntry[] = [];
    for (const todo of todos as Array<{ content?: unknown; status?: unknown } | null>) {
      if (!todo || typeof todo.content !== "string" || !todo.content.trim() || todo.status === "cancelled") continue;
      const status = todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending";
      entries.push({ content: todo.content.trim(), status, priority: "medium" });
    }
    // An empty list is the agent clearing it.
    return entries;
  }
  if (typeof todos !== "string") return undefined;
  const entries: PlanEntry[] = [];
  for (const line of todos.split("\n")) {
    const item = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX~-])\]\s+(.+?)\s*$/.exec(line);
    if (!item) continue;
    const mark = item[1].toLowerCase();
    entries.push({ content: item[2], status: mark === "x" ? "completed" : mark === " " ? "pending" : "in_progress", priority: "medium" });
  }
  return entries.length > 0 ? entries : undefined;
}

export interface PlanSummary {
  done: number;
  total: number;
  /** The step under way, else the next one to do; none when every step is done. */
  current?: PlanEntry;
}

export function planSummary(plan: PlanEntry[]): PlanSummary {
  const done = plan.filter((entry) => entry.status === "completed").length;
  const current = plan.find((entry) => entry.status === "in_progress") ?? plan.find((entry) => entry.status === "pending");
  return { done, total: plan.length, current };
}

/** A plan shows while a step is left, and a finished one until the agent's turn ends. */
export function planShown(summary: PlanSummary, working: boolean): boolean {
  if (summary.total === 0) return false;
  return summary.done < summary.total || working;
}

const OPEN_KEY = "acp-view.plan-open";

export function storedPlanOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function storePlanOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // no storage
  }
}
