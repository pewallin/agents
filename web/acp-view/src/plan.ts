// The agent's own todo list (an ACP `plan` update: Claude Code's TodoWrite and tasks, Codex's
// update_plan) as the view shows it above the field: the step under way and how many are done.
import type { PlanEntry } from "@agentclientprotocol/sdk";

/** A todo list an agent keeps as a Markdown checklist in a tool call's input instead of sending
 *  a plan: Copilot's update_todo (`{ todos: "- [x] Read\n- [ ] Fix" }`). */
export function planFromToolInput(rawInput: unknown): PlanEntry[] | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const todos = (rawInput as { todos?: unknown }).todos;
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
