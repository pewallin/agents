import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { choicesOf, currentName, MODEL_STATE_OPTION, settingLabel, settingTitle, splitOptions, withModels } from "./session-options";

const select = (id: string, name: string, category: string | undefined, currentValue: string, values: string[], description?: string) => ({
  id, name, type: "select", currentValue, ...(category ? { category } : {}), ...(description ? { description } : {}),
  options: values.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
}) as unknown as SessionConfigOption;

// Kiro 3's session settings, as it gives them.
const kiro = [
  select("mode", "Mode", "mode", "agents-reporting", ["vibe", "agents-reporting"]),
  select("model", "Model", "model", "claude-opus-5.5", ["auto", "claude-opus-5.5"]),
  select("memoryReflection", "Memory reflection", undefined, "off", ["on", "off"], "Allow this session to reflect on new memory"),
  select("autopilot", "Autopilot", undefined, "autopilot", ["autopilot", "supervised"]),
];

describe("the session's settings in the composer", () => {
  it("names each for what it sets: a Kiro or OpenCode mode is the agent it runs", () => {
    expect(kiro.map((option) => settingLabel(option, "kiro"))).toEqual(["Agent", "Model", "Memory reflection", "Autopilot"]);
    expect(settingLabel(kiro[0], "claude-acp")).toBe("Mode");
    expect(settingLabel(select("effort", "Effort levels", "thought_level", "high", ["high"]), "claude-acp")).toBe("Effort");
  });

  it("says in the tooltip what the agent says it does", () => {
    expect(settingTitle(kiro[2], "kiro")).toBe("Memory reflection: Allow this session to reflect on new memory");
    expect(settingTitle(kiro[0], "kiro")).toBe("Agent: Mode");
    expect(settingTitle(kiro[1], "kiro")).toBe("Model");
  });

  it("keeps mode, model and effort in the row and the agent's other choices under ⋯", () => {
    const { row, more } = splitOptions(kiro);
    expect(row.map((option) => option.id)).toEqual(["mode", "model"]);
    expect(more.map((option) => option.id)).toEqual(["memoryReflection", "autopilot"]);
  });

  it("reads choices flat or grouped, and names the current one", () => {
    const grouped = { ...kiro[1], options: [{ group: "all", name: "All", options: [{ value: "auto", name: "Auto" }, { value: "claude-opus-5.5", name: "Claude Opus 5.5" }] }] } as unknown as SessionConfigOption;
    expect(choicesOf(grouped).map((choice) => choice.value)).toEqual(["auto", "claude-opus-5.5"]);
    expect(currentName(grouped)).toBe("Claude Opus 5.5");
    expect(currentName(kiro[3])).toBe("Autopilot");
  });
});

describe("an agent that offers its models in the session's models field", () => {
  // Kiro's v2 engine: modes for its agents, and models, but no config options.
  const models = { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "auto" }, { modelId: "claude-haiku-4.5", name: "claude-haiku-4.5" }] };

  it("gets a model picker in the row", () => {
    const { row } = splitOptions(withModels([], models));
    expect(row.map((option) => option.id)).toEqual([MODEL_STATE_OPTION]);
    expect(settingLabel(row[0], "kiro")).toBe("Model");
    expect(choicesOf(row[0]).map((choice) => choice.value)).toEqual(["auto", "claude-haiku-4.5"]);
    expect(currentName(row[0])).toBe("auto");
  });

  it("keeps the agent's own model option where it has one, and makes nothing of a single model", () => {
    expect(withModels(kiro, models)).toBe(kiro);
    expect(withModels([], { currentModelId: "auto", availableModels: [{ modelId: "auto" }] })).toEqual([]);
    expect(withModels([], undefined)).toEqual([]);
  });
});
