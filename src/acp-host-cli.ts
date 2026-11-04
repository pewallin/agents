// The ACP web view of an agent pane, for any agent with an ACP adapter:
//   agents acp-session --agent <id> [--pane %N] [--cwd DIR] --app-server ws://…   live (Codex)
//   agents acp-session --agent <id> [--pane %N] [--cwd DIR] --tui '<command>'      hand-off
// runs the pane's host (src/acp-host.ts): a loopback server that serves the prebuilt web client
// and gives each client its own adapter process. Agents are keyed by their ACP registry ids; each
// entry says how to start its adapter and, for an agent that cannot share its session with its
// TUI, how the TUI resumes a session. With --tui the command runs the agent's TUI in the pane and
// hands the session to the view and back (src/acp-handoff.ts). `agents codex-session` starts the
// live host for Codex.
//
//   agents codex-acp     the Codex adapter, bundled into this CLI (an entry's command)
//   agents claude-acp    the Claude adapter, bundled likewise
//
// They run before the rest of the CLI loads: a session's host stays up for the pane's lifetime,
// and an adapter's stdout is its protocol channel, which nothing else may write to.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { acpHostMetadataPath, startAcpHost } from "./acp-host.js";
import { runHandoffSession } from "./acp-handoff.js";
import { getResourceRoot, getSelfArgv, isCompiledBinary } from "./paths.js";

export const ACP_SESSION_COMMAND = "acp-session";
export const CODEX_ACP_COMMAND = "codex-acp";
export const CLAUDE_ACP_COMMAND = "claude-acp";

export interface AcpSessionOptions {
  /** The agent's own server for the pane, for an adapter that attaches to one (Codex). */
  appServerUrl?: string;
  /** The pane's TUI command, for a hand-off agent: its executable is the one the adapter uses. */
  tuiCommand?: string;
  runtimeTempDir: string;
}

export interface AcpAgentEntry {
  /** ACP registry id. */
  id: string;
  name: string;
  /** The agent name its status hooks report under (state/<agent>-<pane>.json). */
  stateAgent: string;
  /** Whether it is tried on this Mac; an untested entry is there to be completed. */
  tested: boolean;
  /** How to start one adapter process; throws when the session lacks what the agent needs. */
  command(options: AcpSessionOptions): { command: string; args: string[]; env: NodeJS.ProcessEnv };
  /**
   * Hand-off agents: the TUI command that goes on with a session, from the pane's own command
   * (its options stay, a resume it carried is replaced). Absent for a live agent (Codex).
   */
  resume?(tuiCommand: string, sessionId: string): string;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command's words without the options that pick a session, then the agent's own. */
function resumeWith(
  tuiCommand: string,
  dropWithValue: string[],
  dropFlags: string[],
  add: (sessionId: string) => string[],
): (sessionId: string) => string {
  const words = tuiCommand.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (dropFlags.includes(word)) continue;
    if (dropWithValue.includes(word)) {
      if (words[index + 1] && !words[index + 1].startsWith("-")) index += 1;
      continue;
    }
    if (dropWithValue.some((option) => word.startsWith(`${option}=`))) continue;
    kept.push(word);
  }
  return (sessionId) => [...kept, ...add(sessionId).map(shellQuote)].join(" ");
}

/** The executable of the pane's command when it is the agent's, else the agent's name on PATH. */
function executableOf(tuiCommand: string | undefined, name: string): string {
  const first = tuiCommand?.trim().split(/\s+/)[0];
  return first && first.split("/").pop() === name ? first : name;
}

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    if (directory && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function bundledAdapter(subcommand: string, env: NodeJS.ProcessEnv): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const self = getSelfArgv();
  return { command: self[0], args: [...self.slice(1), subcommand], env: { ...process.env, ...env, AGENTS_NO_AUTO_SETUP: "1" } };
}

/**
 * The agents a pane's ACP view can show. Adding one is an entry here: its adapter's command, the
 * environment it needs and how its TUI resumes a session. Codex shares its session live through
 * the pane's app-server; the others hand it over. Untested entries follow the agents' documented
 * commands and wait for an install to try them on.
 */
