import { describe, expect, it } from "vitest";
import type { PlanEntry } from "@agentclientprotocol/sdk";
import { planShown, planSummary } from "./plan";

const entry = (content: string, status: PlanEntry["status"]): PlanEntry => ({ content, status, priority: "medium" });

describe("planSummary", () => {
  it("names the step under way and counts the done ones", () => {
    const summary = planSummary([entry("Read", "completed"), entry("Fix", "in_progress"), entry("Test", "pending")]);
    expect(summary).toEqual({ done: 1, total: 3, current: entry("Fix", "in_progress") });
  });

  it("names the next step when none is under way", () => {
    expect(planSummary([entry("Read", "completed"), entry("Test", "pending")]).current?.content).toBe("Test");
  });

  it("names none when every step is done", () => {
    expect(planSummary([entry("Read", "completed")]).current).toBeUndefined();
  });
});

describe("planShown", () => {
  it("hides an empty plan", () => {
    expect(planShown(planSummary([]), true)).toBe(false);
  });

  it("shows a plan with steps left, also between turns", () => {
    expect(planShown(planSummary([entry("Test", "pending")]), false)).toBe(true);
  });

  it("shows a finished plan until the turn ends", () => {
    const finished = planSummary([entry("Read", "completed")]);
    expect(planShown(finished, true)).toBe(true);
    expect(planShown(finished, false)).toBe(false);
  });
});
