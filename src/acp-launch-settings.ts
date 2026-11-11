// How an ACP view's sessions follow the pane's TUI command (the agent's command in Settings):
// the view runs the agent's ACP adapter, which never sees the TUI's options. Where the adapter
// takes an option itself, its entry carries it (Copilot's, Codex's thread settings); otherwise
// the host does what the option does, on the adapter's protocol channel:
//   options   the session settings the command picks (mode or agent, model, effort), set on each
//             session as it opens through the session's own config options
//             (session/set_config_option; session/set_mode for an agent with modes alone,
//             session/set_model for one with a `models` field: Kiro's v2 engine), so the
//             view's pickers show them and can change them
//   allowAll  the command runs tools without asking (`kiro-cli chat -a`, `opencode --auto`): the
//             host answers each permission request with the agent's allow option
import { commandWords } from "./command-words.js";
import { kiroSetting } from "./kiro-sessions.js";

/** A session setting by what it is: "mode" (the agent's mode or agent), "model", "effort", or
 *  the id of one of the agent's own config options ("agent" for Claude's agents). */
export type LaunchSetting = string;

export interface AcpLaunchSettings {
  options?: Record<LaunchSetting, string>;
  allowAll?: boolean;
}

type Message = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
};

function parse(line: string): Message | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Message : undefined;
  } catch {
    return undefined;
  }
}

type PermissionOption = { optionId?: unknown; kind?: unknown };

/** The option that allows this one call: allow once, else allow always. */
export function allowOption(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const kind of ["allow_once", "allow_always"]) {
    const option = (options as PermissionOption[]).find((candidate) => candidate?.kind === kind && typeof candidate.optionId === "string");
    if (option) return option.optionId as string;
  }
  return undefined;
}

interface ConfigOption {
  id?: unknown;
  category?: unknown;
  currentValue?: unknown;
  options?: Array<{ value?: unknown; name?: unknown; options?: Array<{ value?: unknown; name?: unknown }> }>;
}

/** The category ACP gives each setting's config option. */
const CATEGORIES: Record<string, string> = { mode: "mode", model: "model", effort: "thought_level" };

/** The value of a select option that `wanted` names: its value, else its value or name in any
 *  case. Values come flat or in groups. */
function selectValue(option: ConfigOption, wanted: string): string | undefined {
  const values = (option.options ?? []).flatMap((entry) => entry.options ?? [entry]);
  const exact = values.find((value) => value.value === wanted);
  if (typeof exact?.value === "string") return exact.value;
  const lower = wanted.toLowerCase();
  const loose = values.find((value) => (typeof value.value === "string" && value.value.toLowerCase() === lower)
    || (typeof value.name === "string" && value.name.toLowerCase() === lower));
  return typeof loose?.value === "string" ? loose.value : undefined;
}

export type SettingRequest =
  | { method: "session/set_config_option"; configId: string; value: string }
  | { method: "session/set_mode"; modeId: string }
  | { method: "session/set_model"; modelId: string }
  | { missing: string };

/** What to send for `setting` on a session that opened with `result`: its config option, or
 *  its mode where the agent has modes alone. Nothing when it is so already. */
export function settingRequest(setting: LaunchSetting, wanted: string, result: Record<string, unknown> | undefined): SettingRequest | undefined {
  const configOptions = Array.isArray(result?.configOptions) ? result.configOptions as ConfigOption[] : [];
  const option = configOptions.find((candidate) => candidate.id === setting)
    ?? configOptions.find((candidate) => CATEGORIES[setting] !== undefined && candidate.category === CATEGORIES[setting]);
  if (option && typeof option.id === "string") {
    const value = selectValue(option, wanted);
    if (value === undefined) return { missing: `${setting} ${wanted} is not one the agent offers` };
    return value === option.currentValue ? undefined : { method: "session/set_config_option", configId: option.id, value };
  }
  const modes = result?.modes as { currentModeId?: unknown; availableModes?: Array<{ id?: unknown; name?: unknown }> } | undefined;
  if (setting === "mode" && modes?.availableModes) {
    const lower = wanted.toLowerCase();
    const mode = modes.availableModes.find((candidate) => candidate.id === wanted)
      ?? modes.availableModes.find((candidate) => String(candidate.id).toLowerCase() === lower || String(candidate.name).toLowerCase() === lower);
    if (typeof mode?.id !== "string") return { missing: `mode ${wanted} is not one the agent offers` };
    return mode.id === modes.currentModeId ? undefined : { method: "session/set_mode", modeId: mode.id };
  }
  // Kiro's v2 engine offers its models in the session's `models` field, not as a config option.
  const models = result?.models as { currentModelId?: unknown; availableModels?: Array<{ modelId?: unknown; name?: unknown }> } | undefined;
  if (setting === "model" && Array.isArray(models?.availableModels)) {
    const lower = wanted.toLowerCase();
    const model = models.availableModels.find((candidate) => candidate.modelId === wanted)
      ?? models.availableModels.find((candidate) => String(candidate.modelId).toLowerCase() === lower || String(candidate.name).toLowerCase() === lower);
    if (typeof model?.modelId !== "string") return { missing: `model ${wanted} is not one the agent offers` };
    return model.modelId === models.currentModelId ? undefined : { method: "session/set_model", modelId: model.modelId };
  }
  return { missing: `the agent offers no ${setting} setting` };
}

