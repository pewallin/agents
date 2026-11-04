// The two hidden commands behind a Codex pane's ACP web view:
//   agents acp-host --pane %N --app-server ws://127.0.0.1:P [--cwd DIR]   the pane's host
//   agents codex-acp                                                     one ACP agent on stdio
// Both run before the rest of the CLI loads: the host stays up for the pane's lifetime, and
// codex-acp's stdout is its protocol channel, which nothing else may write to.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acpHostMetadataPath, startAcpHost } from "./acp-host.js";
import { getResourceRoot, getSelfArgv, isCompiledBinary } from "./paths.js";

export const ACP_HOST_COMMAND = "acp-host";
export const CODEX_ACP_COMMAND = "codex-acp";

export function acpViewRoot(): string {
  if (process.env.AGENTS_ACP_VIEW_ROOT) return process.env.AGENTS_ACP_VIEW_ROOT;
  const root = getResourceRoot();
  return isCompiledBinary() ? join(root, "acp-view") : join(root, "dist-web", "acp-view");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** The executable codex-acp starts as `<it> app-server`: this CLI, which then proxies to the
 *  pane's app-server. A CLI run by node needs a one-line wrapper to be one executable. */
function selfExecutable(runtimeTempDir: string): string {
  const argv = getSelfArgv();
  if (argv.length === 1) return argv[0];
  const directory = join(runtimeTempDir, "acp-host");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const wrapper = join(directory, `agents-${process.pid}.sh`);
  const quoted = argv.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${quoted} "$@"\n`);
  chmodSync(wrapper, 0o700);
  return wrapper;
}

export async function runAcpHostCommand(args: string[], runtimeTempDir: string): Promise<never> {
  const paneId = option(args, "--pane") ?? process.env.TMUX_PANE ?? "";
  const appServerUrl = option(args, "--app-server") ?? "";
  if (!paneId || !/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(appServerUrl)) {
    console.error("acp-host needs --pane and a loopback --app-server ws:// address");
    process.exit(2);
  }
  const webRoot = acpViewRoot();
  if (!existsSync(join(webRoot, "index.html"))) {
    console.error(`acp-host: no ACP web view at ${webRoot}`);
    process.exit(1);
  }
  const executable = selfExecutable(runtimeTempDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_PATH: executable,
    AGENTS_CODEX_APP_SERVER_URL: appServerUrl,
    // codex-acp's own logging goes to stderr only when asked; keep stdout clean regardless.
    AGENTS_NO_AUTO_SETUP: "1",
  };
  const self = getSelfArgv();
  const host = await startAcpHost({
    paneId,
    appServerUrl,
    runtimeTempDir,
    webRoot,
    cwd: option(args, "--cwd") ?? process.cwd(),
    agentCommand: { command: self[0], args: [...self.slice(1), CODEX_ACP_COMMAND], env },
    warmSpare: true,
    log: (message) => console.error(`${new Date().toISOString()} ${message}`),
  });
  console.error(`acp-host for ${paneId}: ${host.url} (metadata ${acpHostMetadataPath(runtimeTempDir, paneId)})`);
  const stop = async () => {
    await host.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  return await new Promise<never>(() => {});
}

/** codex-acp, bundled into this CLI: its module starts the agent on stdio when loaded. */
export async function runCodexAcpAgent(): Promise<never> {
  // codex-acp reads process.argv[2] for its own subcommands (login, cli); it gets none.
  process.argv = [process.argv[0], process.argv[1]];
  await import("@agentclientprotocol/codex-acp/dist/index.js");
  return await new Promise<never>(() => {});
}
