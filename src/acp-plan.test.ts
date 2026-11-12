import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpPlanRecorder, planFromAgentLine, readPlanFile } from "./acp-plan.js";
import { threadPlan } from "./app-control/threads.js";

const planLine = (entries: unknown[]) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "plan", entries } } });

describe("the agent's plan as the ACP host keeps it", () => {
  it("reads a plan update (Claude Code's TodoWrite, Codex's update_plan) and Copilot's checklist", () => {
    expect(planFromAgentLine(planLine([
      { content: "Read the brief", status: "completed", priority: "medium" },
      { content: "Write  the\ntests", status: "in_progress", priority: "high" },
      { content: "Release", status: "pending", priority: "low" },
    ]))).toEqual([
      { text: "Read the brief", status: "completed" },
      { text: "Write the tests", status: "in_progress" },
      { text: "Release", status: "pending" },
    ]);
    const copilot = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "t", rawInput: { todos: "- [x] Read\n- [~] Fix\n- [ ] Ship" } } } });
    expect(planFromAgentLine(copilot)).toEqual([
      { text: "Read", status: "completed" },
      { text: "Fix", status: "in_progress" },
      { text: "Ship", status: "pending" },
    ]);
    expect(planFromAgentLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "plan" } } } }))).toBeUndefined();
  });

  it("keeps the latest plan in its file, which agents threads reads as the worker's step and checklist", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-plan-"));
    try {
      const file = join(dir, "pane-7.plan.json");
      const recorder = new AcpPlanRecorder(file);
      recorder.agentLine(planLine([
        { content: "Read the brief", status: "completed" },
        { content: "Write the tests", status: "in_progress" },
        { content: "Release", status: "pending" },
      ]));
      expect(readPlanFile(file)?.steps).toHaveLength(3);
      const plan = threadPlan("%7", () => readPlanFile(file));
      expect(plan).toMatchObject({ done: 1, total: 3, current: 1 });
      expect(plan?.steps[1]).toEqual({ text: "Write the tests", status: "in_progress" });
      // Every step done: none under way.
      recorder.agentLine(planLine([{ content: "Read the brief", status: "completed" }, { content: "Release", status: "completed" }]));
      expect(threadPlan("%7", () => readPlanFile(file))).toMatchObject({ done: 2, total: 2, current: undefined });
      recorder.agentLine(planLine([]));
      expect(readPlanFile(file)).toBeUndefined();
      recorder.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
