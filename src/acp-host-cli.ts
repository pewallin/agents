// The ACP web view of an agent pane, for any agent with an ACP adapter:
//   agents acp-session --agent <id> [--pane %N] [--app-server ws://…] [--cwd DIR]
// runs the pane's host (src/acp-host.ts): a loopback server that serves the prebuilt web client
// and gives each client its own adapter process. Agents are keyed by their ACP registry ids;
// each entry says how to start its adapter. `agents codex-session` starts one for Codex.
//
//   agents codex-acp     the Codex adapter, bundled into this CLI (an entry's command)
//
// Both run before the rest of the CLI loads: a session's host stays up for the pane's lifetime,
// and an adapter's stdout is its protocol channel, which nothing else may write to.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acpHostMetadataPath, startAcpHost } from "./acp-host.js";
import { getResourceRoot, getSelfArgv, isCompiledBinary } from "./paths.js";

export const ACP_SESSION_COMMAND = "acp-session";
export const CODEX_ACP_COMMAND = "codex-acp";

export interface AcpSessionOptions {
  /** The agent's own server for the pane, for an adapter that attaches to one (Codex). */
  appServerUrl?: string;
  runtimeTempDir: string;
}

export interface AcpAgentEntry {
  /** ACP registry id. */
  id: string;
  name: string;
  /** How to start one adapter process; throws when the session lacks what the agent needs. */
  command(options: AcpSessionOptions): { command: string; args: string[]; env: NodeJS.ProcessEnv };
}

/**
 * The agents a pane's ACP view can show. Adding one is an entry here: its adapter's command and
 * the environment it needs. Only Codex is wired up and bundled so far; the others (claude-acp,
 * github-copilot-cli, kiro, pi-acp, gemini, …) come as their adapters are added.
 */
export const ACP_AGENTS: Record<string, AcpAgentEntry> = {
  "codex-acp": {
    id: "codex-acp",
    name: "Codex",
    // codex-acp runs `$CODEX_PATH app-server`: with CODEX_PATH this CLI, that is the app-server
    // proxy to the pane's own app-server, so the view shares the pane's thread with its TUI.
    command({ appServerUrl, runtimeTempDir }) {
      if (!appServerUrl || !/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(appServerUrl)) {
        throw new Error("codex-acp needs the pane's app-server: --app-server ws://127.0.0.1:<port>");
      }
      const self = getSelfArgv();
      return {
        command: self[0],
        args: [...self.slice(1), CODEX_ACP_COMMAND],
        env: {
          ...process.env,
          CODEX_PATH: selfExecutable(runtimeTempDir),
          AGENTS_CODEX_APP_SERVER_URL: appServerUrl,
          AGENTS_NO_AUTO_SETUP: "1",
        },
      };
    },
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
  if (!agent || !paneId) {
    console.error(`acp-session needs --pane (or a tmux pane) and --agent, one of: ${Object.keys(ACP_AGENTS).join(", ")}`);
    process.exit(2);
  }
  const webRoot = acpViewRoot();
  if (!existsSync(join(webRoot, "index.html"))) {
    console.error(`acp-session: no ACP web view at ${webRoot}`);
    process.exit(1);
  }
  let agentCommand: ReturnType<AcpAgentEntry["command"]>;
  try {
    agentCommand = agent.command({ appServerUrl: option(args, "--app-server"), runtimeTempDir });
  } catch (error) {
    console.error(`acp-session: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const host = await startAcpHost({
    paneId,
    agent: { id: agent.id, name: agent.name },
    runtimeTempDir,
    webRoot,
    cwd: option(args, "--cwd") ?? process.cwd(),
    agentCommand,
    warmSpare: true,
    log: (message) => console.error(`${new Date().toISOString()} ${message}`),
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
