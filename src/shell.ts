/**
 * Shared shell execution wrapper used across the project.
 * All tmux and process commands go through this.
 */
import { execSync as nodeExecSync, exec as nodeExecCb, spawnSync } from "child_process";
import { promisify } from "util";

const nodeExecAsync = promisify(nodeExecCb);

const EXEC_TIMEOUT = 5000;

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
