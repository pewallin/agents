// Keeps a pane's ACP view host running beside the agent it serves (`agents acp-host-supervise
// --parent <pid> -- <host command>`): a host that ends while its parent (codex-session) runs is
// started again, a moment later each time, and not at all after too many ends in a row. The
// host's own output and the reason for each restart go to the supervisor's log (its stdout).
//
// It ends with its parent, and on SIGTERM ends its host first.
import { spawn, type ChildProcess } from "node:child_process";

export interface SupervisorPolicy {
  /** Waits before the restarts in a row, in milliseconds; the last one repeats. */
  delays: number[];
  /** A host that ran this long counts as healthy: the next end starts the delays again. */
  healthyAfterMs: number;
  /** At most this many restarts within `windowMs`; then the supervisor gives up. */
  maxRestarts: number;
  windowMs: number;
}

export const DEFAULT_SUPERVISOR_POLICY: SupervisorPolicy = {
  delays: [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000],
  healthyAfterMs: 60_000,
  maxRestarts: 10,
  windowMs: 10 * 60_000,
};

/** What to do after a host ended: restart it after `delayMs`, or give up. */
export class RestartPlanner {
  private inRow = 0;
  private readonly restarts: number[] = [];

  constructor(private readonly policy: SupervisorPolicy = DEFAULT_SUPERVISOR_POLICY) {}

  next(ranForMs: number, now: number): { restart: true; delayMs: number } | { restart: false; reason: string } {
    if (ranForMs >= this.policy.healthyAfterMs) this.inRow = 0;
    while (this.restarts.length > 0 && now - this.restarts[0] > this.policy.windowMs) this.restarts.shift();
    if (this.restarts.length >= this.policy.maxRestarts) {
      return { restart: false, reason: `${this.restarts.length} restarts within ${Math.round(this.policy.windowMs / 60_000)} minutes` };
    }
    const delayMs = this.policy.delays[Math.min(this.inRow, this.policy.delays.length - 1)];
    this.inRow += 1;
    this.restarts.push(now);
    return { restart: true, delayMs };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function runHostSupervisor(
  args: string[],
  options: { stop?: AbortSignal; log?: (line: string) => void; policy?: SupervisorPolicy } = {},
): Promise<number> {
  const split = args.indexOf("--");
  const parentIndex = args.indexOf("--parent");
  const parent = parentIndex >= 0 ? Number(args[parentIndex + 1]) : process.ppid;
  const command = split >= 0 ? args.slice(split + 1) : [];
  const log = (message: string) => (options.log ?? ((line) => process.stdout.write(line)))(`${new Date().toISOString()} supervisor: ${message}\n`);
  if (command.length === 0 || !Number.isInteger(parent) || parent <= 1) {
    log("acp-host-supervise needs --parent <pid> -- <host command>");
    return 2;
  }
  const planner = new RestartPlanner(options.policy);
  let child: ChildProcess | undefined;
  let stopping = false;
  let wake: (() => void) | undefined;

  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`stopping (${why})`);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    wake?.();
  };
  if (options.stop) options.stop.addEventListener("abort", () => stop("asked to"));
  else for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop(signal));
  const watch = setInterval(() => { if (!alive(parent)) stop(`its parent ${parent} ended`); }, 2_000);

  try {
    for (;;) {
      const started = Date.now();
      child = spawn(command[0], command.slice(1), { stdio: ["ignore", "inherit", "inherit"] });
      const ended = await new Promise<string>((resolve) => {
        child!.once("error", (error) => resolve(`did not start: ${error.message}`));
        child!.once("exit", (code, signal) => resolve(signal ? `ended on ${signal}` : `exited with ${code}`));
      });
      if (stopping) return 0;
      const plan = planner.next(Date.now() - started, Date.now());
      if (!plan.restart) {
        log(`the host ${ended}; not restarting it after ${plan.reason}`);
        return 1;
      }
      log(`the host ${ended} after ${Math.round((Date.now() - started) / 1000)}s; restarting it in ${plan.delayMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, plan.delayMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
      if (stopping) return 0;
    }
  } finally {
    clearInterval(watch);
  }
}
