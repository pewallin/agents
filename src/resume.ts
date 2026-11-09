import { scan, matchesHistoryPaneFilter } from "./scanner.js";
import { codexReasoningEffortForSession, normalizeHistoryCwd } from "./scanner-history.js";
import { stateWorkspaceCwd } from "./scanner-state-runtime.js";
import { clearStateExternalSessionId, readStateSnapshot, reportState } from "./state.js";
import { resolveProfile, type LaunchProfile } from "./config.js";
import { shellCommand, splitCommandArgv } from "./command-words.js";
import { execFileCapture } from "./shell.js";
import { setTmuxPaneCommandMetadata } from "./tmux-pane-metadata.js";
import { getSelfArgv } from "./paths.js";
import { respawnPane } from "./tmux-respawn.js";
import type { AgentPane, AgentStatus } from "./scanner-types.js";
import type { AgentSessionResumeTargetKind, AgentSessionResumeStrategy } from "./scanner-history.js";
import { handOffAgentId } from "./acp-restart.js";
import { kiroContinuedSession } from "./kiro-sessions.js";
import { describeHolder, findSessionHolders, liveHolderInputs, type SessionHolder } from "./session-holders.js";
import { acpHostMetadataPath, acpHostRuntimeTempDir, readAcpHostMetadata } from "./acp-host.js";
import { rmSync } from "node:fs";

export type AgentSessionResumeCode =
  | "agent-not-idle"
  | "session-open-elsewhere"
  | "missing-target"
  | "pane-not-found"
  | "unsupported-agent"
  | "resume-failed";

export interface AgentSessionResumeResult {
  ok: boolean;
  code?: AgentSessionResumeCode;
  message?: string;
  requiresForce?: boolean;
  agent?: string;
  pane?: string;
  tmuxPaneId?: string;
  status?: AgentStatus;
  strategy?: AgentSessionResumeStrategy;
  target?: string;
  targetKind?: AgentSessionResumeTargetKind;
  command?: string;
  argv?: string[];
  /** session-open-elsewhere: where the session is open. */
  openIn?: SessionHolder;
}

/** How the resumed agent shows in Agents Next: the pane option the ACP host reads at its start
 *  (acp-host-cli.ts OPEN_IN_OPTION), so a pane that shows the ACP view stays in it. */
export type ResumeOpenIn = "acp-view" | "terminal";

export interface ResumeAgentSessionOptions {
  pane: string;
  agent?: string;
  profile?: string;
  newSession?: boolean;
  prompt?: string;
  overrideArgs?: string[];
  session?: string;
  sessionPath?: string;
  target?: string;
  targetKind?: AgentSessionResumeTargetKind;
  /** Resume even if the agent is not idle, or the session is open in another pane. */
  force?: boolean;
  openIn?: ResumeOpenIn;
}

interface ResolvedResumeTarget {
  target: string;
  targetKind: AgentSessionResumeTargetKind;
}

interface ResumeInvocation {
  strategy: AgentSessionResumeStrategy;
  argv: string[];
}

interface ResumeInvocationOptions {
  profile?: LaunchProfile;
  reasoningEffort?: string;
  prompt?: string;
  overrideArgs?: string[];
}

export interface ResumeStateSeed {
  state: "idle";
  externalSessionId?: string;
}

type TmuxPaneLookup = (paneFilter: string) => string | undefined;

function normalizeAgentName(agent: string): string {
  const normalized = agent.split("/").pop()?.toLowerCase() || agent.toLowerCase();
  if (normalized === "kiro-cli" || normalized === "kiro-cli-chat") return "kiro";
  return normalized;
}

function defaultBaseArgv(agent: string): string[] {
  return normalizeAgentName(agent) === "kiro" ? ["kiro-cli", "chat", "--tui"] : [normalizeAgentName(agent)];
}

export function agentStatusRequiresForce(status?: AgentStatus): boolean {
  return status !== "idle";
}

export function resolveResumeTarget(options: ResumeAgentSessionOptions): ResolvedResumeTarget | undefined {
  if (options.newSession) {
    return { target: "new-session", targetKind: "new-session" };
  }
  if (options.sessionPath) {
    return { target: options.sessionPath, targetKind: "session-path" };
  }
  if (options.session) {
    return { target: options.session, targetKind: "session-id" };
  }
  if (options.target && options.targetKind) {
    return { target: options.target, targetKind: options.targetKind };
  }
  return undefined;
}

export function resumeStateSeedForTarget(target: ResolvedResumeTarget, options: ResumeAgentSessionOptions): ResumeStateSeed | undefined {
  if (options.prompt?.trim()) return undefined;
  if (target.targetKind === "session-id") {
    return { state: "idle", externalSessionId: target.target };
  }
  return { state: "idle" };
}

