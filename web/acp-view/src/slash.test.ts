import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { allCommands, choiceFor, filterCommands, needsInput, optionTarget, slashDraft, viewCommandPicks, viewCommands } from "./slash";

const model: SessionConfigOption = {
  id: "model", name: "Model", type: "select", category: "model", currentValue: "sonnet",
  options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }],
} as SessionConfigOption;

describe("slashDraft", () => {
  it("reads the name while the caret is in it, and the arguments after a space", () => {
    expect(slashDraft("/com", 4)).toEqual({ stage: "name", query: "com" });
    expect(slashDraft("/", 1)).toEqual({ stage: "name", query: "" });
    expect(slashDraft("/compact keep the plan", 22)).toEqual({ stage: "args", name: "compact", args: "keep the plan" });
    expect(slashDraft("/compact keep", 3)).toEqual({ stage: "name", query: "compact" });
  });
  it("is nothing for text that does not start with one slash", () => {
    expect(slashDraft("fix /tmp", 8)).toBeNull();
    expect(slashDraft("//not a command", 5)).toBeNull();
  });
});

describe("commands", () => {
  it("lists the agent's commands, then the view's, the view's hiding an agent command of the same name", () => {
    const view = viewCommands({ configOptions: [model], inApp: true });
    expect(view.map((command) => command.name)).toEqual(["terminal", "changes", "model"]);
    const all = allCommands([
      { name: "compact", description: "Free up context", input: { hint: "<instructions>" } },
      { name: "model", description: "The agent's own" },
    ], view);
    expect(all.map((command) => command.name)).toEqual(["compact", "terminal", "changes", "model"]);
    expect(all[0].hint).toBe("<instructions>");
    expect(all.find((command) => command.name === "model")?.view).toBe("model");
  });
  it("offers /terminal only inside the app, and /mode from the session's modes", () => {
    const view = viewCommands({
      configOptions: [], inApp: false,
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
    });
    expect(view.map((command) => command.name)).toEqual(["changes", "mode"]);
  });
  it("puts names that start with the query first, then names and descriptions that contain it", () => {
    const commands = [
      { name: "review", description: "" }, { name: "compact", description: "" },
      { name: "security-review", description: "" }, { name: "init", description: "review setup" },
    ];
    expect(filterCommands(commands, "rev").map((command) => command.name)).toEqual(["review", "security-review", "init"]);
    expect(filterCommands([{ name: "init-db", description: "" }, { name: "init", description: "" }], "init").map((command) => command.name)).toEqual(["init", "init-db"]);
  });
});

describe("choices", () => {
  it("finds a choice by value, name or a single partial match", () => {
    const target = optionTarget("model", [model])!;
    expect(target.current).toBe("sonnet");
    expect(choiceFor(target.choices, "Opus")?.value).toBe("opus");
    expect(choiceFor(target.choices, "son")?.value).toBe("sonnet");
    expect(choiceFor(target.choices, "o")).toBeUndefined();
  });
});

describe("needsInput", () => {
  it("waits for input only when the hint does not say it is optional", () => {
    expect(needsInput({ name: "batch", description: "", hint: "<instruction>" })).toBe(true);
    expect(needsInput({ name: "compact", description: "", hint: "<optional custom summarization instructions>" })).toBe(false);
    expect(needsInput({ name: "simplify", description: "", hint: "[<target>]" })).toBe(false);
    expect(needsInput({ name: "steering", description: "", hint: "(no args to show) all | one-at-a-time" })).toBe(false);
    expect(needsInput({ name: "init", description: "" })).toBe(false);
  });
});

describe("conversation commands", () => {
  it("offers /resume, /chat and /new where the app can open a conversation, hiding the agent's own", () => {
    const view = viewCommands({ configOptions: [], inApp: true, conversations: true });
    expect(view.map((command) => [command.name, command.view])).toEqual([
      ["terminal", "terminal"], ["resume", "resume"], ["chat", "resume"], ["new", "new"], ["changes", "changes"],
    ]);
    const all = allCommands([
      { name: "chat", description: "Kiro's sessions" },
      { name: "resume", description: "Claude's picker" },
      { name: "compact", description: "Free up context" },
    ], view);
    expect(all.filter((command) => command.name === "chat" || command.name === "resume").every((command) => command.view === "resume")).toBe(true);
    expect(all.map((command) => command.name)).toContain("compact");
    expect(viewCommands({ configOptions: [], inApp: true }).map((command) => command.name)).not.toContain("resume");
  });

  it("lets /resume pick from a list and runs /new at once", () => {
    expect(viewCommandPicks("resume", null)).toBe(true);
    expect(viewCommandPicks("new", null)).toBe(false);
    expect(viewCommandPicks("model", optionTarget("model", [model]))).toBe(true);
  });
});

