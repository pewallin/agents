// Slash commands in the composer: "/" at the start of the field lists the agent's commands (its
// available_commands_update) and a few of the view's own. An agent's command goes to it as prompt
// text ("/name args"), which is how ACP runs them; a view command acts here.
import type { AvailableCommand, SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";

/** A command the view runs itself, not the agent. */
export type ViewCommandId = "terminal" | "changes" | "mode" | "model" | "effort" | "resume" | "new";

export interface SlashCommand {
  name: string;
  description: string;
  /** What to write after the name, if it takes anything. */
  hint?: string;
  /** Set for the view's own commands. */
  view?: ViewCommandId;
}

export interface Choice { value: string; name: string }

/** The view's commands that set a select option, by the option's category. */
const OPTION_COMMANDS: Array<{ id: "mode" | "model" | "effort"; category: string; description: string }> = [
  { id: "mode", category: "mode", description: "Switch the agent's mode" },
  { id: "model", category: "model", description: "Switch the model" },
  { id: "effort", category: "thought_level", description: "Set how hard the model thinks" },
];

type SelectEntry = { value?: string; name: string; options?: Array<{ value: string; name: string }> };

/** The choices of a select option, groups flattened. */
export function selectChoices(option: SessionConfigOption): Choice[] {
  if (option.type !== "select") return [];
  return (option.options as SelectEntry[])
    .flatMap((entry): SelectEntry[] => entry.options ?? [entry])
    .flatMap((entry): Choice[] => (typeof entry.value === "string" ? [{ value: entry.value, name: entry.name }] : []));
}

/** Where a view command that sets something sets it: a config option, or the session's modes. */
export type OptionTarget = { kind: "config"; id: string; choices: Choice[]; current?: string } | { kind: "modes"; choices: Choice[]; current?: string };

export function optionTarget(id: ViewCommandId, configOptions: SessionConfigOption[], modes?: SessionModeState | null): OptionTarget | null {
  const spec = OPTION_COMMANDS.find((entry) => entry.id === id);
  if (!spec) return null;
  const option = configOptions.find((entry) => entry.type === "select" && entry.category === spec.category);
  if (option) return { kind: "config", id: option.id, choices: selectChoices(option), current: String(option.currentValue) };
  if (id === "mode" && modes && modes.availableModes.length > 1) {
    return { kind: "modes", choices: modes.availableModes.map((mode) => ({ value: mode.id, name: mode.name })), current: modes.currentModeId };
  }
  return null;
}

/** The view's own commands this session can run. */
export function viewCommands(context: {
  configOptions: SessionConfigOption[];
  modes?: SessionModeState | null;
  /** The view is in Agents Next, which can show the pane's terminal again. */
  inApp: boolean;
  /** Agents Next can open another conversation in the pane (conversations.ts). */
  conversations?: boolean;
}): SlashCommand[] {
  const commands: SlashCommand[] = [];
  if (context.inApp) commands.push({ name: "terminal", description: "Show the agent's terminal in this pane", view: "terminal" });
  if (context.conversations) {
    // /chat is Kiro's name for it; both hide the agent's own, which ACP does not run.
    commands.push(
      { name: "resume", description: "Open an earlier conversation in this pane", view: "resume" },
      { name: "chat", description: "Open an earlier conversation in this pane (as /resume)", view: "resume" },
      { name: "new", description: "Start a new conversation in this pane", view: "new" },
    );
  }
  commands.push({ name: "changes", description: "Review the files changed in this conversation", view: "changes" });
  for (const spec of OPTION_COMMANDS) {
    const target = optionTarget(spec.id, context.configOptions, context.modes);
    if (target && target.choices.length > 1) commands.push({ name: spec.id, description: spec.description, hint: target.choices.map((choice) => choice.value).slice(0, 4).join(" | "), view: spec.id });
  }
  return commands;
}

/** Every command "/" offers: the agent's, then the view's. A view command that sets an option
 *  hides the agent's command of the same name (the view sets it directly, at once). */
export function allCommands(agent: AvailableCommand[], view: SlashCommand[]): SlashCommand[] {
  const viewNames = new Set(view.map((command) => command.name));
  const fromAgent = agent
    .filter((command) => !viewNames.has(command.name))
    .map((command): SlashCommand => ({
      name: command.name,
      description: command.description ?? "",
      hint: command.input && "hint" in command.input ? command.input.hint : undefined,
    }));
  return [...fromAgent, ...view];
}

/** What the field holds, read as a command: the name being written (caret still in it), or a
 *  whole name and its arguments. Null when the field does not start with "/". */
export type SlashDraft = { stage: "name"; query: string } | { stage: "args"; name: string; args: string };

export function slashDraft(text: string, caret: number): SlashDraft | null {
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  const space = text.search(/\s/);
  if (space < 0 || caret <= space) {
    if (caret > (space < 0 ? text.length : space)) return null;
    return { stage: "name", query: text.slice(1, space < 0 ? text.length : space) };
  }
  return { stage: "args", name: text.slice(1, space), args: text.slice(space + 1) };
}

/** The commands matching what is written after "/": the name itself first, then names that start with it, then names that
 *  contain it, then descriptions that do; each group in the order given. */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const lower = query.toLowerCase();
  if (!lower) return commands;
  const exact: SlashCommand[] = [];
  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  const described: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name === lower) exact.push(command);
    else if (name.startsWith(lower)) starts.push(command);
    else if (name.includes(lower)) contains.push(command);
    else if (command.description.toLowerCase().includes(lower)) described.push(command);
  }
  return [...exact, ...starts, ...contains, ...described];
}

/** The choices for a view command's argument, matching what is written. */
export function filterChoices(choices: Choice[], query: string): Choice[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return choices;
  return choices.filter((choice) => choice.value.toLowerCase().includes(lower) || choice.name.toLowerCase().includes(lower));
}

/** The choice an argument names: its value or its name, exactly (any case), else the only match. */
export function choiceFor(choices: Choice[], arg: string): Choice | undefined {
  const lower = arg.trim().toLowerCase();
  if (!lower) return undefined;
  const exact = choices.find((choice) => choice.value.toLowerCase() === lower || choice.name.toLowerCase() === lower);
  if (exact) return exact;
  const matching = filterChoices(choices, lower);
  return matching.length === 1 ? matching[0] : undefined;
}

/** Whether a view command lists choices to pick from after its name (an option's values, the
 *  conversations of /resume) rather than running at once. */
export function viewCommandPicks(id: ViewCommandId, target: OptionTarget | null): boolean {
  return id === "resume" || target !== null;
}

/** Whether a command must have something written after it before it runs: it has a hint that
 *  does not say the input is optional ("[instructions]", "<optional …>"). */
export function needsInput(command: SlashCommand): boolean {
  const hint = command.hint?.trim();
  return Boolean(hint) && !hint!.startsWith("[") && !/optional|no args/i.test(hint!);
}