export function agentResumeInvocation(
  agent: string,
  target: ResolvedResumeTarget,
  options: ResumeInvocationOptions = {},
): ResumeInvocation | undefined {
  const agentName = normalizeAgentName(agent);
  const baseArgv = profileArgvForAgent(agentName, options.profile);
  if (target.targetKind === "new-session") {
    return {
      strategy: "restart",
      argv: buildResumeArgv(baseArgv ?? defaultBaseArgv(agentName), [
        ...promptArgsForAgent(agentName, options.prompt),
        ...(options.overrideArgs || []),
      ]),
    };
  }

  switch (agentName) {
    case "claude":
      if (target.targetKind !== "session-id") return undefined;
      return {
        strategy: "restart",
        argv: buildResumeArgv(baseArgv ?? ["claude"], ["--resume", target.target]),
      };
    case "codex":
      if (target.targetKind !== "session-id") return undefined;
      return {
        strategy: "restart",
        argv: buildResumeArgv(
          baseArgv ?? ["codex"],
          options.reasoningEffort
            ? ["resume", "-c", `model_reasoning_effort="${options.reasoningEffort}"`, target.target]
            : ["resume", target.target],
        ),
      };
    case "copilot":
      if (target.targetKind !== "session-id") return undefined;
      return {
        strategy: "restart",
        argv: buildResumeArgv(baseArgv ?? ["copilot"], [`--resume=${target.target}`]),
      };
    case "pi":
      return {
        strategy: "switch-in-place",
        argv: buildResumeArgv(baseArgv ?? ["pi"], ["--session", target.target]),
      };
    case "opencode":
      if (target.targetKind !== "session-id") return undefined;
      return {
        strategy: "restart",
        argv: buildResumeArgv(baseArgv ?? ["opencode"], ["--session", target.target]),
      };
    case "kiro":
      if (target.targetKind !== "session-id") return undefined;
      return {
        strategy: "restart",
        argv: buildResumeArgv(baseArgv ?? defaultBaseArgv("kiro"), ["--resume-id", target.target]),
      };
    default:
      return undefined;
  }
}

function profileArgvForAgent(agent: string, profile?: LaunchProfile): string[] | undefined {
  if (!profile?.command) return undefined;
  try {
    const argv = splitCommandArgv(profile.command);
    const executable = argv[0] || "";
    return normalizeAgentName(executable) === normalizeAgentName(agent) ? argv : undefined;
  } catch {
    return undefined;
  }
}

function buildResumeArgv(baseArgv: string[], resumeArgs: string[]): string[] {
  const merged = [...baseArgv];
  for (const arg of resumeArgs) {
    if (arg !== "-c" && arg !== "--config" && merged.includes(arg)) continue;
    merged.push(arg);
  }
  return merged;
}

function promptArgsForAgent(agent: string, prompt?: string): string[] {
  const trimmed = prompt?.trim();
  if (!trimmed) return [];

  switch (agent.toLowerCase()) {
    case "copilot":
      return ["-i", trimmed];
    case "opencode":
      return ["--prompt", trimmed];
    case "claude":
    case "codex":
    case "pi":
    default:
      return [trimmed];
  }
}

export interface ResumeRespawnOptions {
  /** How to run this CLI again, e.g. [node, cli.js]. With it Codex is started through `codex-session`. */
  agentsArgv?: string[];
}

function isCodexExecutable(executable?: string): boolean {
  return (executable || "").split("/").pop()?.toLowerCase() === "codex";
}

/**
 * A resumed agent runs under the wrapper that serves its ACP view, as one the app starts does:
 * Codex through `codex-session`, which gives the pane its own app-server, and every other agent
 * with an ACP view through `acp-session --tui`, which hands its session to the view and back.
 * Without it the pane has no view (tmux restore, a resume from the session history).
 */
export function renderResumeRespawnCommand(argv: string[], options: ResumeRespawnOptions = {}): string {
  const agentCommand = shellCommand(argv);
  const handOff = handOffAgentId(argv[0]);
  const command = options.agentsArgv?.length && isCodexExecutable(argv[0])
    ? shellCommand([...options.agentsArgv, "codex-session", "--command", agentCommand])
    : options.agentsArgv?.length && handOff
      ? shellCommand([...options.agentsArgv, "acp-session", "--agent", handOff, "--tui", agentCommand])
      : agentCommand;
  return [
    `agents_prepend_path_dir() { [ -d "$1" ] || return 0; case ":$PATH:" in *":$1:"*) ;; *) PATH="$1\${PATH:+:$PATH}" ;; esac; }`,
    `agents_prepend_path_dir /opt/homebrew/bin`,
    `agents_prepend_path_dir /usr/local/bin`,
    `agents_prepend_path_dir "$HOME/.local/bin"`,
    `agents_prepend_path_dir "$HOME/.npm-global/bin"`,
    `if [ -d "$HOME/.nvm/versions/node" ]; then for agents_node_bin in $(find "$HOME/.nvm/versions/node" -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null); do agents_prepend_path_dir "$agents_node_bin"; done; fi`,
    `export PATH`,
    `exec ${command}`,
  ].join("; ");
}

