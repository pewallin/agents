/**
 * Shared shell execution wrapper used across the project.
 * All tmux and process commands go through this.
 */
import { execSync as nodeExecSync, exec as nodeExecCb } from "child_process";
import { promisify } from "util";

const nodeExecAsync = promisify(nodeExecCb);

const EXEC_TIMEOUT = 5000;

/** Synchronous exec — returns stdout trimmed, or "" on error. */
export function exec(cmd: string): string {
  try {
    return nodeExecSync(cmd, { encoding: "utf-8", timeout: EXEC_TIMEOUT }).trim();
  } catch {
    return "";
  }
}

/** Async exec — returns stdout trimmed, or "" on error. */
export async function execAsync(cmd: string): Promise<string> {
  try {
    const { stdout } = await nodeExecAsync(cmd, { encoding: "utf-8", timeout: EXEC_TIMEOUT });
    return stdout.trim();
  } catch {
    return "";
  }
}
