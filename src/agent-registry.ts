// The agents this CLI knows by name, and how each gets its ACP view. Everything that asks "which
// agent is this" or "how does it reach its view" asks here: the scanner's names, resume, restart,
// the hand-off host, and (through `agents acp-agents --json` and `agents agent-launch`) Agents Next
// and its agents-app-control.
import { basename } from "node:path";
import { commandWords, shellCommand } from "./command-words.js";

/** An agent's name from an executable, a path to one or a reported name: its basename, lowercase,
 *  without quotes or a login shell's dash, with Kiro's executables as "kiro". */
export function normalizeAgentName(value: string | undefined): string | undefined {
  const name = basename((value ?? "").trim().replace(/^['"]+|['"]+$/g, "")).replace(/^-/, "").toLowerCase();
  if (!name) return undefined;
  return name === "kiro-cli" || name === "kiro-cli-chat" ? "kiro" : name;
}

/** Whether two names are the same agent. */
export function sameAgent(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeAgentName(a);
  return left !== undefined && left === normalizeAgentName(b);
}

/** How an agent gets its ACP view: the ACP registry id of its adapter (`acp-session --agent`),
 *  and whether it shares its session with the view live (Codex, through its app-server) or hands
 *  it over (every other agent, `acp-session --tui`). */
export interface AcpViewAgent {
  agent: string;
  /** The executable its TUI runs as. */
  executable: string;
  registryId: string;
  live: boolean;
}

export const ACP_VIEW_AGENTS: readonly AcpViewAgent[] = [
  { agent: "codex", executable: "codex", registryId: "codex-acp", live: true },
  { agent: "claude", executable: "claude", registryId: "claude-acp", live: false },
  { agent: "opencode", executable: "opencode", registryId: "opencode", live: false },
  { agent: "pi", executable: "pi", registryId: "pi-acp", live: false },
  { agent: "copilot", executable: "copilot", registryId: "github-copilot-cli", live: false },
  { agent: "kiro", executable: "kiro-cli", registryId: "kiro", live: false },
];

/** The ACP view of an agent, by its name or executable; none for an agent without one. */
export function acpViewAgent(agentOrExecutable: string | undefined): AcpViewAgent | undefined {
  const name = normalizeAgentName(agentOrExecutable);
  return ACP_VIEW_AGENTS.find((entry) => entry.agent === name);
}

/** The ACP registry id a hand-off agent gives its session to the view with; none for Codex,
 *  which shares its session live, and for agents without a view. */
export function handOffAgentId(agentOrExecutable: string | undefined): string | undefined {
  const entry = acpViewAgent(agentOrExecutable);
  return entry && !entry.live ? entry.registryId : undefined;
}

/**
 * An agent's TUI command under the wrapper that serves its ACP view: Codex through
 * `codex-session`, which gives the pane its own app-server, and every other agent with a view
 * through `acp-session --tui`, which hands its session to the view and back. A command of no
 * agent with a view comes back as it is. `agentsArgv` runs this CLI.
 */
export function agentLaunchCommand(agentCommand: string, agentsArgv: string[]): string {
  const entry = acpViewAgent(commandWords(agentCommand)[0]);
  if (!entry || agentsArgv.length === 0) return agentCommand;
  return entry.live
    ? shellCommand([...agentsArgv, "codex-session", "--command", agentCommand])
    : shellCommand([...agentsArgv, "acp-session", "--agent", entry.registryId, "--tui", agentCommand]);
}