function lookupTmuxPaneForResume(paneFilter: string): string | undefined {
  const result = execFileCapture("tmux", [
    "display-message",
    "-p",
    "-t",
    paneFilter,
    "#{pane_id}\t#{pane_current_path}\t#{pane_title}\t#{window_id}\t#{pane_dead}",
  ]);
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout;
}

function fallbackAgentPaneFromTmuxDisplay(
  paneFilter: string,
  agent: string,
  lookup: TmuxPaneLookup,
): AgentPane | undefined {
  const output = lookup(paneFilter);
  if (!output) return undefined;

  const [tmuxPaneIdRaw, cwdRaw, titleRaw, windowIdRaw] = output.split("\t");
  const tmuxPaneId = tmuxPaneIdRaw?.trim();
  if (!tmuxPaneId) return undefined;

  const normalizedAgent = normalizeAgentName(agent);
  return {
    pane: tmuxPaneId,
    paneId: tmuxPaneId,
    tmuxPaneId,
    title: titleRaw?.trim() || normalizedAgent,
    agent: normalizedAgent,
    status: "idle",
    cpuPercent: 0,
    memoryMB: 0,
    ...(cwdRaw?.trim() ? { cwd: normalizeHistoryCwd(cwdRaw.trim()) } : {}),
    ...(windowIdRaw?.trim() ? { windowId: windowIdRaw.trim() } : {}),
  };
}

export function resolveResumePane(
  paneFilter: string,
  panes: AgentPane[] = scan(),
  fallbackAgent?: string,
  tmuxPaneLookup: TmuxPaneLookup = lookupTmuxPaneForResume,
): AgentPane | undefined {
  const scannedPane = panes.find((pane) => matchesHistoryPaneFilter(pane, paneFilter));
  if (scannedPane) return scannedPane;

  if (!fallbackAgent?.trim()) return undefined;
  return fallbackAgentPaneFromTmuxDisplay(paneFilter, fallbackAgent, tmuxPaneLookup);
}

/** The session's holder other than `paneId`, if another pane or process has it open. */
export function sessionOpenElsewhere(agent: string, sessionIds: string[], paneId: string, panes: AgentPane[]): SessionHolder | undefined {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return undefined;
  const holders = findSessionHolders(agent, ids, paneId, liveHolderInputs(agent, ids, panes));
  return ids.map((id) => holders.get(id)).find((holder) => holder !== undefined);
}

