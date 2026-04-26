import { execFileSync } from "child_process";
import { scan, matchesHistoryPaneFilter } from "./scanner.js";
import { renderShellCommand, normalizeHistoryCwd } from "./scanner-history.js";
import { stateWorkspaceCwd } from "./scanner-state-runtime.js";
import { clearStateExternalSessionId, readStateSnapshot } from "./state.js";
import { resolveProfile, type LaunchProfile } from "./config.js";
import { splitCommandArgv } from "./workspace.js";
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
  newSession?: boolean;
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

export function agentResumeInvocation(
  agent: string,
  target: ResolvedResumeTarget,
  options: ResumeInvocationOptions = {},
): ResumeInvocation | undefined {
  const baseArgv = profileArgvForAgent(agent, options.profile);
  if (target.targetKind === "new-session") {
    return {
      strategy: "restart",
      argv: baseArgv ?? [agent.toLowerCase()],
    };
  }

  switch (agent.toLowerCase()) {
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
        argv: buildResumeArgv(baseArgv ?? ["codex"], ["resume", target.target]),
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
    default:
      return undefined;
  }
}

function profileArgvForAgent(agent: string, profile?: LaunchProfile): string[] | undefined {
  if (!profile?.command) return undefined;
  try {
    const argv = splitCommandArgv(profile.command);
    const executable = argv[0]?.split("/").pop()?.toLowerCase();
    return executable === agent.toLowerCase() ? argv : undefined;
  } catch {
    return undefined;
  }
}

function buildResumeArgv(baseArgv: string[], resumeArgs: string[]): string[] {
  const merged = [...baseArgv];
  for (const arg of resumeArgs) {
    if (merged.includes(arg)) continue;
    merged.push(arg);
  }
  return merged;
}

export function resolveResumePane(paneFilter: string, panes: AgentPane[] = scan()): AgentPane | undefined {
  return panes.find((pane) => matchesHistoryPaneFilter(pane, paneFilter));
}

export function resumeAgentSession(options: ResumeAgentSessionOptions): AgentSessionResumeResult {
  const pane = resolveResumePane(options.pane);
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

  const resumeAgent = options.agent?.toLowerCase() || pane.agent;
  const invocation = agentResumeInvocation(resumeAgent, target, { profile: resolveProfile(resumeAgent) });
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

  try {
    if (target.targetKind === "new-session") {
      clearStateExternalSessionId(resumeAgent, pane.tmuxPaneId);
    }
    execFileSync("tmux", [
      "respawn-pane",
      "-k",
      "-t",
      pane.tmuxPaneId,
      "-c",
      cwd,
      command,
    ], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
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
