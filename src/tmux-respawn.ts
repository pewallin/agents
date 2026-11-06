// Respawns a tmux pane without crashing tmux before 3.8. Those servers keep a control client's
// offsets into the pane's old output across a respawn: when a control client (Agents Next) is
// behind on the pane, often because the pane's window was out of the client's session for a while,
// the first read of the new process's output runs off the end of the new buffer and the server
// dies in input_parse (tmux issue 5499, fixed in 3.8; the mini's server, 2026-11-06).
//
// The way around it: each control client stops following the pane (`refresh-client -A %N:off`
// takes its offset up to the pane's own), the server then drops the old output the client held
// back (a pass of its loop, which the next command gives it), and the respawn and the clients'
// `%N:on` go in one command list, so the clients follow the new process from its first byte.
// It does nothing on a tmux that resets the offsets itself, so it is the same on every version.
import { execFileSync } from "node:child_process";

export type TmuxRun = (args: string[]) => string;

const defaultRun: TmuxRun = (args) => execFileSync("tmux", args, { encoding: "utf8", timeout: 5_000 });

/** The control-mode clients attached to the server. */
export function controlClients(run: TmuxRun = defaultRun): string[] {
  let output: string;
  try {
    // tmux prints a tab in a format as "_": the fields part at the space.
    output = run(["list-clients", "-F", "#{client_control_mode} #{client_name}"]);
  } catch {
    return [];
  }
  return output.split("\n")
    .map((line) => line.trim().split(" "))
    .filter(([control, name]) => control === "1" && name)
    .map(([, name]) => name);
}

/** The tmux invocations of a respawn of `paneId` with `respawnArgs` (what follows `respawn-pane`):
 *  each one a separate tmux run, in order. */
export function safeRespawnSteps(paneId: string, respawnArgs: string[], clients: string[]): string[][] {
  const respawn = ["respawn-pane", ...respawnArgs];
  if (clients.length === 0) return [respawn];
  const each = (state: "on" | "off") => clients.flatMap((client, index) => [
    ...(index === 0 ? [] : [";"]),
    "refresh-client", "-t", client, "-A", `${paneId}:${state}`,
  ]);
  return [
    each("off"),
    // A command of its own: the server passes its loop, which drops the output the clients held.
    ["display-message", "-p", "-t", paneId, "#{pane_pid}"],
    [...respawn, ";", ...each("on")],
  ];
}

/** `tmux respawn-pane <respawnArgs>` for `paneId`, safe on every tmux (see above). */
export function respawnPane(paneId: string, respawnArgs: string[], run: TmuxRun = defaultRun): void {
  const steps = safeRespawnSteps(paneId, respawnArgs, controlClients(run));
  const pid = () => { try { return run(["display-message", "-p", "-t", paneId, "#{pane_pid}"]).trim(); } catch { return ""; } };
  const before = steps.length > 1 ? pid() : "";
  for (const [index, step] of steps.entries()) {
    try {
      run(step);
    } catch (error) {
      // A client that left before its `on` fails the command list after the respawn ran.
      if (index === steps.length - 1 && steps.length > 1 && pid() !== before) return;
      throw error;
    }
  }
}
