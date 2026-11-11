import { describe, expect, it } from "vitest";
import { describeAgentEvent, parseAgentCommand, parseDelivery, parseWorkerPrompt, shellWords, tasksIn, workerInPane, workerState } from "./coordination";

describe("coordination lines", () => {
  it("reads a wake-up line", () => {
    const line = "⟢ agents · Worker ios-tests is done; Worker ui is blocked · read /Users/p/.agents/programs/app/messages/20261107T014200-ab12.md";
    expect(parseDelivery(line)).toEqual({ summary: "Worker ios-tests is done; Worker ui is blocked", file: "/Users/p/.agents/programs/app/messages/20261107T014200-ab12.md" });
    expect(tasksIn("Worker ios-tests is done; Worker ui's pane closed")).toEqual(["ios-tests", "ui"]);
    expect(parseDelivery("hello")).toBeNull();
  });

  it("reads a worker's first prompt", () => {
    const prompt = `ROLE: worker. You were started by a coordinator for task "ios-tests". Read your brief at /p/tasks/ios-tests/brief.md and do the task. Write in English. Report with: '/x/agents-app-control' agent report "<one-line status>" --done (or --blocked).`;
    expect(parseWorkerPrompt(prompt)).toEqual({ task: "ios-tests", brief: "/p/tasks/ios-tests/brief.md", respawn: false });
    expect(parseWorkerPrompt(`ROLE: worker. You take over task "ui" from an earlier worker. Read your brief at /p/tasks/ui/brief.md and the earlier worker's report`)?.respawn).toBe(true);
  });

  it("reads an agent's coordination commands", () => {
    expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g; h`)).toEqual(["a", "b c", 'd "e"', "f g", ";", "h"]);
    expect(parseAgentCommand(`/x/agents-app-control agent spawn "Run the iOS tests" --task ios-tests --agent codex`, `{"ok":true,"result":{"newPane":"local:%4","task":"ios-tests"}}`))
      .toEqual({ kind: "spawn", task: "ios-tests", pane: "%4", agent: "codex" });
    expect(parseAgentCommand(`agents-app-control agent send "Use the other fixture" --to ios-tests --mode steer`)).toEqual({ kind: "send", task: "ios-tests", steer: true });
    expect(parseAgentCommand(`'/x/agents-app-control' agent report "All 13 pass" --done`)).toEqual({ kind: "report", state: "done", line: "All 13 pass" });
    expect(parseAgentCommand(`agents-app-control agent close ios-tests ui`)).toEqual({ kind: "close", tasks: ["ios-tests", "ui"] });
    expect(parseAgentCommand(`agents app-control agent close ios-tests`)).toEqual({ kind: "close", tasks: ["ios-tests"] });
    expect(parseAgentCommand(`git status`)).toBeNull();
    expect(describeAgentEvent({ kind: "send", task: "ios-tests", steer: true })).toBe("Steered ios-tests");
  });
});

describe("worker state", () => {
  it("says where a worker stands from its agent's state and its report", () => {
    expect(workerState({ pane: "%1", status: "question" })).toBe("needs-you");
    expect(workerState({ pane: "%1", status: "idle", report: "ask-user" })).toBe("needs-you");
    expect(workerState({ pane: "%1", status: "idle", report: "blocked" })).toBe("blocked");
    expect(workerState({ pane: "%1", status: "working", report: "done" })).toBe("working");
    expect(workerState({ pane: "%1", status: "idle", report: "done" })).toBe("done");
    expect(workerState({ pane: "%1", status: "idle", report: "progress" })).toBe("idle");
  });

  it("finds a worker by its pane, for the chips that name the pane", () => {
    const coordination = { role: "coordinator" as const, workers: [{ pane: "%4", task: "ui" }, { pane: "%7", task: "api" }] };
    expect(workerInPane(coordination, "%7")?.task).toBe("api");
    expect(workerInPane(coordination, "%9")).toBeUndefined();
  });
});
