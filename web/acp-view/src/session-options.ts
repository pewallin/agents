// The session's settings in the composer: the agent's config options, each named for what it
// sets. Mode or agent, model and effort sit in the row; the agent's other choices (Kiro's
// autopilot and memory, Claude's agent and fast mode) are under ⋯.
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/** The categories whose option sits in the row. */
const ROW_CATEGORIES = new Set(["mode", "model", "thought_level"]);
/** Agents whose sessions' mode is the agent they run: Kiro's and OpenCode's agents. */
const AGENTS_AS_MODES = new Set(["kiro", "opencode"]);

export interface Choice { value: string; name: string }

/** The models an agent offers in the session's `models` field, as Kiro's v2 engine does instead
 *  of a model config option (ACP's older SessionModelState). */
export interface ModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name?: string | null; description?: string | null }>;
}

/** The id the view gives the model picker made from a session's `models` field: setting it is
 *  `session/set_model`, not `session/set_config_option`. */
export const MODEL_STATE_OPTION = "agents/model";

/** The session's settings with its `models` field as one more model option, where the agent
 *  offers its models that way and has no model config option. */
export function withModels(options: SessionConfigOption[], models: ModelState | undefined): SessionConfigOption[] {
  if (!models || models.availableModels.length < 2 || options.some((option) => option.category === "model")) return options;
  const model = {
    type: "select",
    id: MODEL_STATE_OPTION,
    name: "Model",
    category: "model",
    currentValue: models.currentModelId,
    options: models.availableModels.map((entry) => ({ value: entry.modelId, name: entry.name || entry.modelId, description: entry.description ?? undefined })),
  } as SessionConfigOption;
  return [...options, model];
}

/** A model state from what an agent sent, if it is one. */
export function modelStateOf(value: unknown): ModelState | undefined {
  const state = value as { currentModelId?: unknown; availableModels?: unknown } | null | undefined;
  if (typeof state?.currentModelId !== "string" || !Array.isArray(state.availableModels)) return undefined;
  const availableModels = (state.availableModels as Array<{ modelId?: unknown; name?: unknown; description?: unknown }>)
    .filter((entry) => typeof entry?.modelId === "string")
    .map((entry) => ({ modelId: entry.modelId as string, name: typeof entry.name === "string" ? entry.name : undefined, description: typeof entry.description === "string" ? entry.description : undefined }));
  return { currentModelId: state.currentModelId, availableModels };
}

/** What a session's modes set: Kiro's and OpenCode's modes are their agents. */
export function modesLabel(agentId: string): string {
  return AGENTS_AS_MODES.has(agentId) ? "Agent" : "Mode";
}

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
  if (option.category === "mode") return modesLabel(agentId);
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