export const ACP_AGENTS: Record<string, AcpAgentEntry> = {
  "codex-acp": {
    id: "codex-acp",
    name: "Codex",
    stateAgent: "codex",
    tested: true,
    // codex-acp runs `$CODEX_PATH app-server`: with CODEX_PATH this CLI, that is the app-server
    // proxy to the pane's own app-server, so the view shares the pane's thread with its TUI.
    command({ appServerUrl, runtimeTempDir }) {
      if (!appServerUrl || !/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(appServerUrl)) {
        throw new Error("codex-acp needs the pane's app-server: --app-server ws://127.0.0.1:<port>");
      }
      return bundledAdapter(CODEX_ACP_COMMAND, {
        CODEX_PATH: selfExecutable(runtimeTempDir),
        AGENTS_CODEX_APP_SERVER_URL: appServerUrl,
      });
    },
  },
  "claude-acp": {
    id: "claude-acp",
    name: "Claude",
    stateAgent: "claude",
    tested: false,
    // The adapter drives the user's own Claude Code, so it has the same login and settings.
    command({ tuiCommand }) {
      const claude = executableOf(tuiCommand, "claude");
      const resolved = claude.includes("/") ? claude : findOnPath(claude);
      if (!resolved) throw new Error("claude-acp needs Claude Code installed (`claude` on PATH)");
      return bundledAdapter(CLAUDE_ACP_COMMAND, { CLAUDE_CODE_EXECUTABLE: resolved });
    },
    resume: (tuiCommand, sessionId) =>
      resumeWith(tuiCommand, ["--resume", "-r", "--session-id"], ["--continue", "-c"], (id) => ["--resume", id])(sessionId),
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    stateAgent: "opencode",
    tested: true,
    command: ({ tuiCommand }) => ({ command: executableOf(tuiCommand, "opencode"), args: ["acp"], env: { ...process.env } }),
    resume: (tuiCommand, sessionId) =>
      resumeWith(tuiCommand, ["--session", "-s"], ["--continue", "-c", "--fork"], (id) => ["--session", id])(sessionId),
  },
  "pi-acp": {
    id: "pi-acp",
    name: "Pi",
    stateAgent: "pi",
    tested: false,
    // pi-acp drives the `pi` on PATH. It is not bundled yet: an installed pi-acp, else npx.
    command: () => {
      const installed = findOnPath("pi-acp");
      return installed
        ? { command: installed, args: [], env: { ...process.env } }
        : { command: "npx", args: ["-y", "pi-acp@0.0.34"], env: { ...process.env } };
    },
    resume: (tuiCommand, sessionId) =>
      resumeWith(tuiCommand, ["--session", "--session-id", "--fork"], ["--continue", "-c", "--resume", "-r"], (id) => ["--session", id])(sessionId),
  },
  "github-copilot-cli": {
    id: "github-copilot-cli",
    name: "Copilot",
    stateAgent: "copilot",
    tested: false,
    // Copilot 0.0.406 answers initialize without loadSession, so it cannot take a session over
    // yet; a later Copilot that loads sessions works with this entry as it is.
    command: ({ tuiCommand }) => ({ command: executableOf(tuiCommand, "copilot"), args: ["--acp"], env: { ...process.env } }),
    resume: (tuiCommand, sessionId) =>
      resumeWith(tuiCommand, ["--resume"], ["--continue"], (id) => ["--resume", id])(sessionId),
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    stateAgent: "gemini",
    tested: false,
    command: ({ tuiCommand }) => ({ command: executableOf(tuiCommand, "gemini"), args: ["--experimental-acp"], env: { ...process.env } }),
    resume: (tuiCommand, sessionId) =>
      resumeWith(tuiCommand, ["--resume", "-r"], [], (id) => ["--resume", id])(sessionId),
  },
  kiro: {
    id: "kiro",
    name: "Kiro",
    stateAgent: "kiro",
    tested: false,
    command: ({ tuiCommand }) => ({ command: executableOf(tuiCommand, "kiro-cli"), args: ["acp"], env: { ...process.env } }),
    resume: (tuiCommand, sessionId) =>
      resumeWith(tuiCommand, ["--resume-id"], ["--resume"], (id) => ["--resume-id", id])(sessionId),
  },
};