/**
 * The settings on one adapter process: it sees every line to and from the agent, and asks or
 * answers the agent itself through `toAgent`. A line it handles goes no further (`agentLine`).
 */
export class AcpLaunchSettingsApplier {
  private readonly opening = new Map<string, string | undefined>();
  /** The host's own requests, by id: the session each is for, and what it sets. */
  private readonly own = new Map<string, { sessionId: string; mode?: string; model?: string; configId?: string }>();
  private nextId = 1;

  constructor(
    private readonly settings: AcpLaunchSettings,
    private readonly toAgent: (line: string) => void,
    private readonly log: (message: string) => void = () => {},
    /** Tells the view what the host changed: an agent does not report a setting its client set. */
    private readonly toView: (line: string) => void = () => {},
  ) {}

  /** A message on its way to the agent. */
  clientLine(line: string): void {
    if (!this.settings.options) return;
    const message = parse(line);
    if (!message || message.id === undefined || message.id === null) return;
    if (message.method !== "session/new" && message.method !== "session/load" && message.method !== "session/resume") return;
    const sessionId = message.params?.sessionId;
    this.opening.set(String(message.id), typeof sessionId === "string" ? sessionId : undefined);
  }

  /** A message from the agent; true when it is handled here and goes no further. */
  agentLine(line: string): boolean {
    const message = parse(line);
    if (!message || message.id === undefined || message.id === null) return false;
    const key = String(message.id);
    if (message.method === undefined) {
      const own = this.own.get(key);
      if (own) {
        this.own.delete(key);
        this.answered(own, message);
        return true;
      }
      if (this.opening.has(key)) {
        const sessionId = this.opening.get(key) ?? message.result?.sessionId;
        this.opening.delete(key);
        if (!message.error && typeof sessionId === "string") this.apply(sessionId, message.result);
      }
      return false;
    }
    if (message.method === "session/request_permission" && this.settings.allowAll) {
      const optionId = allowOption(message.params?.options);
      if (!optionId) return false;
      const title = (message.params?.toolCall as { title?: unknown } | undefined)?.title;
      this.log(`allowed ${typeof title === "string" ? `"${title}"` : "a tool call"}: the pane's command runs tools without asking`);
      this.toAgent(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId } } }));
      return true;
    }
    return false;
  }

  /** Sets what the command picks on a session that opened otherwise. The requests reach the
   *  agent before the view has the session, so its first prompt runs with them. */
  private apply(sessionId: string, result: Record<string, unknown> | undefined): void {
    for (const [setting, wanted] of Object.entries(this.settings.options ?? {})) {
      const request = settingRequest(setting, wanted, result);
      if (!request) continue;
      if ("missing" in request) {
        this.log(`session ${sessionId}: ${request.missing}; left as it is`);
        continue;
      }
      const id = `agents-host-launch-${this.nextId++}`;
      if (request.method === "session/set_mode") {
        this.own.set(id, { sessionId, mode: request.modeId });
        this.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method: request.method, params: { sessionId, modeId: request.modeId } }));
      } else if (request.method === "session/set_model") {
        this.own.set(id, { sessionId, model: request.modelId });
        this.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method: request.method, params: { sessionId, modelId: request.modelId } }));
      } else {
        this.own.set(id, { sessionId, configId: request.configId });
        this.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method: request.method, params: { sessionId, configId: request.configId, value: request.value } }));
      }
      this.log(`session ${sessionId}: ${setting} ${wanted}, as the pane's command says`);
    }
  }

  private answered(own: { sessionId: string; mode?: string; model?: string; configId?: string }, message: Message): void {
    if (message.error) {
      this.log(`session ${own.sessionId} kept its ${own.configId ?? (own.model ? "model" : "mode")}: ${JSON.stringify(message.error)}`);
      return;
    }
    const update = (body: Record<string, unknown>) =>
      this.toView(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: own.sessionId, update: body } }));
    if (own.mode) update({ sessionUpdate: "current_mode_update", currentModeId: own.mode });
    // ACP has no update for a model set through session/set_model: the host's own notice.
    if (own.model) this.toView(JSON.stringify({ jsonrpc: "2.0", method: "_agents/current_model", params: { sessionId: own.sessionId, modelId: own.model } }));
    const configOptions = message.result?.configOptions;
    if (Array.isArray(configOptions)) {
      update({ sessionUpdate: "config_option_update", configOptions });
      // The session's modes follow its mode option.
      const mode = (configOptions as ConfigOption[]).find((option) => option.id === own.configId && option.category === "mode");
      if (typeof mode?.currentValue === "string") update({ sessionUpdate: "current_mode_update", currentModeId: mode.currentValue });
    }
  }
}

