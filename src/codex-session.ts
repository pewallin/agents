import { existsSync, mkdirSync, rmSync } from "fs";
import { basename, dirname, join } from "path";
import { splitCommandArgv } from "./agent-restore.js";
import { execFileInheritUntilExit, spawnBackgroundLogged } from "./shell.js";

export interface CodexSessionProcessPlan {
  executable: string;
  args: string[];
}

export interface CodexSessionLaunchPlan {
  socketPath: string;
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
  socketRemoved: boolean;
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

  const socketPath = join(
    input.runtimeTempDir,
    "codex-app-server",
    `${socketStem(input.paneId)}-${input.processId}.sock`,
  );
  const remote = `unix://${socketPath}`;

  return {
    socketPath,
    server: {
      executable,
      args: ["app-server", "--listen", remote],
    },
    tui: {
      executable,
      args: ["--remote", remote, ...argv.slice(1)],
    },
  };
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function runPaneLocalCodexSession(input: PaneLocalCodexSessionInput): PaneLocalCodexSessionResult {
  const plan = createCodexSessionLaunchPlan(input);
  const logPath = plan.socketPath.replace(/\.sock$/, ".log");
  const startupTimeoutMs = input.startupTimeoutMs ?? 5_000;
  mkdirSync(dirname(plan.socketPath), { recursive: true });
  rmSync(plan.socketPath, { force: true });

  const server = spawnBackgroundLogged(plan.server.executable, plan.server.args, {
    env: input.environment,
    logPath,
  });

  let tuiStatus = 1;
  let tuiSignal: NodeJS.Signals | null = null;
  try {
    const deadline = Date.now() + startupTimeoutMs;
    while (!existsSync(plan.socketPath)) {
      if (server.error) throw server.error;
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`Codex app-server exited before its socket was ready. Log: ${logPath}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Codex app-server. Log: ${logPath}`);
      }
      sleepSync(25);
    }

    const result = execFileInheritUntilExit(plan.tui.executable, plan.tui.args, input.environment);
    if (result.error) throw result.error;
    tuiStatus = result.status;
    tuiSignal = result.signal;
  } finally {
    server.terminate();
    rmSync(plan.socketPath, { force: true });
  }
  return {
    status: tuiStatus,
    signal: tuiSignal,
    socketRemoved: !existsSync(plan.socketPath),
    logPath,
  };
}
