import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { splitCommandArgv } from "./agent-restore.js";
import { spawnSync } from "child_process";
import { execFileInheritUntilExit, spawnBackgroundLogged, type ManagedBackgroundProcess } from "./shell.js";

export interface CodexSessionProcessPlan {
  executable: string;
  args: string[];
}

export interface CodexSessionLaunchPlan {
  endpointMetadataPath: string;
  logPath: string;
  server: CodexSessionProcessPlan;
  /** The TUI on this pane's app-server; --remote and its endpoint go first when it starts. */
  tui: CodexSessionProcessPlan;
  /**
   * The TUI on its own, for a pane whose app-server did not start. It gets --no-daemon where the
   * Codex has it, so it never runs on the shared daemon with another pane's environment.
   */
  plainTui: CodexSessionProcessPlan;
}

export interface CodexSessionLaunchInput {
  command: string;
  paneId: string;
  runtimeTempDir: string;
  processId: number;
  /** Whether this Codex has --no-daemon; asked of `codex --help` when it is not given. */
  supportsNoDaemon?: boolean;
}

export interface PaneLocalCodexSessionInput extends CodexSessionLaunchInput {
  environment: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export interface PaneLocalCodexSessionResult {
  status: number;
  signal: NodeJS.Signals | null;
  endpointMetadataRemoved: boolean;
  logPath: string;
  /** False when the app-server did not start and Codex ran without one. */
  appServer: boolean;
}

function socketStem(paneId: string): string {
  const normalized = paneId.trim().replace(/^%/, "pane-").replace(/[^A-Za-z0-9._-]/g, "-");
  return normalized || "pane-unknown";
}

export function createCodexSessionLaunchPlan(input: CodexSessionLaunchInput): CodexSessionLaunchPlan {
  const argv = splitCommandArgv(input.command);
  const executable = argv[0];
  if (basename(executable).toLowerCase() !== "codex") {
    throw new Error("Codex session command must start with the Codex executable");
  }

  const directory = join(input.runtimeTempDir, "codex-app-server");
  const stem = socketStem(input.paneId);
  const endpointMetadataPath = join(directory, `${stem}.json`);
  const logPath = join(directory, `${stem}-${input.processId}.log`);

  // This command picks how the TUI runs, so the configured command's own choice goes: Codex refuses
  // --no-daemon beside --remote, and a --remote inherited from another pane is that pane's server.
  const args = withoutCodexServerOptions(argv.slice(1));
  const supportsNoDaemon = input.supportsNoDaemon ?? codexSupportsNoDaemon(executable);

  return {
    endpointMetadataPath,
    logPath,
    server: {
      executable,
      args: ["app-server", "--listen", "ws://127.0.0.1:0"],
    },
    tui: { executable, args },
    plainTui: { executable, args: supportsNoDaemon ? ["--no-daemon", ...args] : args },
  };
}

const CODEX_SERVER_OPTIONS_WITH_VALUE = new Set(["--remote", "--remote-auth-token-env"]);

export function withoutCodexServerOptions(args: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      output.push(...args.slice(index));
      break;
    }
    if (arg === "--no-daemon") continue;
    if (CODEX_SERVER_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if ([...CODEX_SERVER_OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`))) continue;
    output.push(arg);
  }
  return output;
}

// A Codex from before the shared daemon has no --no-daemon and refuses it.
function codexSupportsNoDaemon(executable: string): boolean {
  const help = spawnSync(executable, ["--help"], { encoding: "utf8", timeout: 5_000 });
  return help.status === 0 && /--no-daemon\b/.test(help.stdout || "");
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readListeningEndpoint(logPath: string): string | undefined {
  try {
    const match = readFileSync(logPath, "utf8").match(/listening on:\s*(ws:\/\/127\.0\.0\.1:\d+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function writeEndpointMetadata(path: string, url: string, processId: number): void {
  const temporaryPath = `${path}.${processId}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ url, processId }));
  renameSync(temporaryPath, path);
}

function removeOwnedEndpointMetadata(path: string, processId: number): void {
  try {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as { processId?: unknown };
    if (metadata.processId === processId) rmSync(path, { force: true });
  } catch {
    // Preserve unreadable metadata in case another process replaced it.
  }
}

export function runPaneLocalCodexSession(input: PaneLocalCodexSessionInput): PaneLocalCodexSessionResult {
  const plan = createCodexSessionLaunchPlan(input);
  const startupTimeoutMs = input.startupTimeoutMs ?? 5_000;
  mkdirSync(dirname(plan.endpointMetadataPath), { recursive: true });
  rmSync(plan.endpointMetadataPath, { force: true });
  rmSync(plan.logPath, { force: true });

  const server = spawnBackgroundLogged(plan.server.executable, plan.server.args, {
    env: input.environment,
    logPath: plan.logPath,
  });

  let endpoint: string | undefined;
  try {
    endpoint = waitForListeningEndpoint(server, plan.logPath, startupTimeoutMs);
  } catch (error) {
    // The agent matters more than its web view: Codex starts without an app-server, as it would
    // have without this command, and only Codex Web is unavailable in this pane.
    server.terminate();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Codex Web is unavailable in this pane: ${message}. Starting Codex without it.`);
    const result = execFileInheritUntilExit(plan.plainTui.executable, plan.plainTui.args, input.environment);
    if (result.error) throw result.error;
    return {
      status: result.status,
      signal: result.signal,
      endpointMetadataRemoved: !existsSync(plan.endpointMetadataPath),
      logPath: plan.logPath,
      appServer: false,
    };
  }

  let tuiStatus = 1;
  let tuiSignal: NodeJS.Signals | null = null;
  try {
    writeEndpointMetadata(plan.endpointMetadataPath, endpoint, input.processId);

    const result = execFileInheritUntilExit(
      plan.tui.executable,
      ["--remote", endpoint, ...plan.tui.args],
      input.environment,
    );
    if (result.error) throw result.error;
    tuiStatus = result.status;
    tuiSignal = result.signal;
  } finally {
    server.terminate();
    removeOwnedEndpointMetadata(plan.endpointMetadataPath, input.processId);
  }
  return {
    status: tuiStatus,
    signal: tuiSignal,
    endpointMetadataRemoved: !existsSync(plan.endpointMetadataPath),
    logPath: plan.logPath,
    appServer: true,
  };
}

function waitForListeningEndpoint(
  server: ManagedBackgroundProcess,
  logPath: string,
  timeoutMs: number,
): string {
  const deadline = Date.now() + timeoutMs;
  let endpoint: string | undefined;
  while (!(endpoint = readListeningEndpoint(logPath))) {
    if (server.error) throw server.error;
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Codex app-server exited before its endpoint was ready. Log: ${logPath}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Codex app-server. Log: ${logPath}`);
    }
    sleepSync(25);
  }
  return endpoint;
}
