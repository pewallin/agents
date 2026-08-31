import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { splitCommandArgv } from "./agent-restore.js";
import { execFileInheritUntilExit, spawnBackgroundLogged } from "./shell.js";

export interface CodexSessionProcessPlan {
  executable: string;
  args: string[];
}

export interface CodexSessionLaunchPlan {
  endpointMetadataPath: string;
  logPath: string;
  server: CodexSessionProcessPlan;
  tui: CodexSessionProcessPlan;
}

export interface CodexSessionLaunchInput {
  command: string;
  paneId: string;
  runtimeTempDir: string;
  processId: number;
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

  return {
    endpointMetadataPath,
    logPath,
    server: {
      executable,
      args: ["app-server", "--listen", "ws://127.0.0.1:0"],
    },
    tui: {
      executable,
      args: argv.slice(1),
    },
  };
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

  let tuiStatus = 1;
  let tuiSignal: NodeJS.Signals | null = null;
  try {
    const deadline = Date.now() + startupTimeoutMs;
    let endpoint: string | undefined;
    while (!(endpoint = readListeningEndpoint(plan.logPath))) {
      if (server.error) throw server.error;
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`Codex app-server exited before its endpoint was ready. Log: ${plan.logPath}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Codex app-server. Log: ${plan.logPath}`);
      }
      sleepSync(25);
    }
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
  };
}