export function acpViewRoot(): string {
  if (process.env.AGENTS_ACP_VIEW_ROOT) return process.env.AGENTS_ACP_VIEW_ROOT;
  const root = getResourceRoot();
  return isCompiledBinary() ? join(root, "acp-view") : join(root, "dist-web", "acp-view");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** This CLI as one executable. A CLI run by node needs a one-line wrapper for that. */
function selfExecutable(runtimeTempDir: string): string {
  const argv = getSelfArgv();
  if (argv.length === 1) return argv[0];
  const directory = join(runtimeTempDir, "acp-session");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const wrapper = join(directory, `agents-${process.pid}.sh`);
  const quoted = argv.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${quoted} "$@"\n`);
  chmodSync(wrapper, 0o700);
  return wrapper;
}

export async function runAcpSessionCommand(args: string[], runtimeTempDir: string): Promise<never> {
  const agentId = option(args, "--agent") ?? "";
  const agent = ACP_AGENTS[agentId];
  const paneId = option(args, "--pane") ?? process.env.TMUX_PANE ?? "";
  const tuiCommand = option(args, "--tui");
  if (!agent || !paneId) {
    console.error(`acp-session needs --pane (or a tmux pane) and --agent, one of: ${Object.keys(ACP_AGENTS).join(", ")}`);
    process.exit(2);
  }
  if (tuiCommand && !agent.resume) {
    console.error(`acp-session: ${agent.name} shares its session live; it takes no --tui`);
    process.exit(2);
  }
  if (!tuiCommand && agent.resume) {
    console.error(`acp-session: ${agent.name} hands its session over; give its TUI command with --tui`);
    process.exit(2);
  }
  const webRoot = acpViewRoot();
  const cwd = option(args, "--cwd") ?? process.cwd();
  const log = (message: string) => { if (!tuiCommand) console.error(`${new Date().toISOString()} ${message}`); };
  let agentCommand: ReturnType<AcpAgentEntry["command"]> | undefined;
  let problem: string | undefined;
  if (!existsSync(join(webRoot, "index.html"))) problem = `no ACP web view at ${webRoot}`;
  try {
    agentCommand = agent.command({ appServerUrl: option(args, "--app-server"), tuiCommand, runtimeTempDir });
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }

  if (tuiCommand) {
    // The TUI runs whatever happens to the view: a host that cannot start only costs the view.
    return await runHandoffSession({
      agent,
      paneId,
      cwd,
      tuiCommand,
      runtimeTempDir,
      host: problem || !agentCommand ? undefined : { webRoot, agentCommand },
      problem,
    });
  }

  if (problem || !agentCommand) {
    console.error(`acp-session: ${problem}`);
    process.exit(problem?.startsWith("no ACP web view") ? 1 : 2);
  }
  const host = await startAcpHost({
    paneId,
    agent: { id: agent.id, name: agent.name },
    runtimeTempDir,
    webRoot,
    cwd,
    agentCommand,
    warmSpare: true,
    log,
  });
  console.error(`acp-session ${agent.id} for ${paneId}: ${host.url} (metadata ${acpHostMetadataPath(runtimeTempDir, paneId)})`);
  const stop = async () => {
    await host.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  return await new Promise<never>(() => {});
}

/** codex-acp, bundled into this CLI: its module starts the adapter on stdio when loaded. */
export async function runCodexAcpAgent(): Promise<never> {
  // codex-acp reads process.argv[2] for its own subcommands (login, cli); it gets none.
  process.argv = [process.argv[0], process.argv[1]];
  await import("@agentclientprotocol/codex-acp/dist/index.js");
  return await new Promise<never>(() => {});
}

/** claude-agent-acp, bundled likewise; CLAUDE_CODE_EXECUTABLE names the Claude Code it drives. */
export async function runClaudeAcpAgent(): Promise<never> {
  process.argv = [process.argv[0], process.argv[1]];
  await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
  return await new Promise<never>(() => {});
}