/** Sets the pane option the pane's next ACP host reads as it starts (acp-host-cli.ts). */
function setOpenInOption(paneId: string, openIn: ResumeOpenIn): void {
  const result = execFileCapture("tmux", ["set-option", "-p", "-t", paneId, "@agents_open_in", openIn]);
  if (result.status !== 0) throw new Error(result.stderr || `tmux set-option exited ${result.status}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Waits for the ACP host the pane ran before its respawn to end, and clears what it left: the
 * pane's next host starts only once the old one is gone (acp-handoff.ts), and Agents Next opens
 * the view of the new session at the address it finds there.
 */
export function waitForOldHost(metadataPath: string, processId: number, timeoutMs = 8_000): void {
  const deadline = Date.now() + timeoutMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (processAlive(processId) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 50);
  if (!processAlive(processId) && readAcpHostMetadata(metadataPath)?.processId === processId) {
    rmSync(metadataPath, { force: true });
  }
}

export function resumeAgentSession(options: ResumeAgentSessionOptions): AgentSessionResumeResult {
  const panes = scan();
  const pane = resolveResumePane(options.pane, panes, options.agent);
  if (!pane) {
    return {
      ok: false,
      code: "pane-not-found",
      message: `No agent pane matched ${options.pane}.`,
    };
  }

  const requested = resolveResumeTarget(options);
  if (!requested) {
    return {
      ok: false,
      code: "missing-target",
      message: "A session id or session path is required.",
      agent: pane.agent,
      pane: pane.pane,
      tmuxPaneId: pane.tmuxPaneId,
      status: pane.status,
    };
  }

  const resumeAgent = normalizeAgentName(options.agent || pane.agent);
  const snapshot = readStateSnapshot();
  const cwd = stateWorkspaceCwd(resumeAgent, pane.tmuxPaneId, snapshot)
    || stateWorkspaceCwd(pane.agent, pane.tmuxPaneId, snapshot)
    || (pane.cwd ? normalizeHistoryCwd(pane.cwd) : process.cwd());
  // Kiro 3 goes on with a Kiro 2 session in a copy of its own: resume that copy (kiro-sessions.ts).
  const target = resumeAgent === "kiro" && requested.targetKind === "session-id"
    ? { ...requested, target: kiroContinuedSession(requested.target) }
    : requested;

  // Most agents let a second process open a session another has open, and both write it
  // (docs/acp-view-client.md): a session open elsewhere is gone to there, not opened again.
  const openIn = target.targetKind === "session-id" && !options.force
    ? sessionOpenElsewhere(resumeAgent, [target.target, requested.target], pane.tmuxPaneId, panes)
    : undefined;
  if (openIn) {
    return {
      ok: false,
      code: "session-open-elsewhere",
      message: `The session is open in ${describeHolder(openIn)}; pass --force to open it here as well.`,
      openIn,
      agent: pane.agent,
      pane: pane.pane,
      tmuxPaneId: pane.tmuxPaneId,
      status: pane.status,
      target: target.target,
      targetKind: target.targetKind,
    };
  }

  if (agentStatusRequiresForce(pane.status) && !options.force) {
    return {
      ok: false,
      code: "agent-not-idle",
      message: `Pane ${pane.tmuxPaneId} is ${pane.status}; pass --force to resume anyway.`,
      requiresForce: true,
      agent: pane.agent,
      pane: pane.pane,
      tmuxPaneId: pane.tmuxPaneId,
      status: pane.status,
      target: target.target,
      targetKind: target.targetKind,
    };
  }

  const reasoningEffort = resumeAgent === "codex" && target.targetKind === "session-id"
    ? codexReasoningEffortForSession(target.target)
    : undefined;
  const invocation = agentResumeInvocation(resumeAgent, target, {
    profile: resolveProfile(options.profile || resumeAgent),
    reasoningEffort,
    prompt: options.prompt,
    overrideArgs: options.overrideArgs,
  });
  if (!invocation) {
    return {
      ok: false,
      code: "unsupported-agent",
      message: `Resume is not supported for ${resumeAgent}.`,
      agent: resumeAgent,
      pane: pane.pane,
      tmuxPaneId: pane.tmuxPaneId,
      status: pane.status,
      target: target.target,
      targetKind: target.targetKind,
    };
  }

  const command = shellCommand(invocation.argv);
  const respawnCommand = renderResumeRespawnCommand(invocation.argv, { agentsArgv: getSelfArgv() });

  try {
    if (target.targetKind === "new-session") {
      clearStateExternalSessionId(resumeAgent, pane.tmuxPaneId);
    }
    if (options.openIn) setOpenInOption(pane.tmuxPaneId, options.openIn);
    const hostMetadataPath = acpHostMetadataPath(acpHostRuntimeTempDir(), pane.tmuxPaneId);
    const oldHost = readAcpHostMetadata(hostMetadataPath);
    // Safe on tmux before 3.8 with Agents Next attached (tmux-respawn.ts).
    respawnPane(pane.tmuxPaneId, ["-k", "-t", pane.tmuxPaneId, "-c", cwd, respawnCommand], (args) => {
      const result = execFileCapture("tmux", args);
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || result.error?.message || `tmux ${args[0]} exited ${result.status}`);
      }
      return result.stdout;
    });
    if (oldHost) waitForOldHost(hostMetadataPath, oldHost.processId);
    setTmuxPaneCommandMetadata(pane.tmuxPaneId, {
      agent: resumeAgent,
      command,
      launchCommand: command,
      cwd,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "resume-failed",
      message,
      agent: pane.agent,
      pane: pane.pane,
      tmuxPaneId: pane.tmuxPaneId,
      status: pane.status,
      strategy: invocation.strategy,
      target: target.target,
      targetKind: target.targetKind,
      command,
      argv: invocation.argv,
    };
  }

  const stateSeed = resumeStateSeedForTarget(target, options);
  if (stateSeed) {
    try {
      if (!stateSeed.externalSessionId) {
        clearStateExternalSessionId(resumeAgent, pane.tmuxPaneId);
      }
      reportState(resumeAgent, pane.tmuxPaneId, stateSeed.state, {
        clearDetail: true,
        activity: false,
        ...(stateSeed.externalSessionId ? { externalSessionId: stateSeed.externalSessionId } : {}),
      });
    } catch {}
  }

  return {
    ok: true,
    agent: resumeAgent,
    pane: pane.pane,
    tmuxPaneId: pane.tmuxPaneId,
    status: pane.status,
    strategy: invocation.strategy,
    target: target.target,
    targetKind: target.targetKind,
    command,
    argv: invocation.argv,
  };
}
