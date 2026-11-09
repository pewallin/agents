// The agent's own todo list (an ACP `plan` update: Claude Code's TodoWrite and tasks, Codex's
// update_plan) as the view shows it above the field: the step under way and how many are done.
import type { PlanEntry } from "@agentclientprotocol/sdk";

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
