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
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { acpHostMetadataPath, startAcpHost } from "./acp-host.js";
import { runHandoffSession } from "./acp-handoff.js";
import { getResourceRoot, getSelfArgv, getStateDir, isCompiledBinary } from "./paths.js";
import { reportState } from "./state.js";

/** What the view's clients see, reported as the pane's agent state: the app's "needs you" dot
 *  lights while a permission waits in the view, as it does for one in the terminal. */
export function reportViewActivity(stateAgent: string, paneId: string) {
  return (state: "needs-you" | "working" | "idle") => {
    try {
      reportState(stateAgent, paneId, state === "needs-you" ? "approval" : state, {});
    } catch {
      // The view works without the app's dot.
    }
  };
}

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
  /** Hand-off agents: the file the agent holds while a process has the session open. */
  sessionLock?(sessionId: string): string;
  /** The agent's own logs, whose last lines go into the view's diagnostics. */
  logFiles?(): string[];
  /** Hand-off agents that name a session before writing it: whether it has been written. A
   *  session never written has nothing to load, so the view starts one of its own. */
  sessionWritten?(sessionId: string): boolean;
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
/** The TUI's options that shape a session, and whether each takes a value. */
const COPILOT_SESSION_OPTIONS: Record<string, boolean> = {
  "--model": true, "--effort": true, "--reasoning-effort": true,
  "--allow-all-tools": false, "--allow-all-paths": false, "--allow-all": false, "--yolo": false,
  "--allow-tool": true, "--deny-tool": true, "--available-tools": true, "--excluded-tools": true,
  "--add-dir": true, "--sandbox": false, "--no-sandbox": false, "--experimental": false,
};

/**
 * `copilot --acp` with the options of the pane's TUI that shape its session (model, effort, tool
 * permissions, sandbox), so the session behaves in the view as it does in the terminal.
 */
export function copilotAcpArgs(tuiCommand: string | undefined): string[] {
  const words = tuiCommand?.trim().split(/\s+/).slice(1) ?? [];
  const carried: string[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const [name, inline] = word.split(/=(.*)/s, 2);
    if (!(name in COPILOT_SESSION_OPTIONS)) continue;
    if (!COPILOT_SESSION_OPTIONS[name] || inline !== undefined) {
      carried.push(word);
    } else if (index + 1 < words.length) {
      carried.push(word, words[++index]);
    }
  }
  return ["--acp", ...carried];
}

/**
 * `kiro-cli acp` with the engine the pane's TUI runs: a session is kept by the engine that made
 * it, and v2 (acp's default) answers "Session not found" for a v3 session. v3 asks the client for
 * an access token (`_kiro/auth/getAccessToken`) unless it uses the CLI's own login.
 */
export function kiroAcpArgs(tuiCommand: string | undefined): string[] {
  const words = tuiCommand?.trim().split(/\s+/) ?? [];
  const engineIndex = words.findIndex((word) => word === "--agent-engine");
  const inline = words.find((word) => word.startsWith("--agent-engine="))?.slice("--agent-engine=".length);
  const engine = inline ?? (engineIndex >= 0 ? words[engineIndex + 1] : undefined)
    ?? (words.includes("--v3") ? "v3" : words.includes("--v2") ? "v2" : words.includes("--v1") ? "v1" : undefined);
  if (!engine) return ["acp"];
  return engine === "v3" ? ["acp", "--agent-engine", "v3", "--auth-method", "cli"] : ["acp", "--agent-engine", engine];
}

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
    // Claude Code reports its session as it starts, and writes it with the first prompt:
    // ~/.claude/projects/<project>/<session>.jsonl.
    sessionWritten: (sessionId) => {
      const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
      try {
        return readdirSync(projects).some((project) => existsSync(join(projects, project, `${sessionId}.jsonl`)));
      } catch {
        return true;
      }
    },
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
    // Copilot 0.0.406 answers initialize without loadSession, so it cannot take a session over;
    // the view says so. Its changelog has ACP sessions resumed from 1.0.95.
    command: ({ tuiCommand }) => ({ command: executableOf(tuiCommand, "copilot"), args: copilotAcpArgs(tuiCommand), env: { ...process.env } }),
    resume: (tuiCommand, sessionId) =>
      resumeWith(tuiCommand, ["--resume"], ["--continue"], (id) => ["--resume", id])(sessionId),
  },
  kiro: {
    id: "kiro",
    name: "Kiro",
    stateAgent: "kiro",
    tested: false,
    command: ({ tuiCommand }) => ({ command: executableOf(tuiCommand, "kiro-cli"), args: kiroAcpArgs(tuiCommand), env: { ...process.env } }),
    resume: (tuiCommand, sessionId) =>
      resumeWith(tuiCommand, ["--resume-id"], ["--resume"], (id) => ["--resume-id", id])(sessionId),
    // Kiro keeps <session>.lock beside a session while a process has it open (its TUI or an ACP
    // agent), and logs to $TMPDIR/kiro-log/kiro-chat.log (kiro.dev/docs/cli/acp).
    sessionLock: (sessionId) => join(homedir(), ".kiro", "sessions", "cli", `${sessionId}.lock`),
    logFiles: () => [process.env.KIRO_CHAT_LOG_FILE || join(tmpdir(), "kiro-log", "kiro-chat.log")],
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

/** The pane option the app sets on an agent pane it opens in its ACP view (Settings > Agents >
 *  Open agents in): a hand-off agent then starts in the view, its TUI on the way back. */
export const OPEN_IN_OPTION = "@agents_open_in";

function opensInView(paneId: string): boolean {
  try {
    return execFileSync("tmux", ["show-options", "-p", "-v", "-t", paneId, OPEN_IN_OPTION], { encoding: "utf8", timeout: 3_000 }).trim() === "acp-view";
  } catch {
    return false;
  }
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
    const host = problem || !agentCommand ? undefined : { webRoot, agentCommand };
    return await runHandoffSession({
      agent,
      paneId,
      cwd,
      tuiCommand,
      runtimeTempDir,
      host,
      problem,
      startInView: host !== undefined && opensInView(paneId),
    });
  }

  if (problem || !agentCommand) {
    console.error(`acp-session: ${problem}`);
    process.exit(problem?.startsWith("no ACP web view") ? 1 : 2);
  }
  const appServerUrl = option(args, "--app-server");
  const host = await startAcpHost({
    currentSession: agent.id === "codex-acp" && appServerUrl
      ? async () => (await import("./codex-current-thread.js")).codexCurrentThread(appServerUrl)
      : undefined,
    startFirstTurn: agent.id === "codex-acp" && appServerUrl
      ? async (sessionId, text) => (await import("./codex-current-thread.js")).codexStartFirstTurn(appServerUrl, sessionId, text)
      : undefined,
    agentLogFiles: agent.logFiles?.(),
    agentStateFile: join(getStateDir(), `${agent.stateAgent}-${paneId}.json`),
    paneId,
    agent: { id: agent.id, name: agent.name },
    runtimeTempDir,
    webRoot,
    cwd,
    agentCommand,
    warmSpare: true,
    onActivity: reportViewActivity(agent.stateAgent, paneId),
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
