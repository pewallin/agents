// The session's settings in the composer: the agent's config options, each named for what it
// sets. Mode or agent, model and effort sit in the row; the agent's other choices (Kiro's
// autopilot and memory, Claude's agent and fast mode) are under ⋯.
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/** The categories whose option sits in the row. */
const ROW_CATEGORIES = new Set(["mode", "model", "thought_level"]);
/** Agents whose sessions' mode is the agent they run: Kiro's and OpenCode's agents. */
const AGENTS_AS_MODES = new Set(["kiro", "opencode"]);

export interface Choice { value: string; name: string }

type SelectEntry = { value?: string; name: string; options?: Choice[] };

/** A select option's choices, flat. */
export function choicesOf(option: SessionConfigOption): Choice[] {
  if (option.type !== "select") return [];
  return (option.options as SelectEntry[]).flatMap((entry): Choice[] => entry.options ?? (entry.value === undefined ? [] : [{ value: entry.value, name: entry.name }]));
}

/** The name of the option's current choice. */
export function currentName(option: SessionConfigOption): string {
  return choicesOf(option).find((choice) => choice.value === option.currentValue)?.name ?? String(option.currentValue);
}

/** What the option sets, in a word or two. */
export function settingLabel(option: SessionConfigOption, agentId: string): string {
  if (option.category === "mode") return AGENTS_AS_MODES.has(agentId) ? "Agent" : "Mode";
  if (option.category === "model") return "Model";
  if (option.category === "thought_level") return "Effort";
  return option.name;
}

/** The tooltip: what the option sets, as the agent describes it. */
export function settingTitle(option: SessionConfigOption, agentId: string): string {
  const label = settingLabel(option, agentId);
  const said = option.description && option.description !== label ? option.description : option.name !== label ? option.name : "";
  return said ? `${label}: ${said}` : label;
}

/** The select options in the row, and those under ⋯. */
export function splitOptions(options: SessionConfigOption[]): { row: SessionConfigOption[]; more: SessionConfigOption[] } {
  const selects = options.filter((option) => option.type === "select" && choicesOf(option).length > 0);
  return {
    row: selects.filter((option) => typeof option.category === "string" && ROW_CATEGORIES.has(option.category)),
    more: selects.filter((option) => typeof option.category !== "string" || !ROW_CATEGORIES.has(option.category)),
  };
}
