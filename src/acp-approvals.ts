// How an ACP view's sessions follow the pane command's choice to run tools without asking
// (`kiro-cli chat -a`, `claude --dangerously-skip-permissions`, `opencode --auto`): the view runs
// the agent's ACP adapter, which does not see the TUI's options. Where the adapter takes such an
// option itself, its entry carries it (Copilot's --yolo, Codex's INITIAL_AGENT_MODE); otherwise
// the host does what the option does, on the adapter's protocol channel:
//   mode      puts each session in the agent's own mode for it as it opens (Claude's
//             bypassPermissions), so what the agent still asks in that mode reaches the person
//   allowAll  answers each permission request itself with the agent's allow option

export type AcpApprovalPolicy = { mode: string } | { allowAll: true };

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

/**
 * The policy on one adapter process: it sees every line to and from the agent, and answers or
 * asks the agent itself through `toAgent`. A line it handles goes no further (`agentLine`).
 */
export class AcpApprovals {
  private readonly opening = new Map<string, string | undefined>();
  /** The host's own set_mode requests, by id: the session each is for. */
  private readonly own = new Map<string, { sessionId: string; mode: string }>();
  private nextId = 1;

  constructor(
    private readonly policy: AcpApprovalPolicy,
    private readonly toAgent: (line: string) => void,
    private readonly log: (message: string) => void = () => {},
    /** Tells the view what the host changed: an agent does not report a mode its client set. */
    private readonly toView: (line: string) => void = () => {},
  ) {}

  /** A message on its way to the agent. */
  clientLine(line: string): void {
    if (!("mode" in this.policy)) return;
    const message = parse(line);
    if (!message || message.id === undefined || message.id === null) return;
    if (message.method !== "session/new" && message.method !== "session/load" && message.method !== "session/resume") return;
    const sessionId = message.params?.sessionId;
    this.opening.set(String(message.id), typeof sessionId === "string" ? sessionId : undefined);
  }

  /** A message from the agent; true when the policy has handled it and it goes no further. */
  agentLine(line: string): boolean {
    const message = parse(line);
    if (!message || message.id === undefined || message.id === null) return false;
    const key = String(message.id);
    if (message.method === undefined) {
      const own = this.own.get(key);
      if (own) {
        this.own.delete(key);
        if (message.error) this.log(`the agent kept its mode: ${JSON.stringify(message.error)}`);
        else this.toView(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: own.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: own.mode } } }));
        return true;
      }
      if (this.opening.has(key)) {
        const sessionId = this.opening.get(key) ?? message.result?.sessionId;
        this.opening.delete(key);
        if (!message.error && typeof sessionId === "string") this.setMode(sessionId, message.result);
      }
      return false;
    }
    if (message.method === "session/request_permission" && "allowAll" in this.policy) {
      const optionId = allowOption(message.params?.options);
      if (!optionId) return false;
      const title = (message.params?.toolCall as { title?: unknown } | undefined)?.title;
      this.log(`allowed ${typeof title === "string" ? `"${title}"` : "a tool call"}: the pane's command runs tools without asking`);
      this.toAgent(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId } } }));
      return true;
    }
    return false;
  }

  /** Asks for the policy's mode on a session that opened in another the agent offers it. */
  private setMode(sessionId: string, result: Record<string, unknown> | undefined): void {
    if (!("mode" in this.policy)) return;
    const modes = result?.modes as { currentModeId?: unknown; availableModes?: Array<{ id?: unknown }> } | undefined;
    const mode = this.policy.mode;
    if (!modes || modes.currentModeId === mode || !modes.availableModes?.some((available) => available?.id === mode)) return;
    const id = `agents-host-approvals-${this.nextId++}`;
    this.own.set(id, { sessionId, mode });
    this.log(`session ${sessionId} goes into mode ${mode}, as the pane's command asks`);
    this.toAgent(JSON.stringify({ jsonrpc: "2.0", id, method: "session/set_mode", params: { sessionId, modeId: mode } }));
  }
}

/** The command's words up to `--`, after which come its prompt's. */
function words(command: string): string[] {
  const list = command.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/g, ""));
  const end = list.indexOf("--");
  return end >= 0 ? list.slice(0, end) : list;
}

/** The value of `name` in the command's words, as `name value` or `name=value`. */
function valueOf(list: string[], name: string): string | undefined {
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === name) return list[index + 1];
    if (list[index].startsWith(`${name}=`)) return list[index].slice(name.length + 1);
  }
  return undefined;
}

/** Claude Code: --dangerously-skip-permissions is the bypassPermissions mode; --permission-mode
 *  names a mode. --allow-dangerously-skip-permissions only offers bypass, so it sets none. */
export function claudeApprovals(tuiCommand: string): AcpApprovalPolicy | undefined {
  const list = words(tuiCommand);
  const mode = valueOf(list, "--permission-mode");
  if (mode) return { mode };
  return list.includes("--dangerously-skip-permissions") ? { mode: "bypassPermissions" } : undefined;
}

/** Kiro: -a / --trust-all-tools. `kiro-cli acp` takes it only with the v1 and v2 engines, so
 *  the host allows for every engine. */
export function kiroApprovals(tuiCommand: string): AcpApprovalPolicy | undefined {
  const list = words(tuiCommand);
  return list.includes("-a") || list.includes("--trust-all-tools") ? { allowAll: true } : undefined;
}

/** OpenCode: --auto allows what its permission rules do not deny; `opencode acp` has no such
 *  option, and a denied call is never asked about. */
export function opencodeApprovals(tuiCommand: string): AcpApprovalPolicy | undefined {
  return words(tuiCommand).includes("--auto") ? { allowAll: true } : undefined;
}