/** The command's words up to `--`, after which come its prompt's. */
function words(command: string): string[] {
  const list = commandWords(command);
  const end = list.indexOf("--");
  return end >= 0 ? list.slice(0, end) : list;
}

/** The value of the first of `names` in the command's words, as `name value` or `--name=value`. */
function valueOf(list: string[], ...names: string[]): string | undefined {
  for (let index = 0; index < list.length; index += 1) {
    for (const name of names) {
      const next = list[index + 1];
      if (list[index] === name && next !== undefined && !next.startsWith("-")) return next;
      if (name.startsWith("--") && list[index].startsWith(`${name}=`)) return list[index].slice(name.length + 1) || undefined;
    }
  }
  return undefined;
}

function launchSettings(options: Record<string, string | undefined>, allowAll = false): AcpLaunchSettings | undefined {
  const set = Object.fromEntries(Object.entries(options).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
  const hasOptions = Object.keys(set).length > 0;
  if (!hasOptions && !allowAll) return undefined;
  return { ...(hasOptions ? { options: set } : {}), ...(allowAll ? { allowAll: true } : {}) };
}

/**
 * Claude Code: --model, --effort, --agent and its permission mode: --permission-mode names one,
 * --dangerously-skip-permissions is bypassPermissions (--allow-dangerously-skip-permissions only
 * offers it). The host allows nothing itself: what Claude still asks in bypass mode is the
 * person's to answer.
 */
export function claudeLaunchSettings(tuiCommand: string): AcpLaunchSettings | undefined {
  const list = words(tuiCommand);
  return launchSettings({
    mode: valueOf(list, "--permission-mode") ?? (list.includes("--dangerously-skip-permissions") ? "bypassPermissions" : undefined),
    model: valueOf(list, "--model"),
    effort: valueOf(list, "--effort"),
    agent: valueOf(list, "--agent"),
  });
}

/**
 * Kiro: --agent (Kiro's agents are the session's modes; with none named, the TUI's default
 * agent, the chat.defaultAgent setting, which `kiro-cli acp` does not follow), --model, and -a /
 * --trust-all-tools. Kiro 3's `acp` takes none of them as options of its own.
 */
export function kiroLaunchSettings(tuiCommand: string, setting: (key: string) => string | undefined = kiroSetting): AcpLaunchSettings | undefined {
  const list = words(tuiCommand);
  return launchSettings({
    mode: valueOf(list, "--agent") ?? setting("chat.defaultAgent"),
    model: valueOf(list, "--model"),
  }, list.includes("-a") || list.includes("--trust-all-tools"));
}

/** OpenCode: --agent (its agents are the session's modes), -m / --model, and --auto, which
 *  allows what its permission rules do not deny (a denied call is never asked about). */
export function opencodeLaunchSettings(tuiCommand: string): AcpLaunchSettings | undefined {
  const list = words(tuiCommand);
  return launchSettings({ mode: valueOf(list, "--agent"), model: valueOf(list, "-m", "--model") }, list.includes("--auto"));
}
