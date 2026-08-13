import { scan, matchesHistoryPaneFilter } from "./scanner.js";
import { codexReasoningEffortForSession, renderShellCommand, normalizeHistoryCwd } from "./scanner-history.js";
import { stateWorkspaceCwd } from "./scanner-state-runtime.js";
import { clearStateExternalSessionId, readStateSnapshot, reportState } from "./state.js";
import { resolveProfile, type LaunchProfile } from "./config.js";
import { splitCommandArgv } from "./workspace.js";
import { execFileCapture } from "./shell.js";
import { setTmuxPaneCommandMetadata } from "./tmux-pane-metadata.js";
import type { AgentPane, AgentStatus } from "./scanner-types.js";
import type { AgentSessionResumeTargetKind, AgentSessionResumeStrategy } from "./scanner-history.js";

export type AgentSessionResumeCode =
  | "agent-not-idle"
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
}

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
  force?: boolean;
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
        argv: buildResumeArgv(baseArgv ?? ["pi"], ["--session", target.target, "--yolo"]),
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

export function renderResumeRespawnCommand(argv: string[]): string {
  const command = renderShellCommand(argv);
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

export function resumeAgentSession(options: ResumeAgentSessionOptions): AgentSessionResumeResult {
  const pane = resolveResumePane(options.pane, scan(), options.agent);
  if (!pane) {
    return {
      ok: false,
      code: "pane-not-found",
      message: `No agent pane matched ${options.pane}.`,
    };
  }

  const target = resolveResumeTarget(options);
  if (!target) {
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

  const resumeAgent = normalizeAgentName(options.agent || pane.agent);
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

  const snapshot = readStateSnapshot();
  const cwd = stateWorkspaceCwd(resumeAgent, pane.tmuxPaneId, snapshot)
    || stateWorkspaceCwd(pane.agent, pane.tmuxPaneId, snapshot)
    || (pane.cwd ? normalizeHistoryCwd(pane.cwd) : process.cwd());
  const command = renderShellCommand(invocation.argv);
  const respawnCommand = renderResumeRespawnCommand(invocation.argv);

  try {
    if (target.targetKind === "new-session") {
      clearStateExternalSessionId(resumeAgent, pane.tmuxPaneId);
    }
    const respawn = execFileCapture("tmux", [
      "respawn-pane",
      "-k",
      "-t",
      pane.tmuxPaneId,
      "-c",
      cwd,
      respawnCommand,
    ]);
    if (respawn.status !== 0) {
      throw new Error(respawn.stderr || respawn.stdout || respawn.error?.message || `tmux respawn-pane exited ${respawn.status}`);
    }
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
