/**
 * Shared shell execution wrapper used across the project.
 * All tmux and process commands go through this.
 */
import { execSync as nodeExecSync, exec as nodeExecCb, spawn, spawnSync } from "child_process";
import { closeSync, openSync } from "fs";
import { promisify } from "util";

const nodeExecAsync = promisify(nodeExecCb);

const EXEC_TIMEOUT = 5000;

export interface ExecFileCaptureOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface ExecFileCaptureResult {
  status: number;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface ManagedBackgroundProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly error: Error | undefined;
  terminate(): void;
}

export interface SpawnBackgroundOptions {
  env?: NodeJS.ProcessEnv;
  logPath: string;
}

/** Synchronous exec — returns stdout trimmed, or "" on error. */
export function exec(cmd: string): string {
  try {
    return nodeExecSync(cmd, { encoding: "utf-8", timeout: EXEC_TIMEOUT, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/** Execute a command with inherited stdio (TTY passthrough).
 *  Required for zellij commands that need terminal access (e.g. float/embed).
 *  Returns the exit code (0 = success). */
export function execInherit(cmd: string, args: string[]): number {
  try {
    const r = spawnSync(cmd, args, { timeout: EXEC_TIMEOUT, stdio: "inherit" });
    return r.status ?? 1;
  } catch {
    return 1;
  }
}

/** Execute an interactive binary until it exits, preserving the caller's TTY. */
export function execFileInheritUntilExit(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): ExecFileCaptureResult {
  const result = spawnSync(cmd, args, {
    env,
    stdio: "inherit",
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: "",
    stderr: "",
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Start a long-running child whose output is appended to a dedicated log file. */
export function spawnBackgroundLogged(
  cmd: string,
  args: string[],
  options: SpawnBackgroundOptions,
): ManagedBackgroundProcess {
  const logFile = openSync(options.logPath, "a");
  const child = spawn(cmd, args, {
    env: options.env,
    stdio: ["ignore", logFile, logFile],
  });
  let spawnError: Error | undefined;
  let logClosed = false;
  const closeLog = () => {
    if (logClosed) return;
    logClosed = true;
    try { closeSync(logFile); } catch {}
  };
  child.once("error", (error) => {
    spawnError = error;
    closeLog();
  });
  child.once("close", closeLog);

  return {
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    get error() { return spawnError; },
    terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

/** Execute a binary with captured stdio and without invoking a local shell. */
export function execFileCapture(cmd: string, args: string[], opts: ExecFileCaptureOptions = {}): ExecFileCaptureResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf-8",
    timeout: opts.timeout ?? EXEC_TIMEOUT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    signal: result.signal,
    ...(result.error ? { error: result.error } : {}),
  };
}

/** Async exec — returns stdout trimmed, or "" on error.
 *  If the command produces output but exits with a signal (e.g. zellij pipe),
 *  returns the captured stdout rather than discarding it. */
export async function execAsync(cmd: string): Promise<string> {
  try {
    const { stdout } = await nodeExecAsync(cmd, { encoding: "utf-8", timeout: EXEC_TIMEOUT });
    return stdout.trim();
  } catch (e: any) {
    if (e?.stdout) return (e.stdout as string).trim();
    return "";
  }
}
