import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { controlClients, respawnPane, safeRespawnSteps } from "./tmux-respawn.js";

describe("respawning a pane", () => {
  it("takes each control client off the pane, lets the server pass its loop, and respawns with the clients back on", () => {
    expect(safeRespawnSteps("%4", ["-k", "-t", "%4", "cmd"], [])).toEqual([["respawn-pane", "-k", "-t", "%4", "cmd"]]);
    expect(safeRespawnSteps("%4", ["-k", "-t", "%4", "cmd"], ["client-1", "client-2"])).toEqual([
      ["refresh-client", "-t", "client-1", "-A", "%4:off", ";", "refresh-client", "-t", "client-2", "-A", "%4:off"],
      ["display-message", "-p", "-t", "%4", "#{pane_pid}"],
      ["respawn-pane", "-k", "-t", "%4", "cmd", ";", "refresh-client", "-t", "client-1", "-A", "%4:on", ";", "refresh-client", "-t", "client-2", "-A", "%4:on"],
    ]);
    expect(controlClients(() => "1 client-9\n0 /dev/ttys003\n")).toEqual(["client-9"]);
    expect(controlClients(() => { throw new Error("no server"); })).toEqual([]);
  });

  it("counts a respawn that ran as done when a client left before its turn back on", () => {
    let pid = "100";
    const calls: string[] = [];
    respawnPane("%4", ["-k", "-t", "%4", "cmd"], (args) => {
      calls.push(args[0]);
      if (args[0] === "list-clients") return "1 client-1\n";
      if (args[0] === "display-message") return `${pid}\n`;
      if (args[0] === "respawn-pane") { pid = "200"; throw new Error("can't find client: client-1"); }
      return "";
    });
    expect(calls).toEqual(["list-clients", "display-message", "refresh-client", "display-message", "respawn-pane", "display-message"]);
  });

  // tmux before 3.8 died in input_parse on the first read after a respawn when a control client was
  // behind on the pane (tmux issue 5499): here the pane's window leaves the client's session and
  // comes back, which leaves the client's offset behind, and the respawned process writes little.
  it.skipIf(spawnSync("tmux", ["-V"]).status !== 0)("keeps a real tmux server running through a respawn with a control client behind", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tmux-respawn-"));
    const socket = join(directory, "s");
    const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined };
    const run = (args: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8", env });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let client: ChildProcess | undefined;
    try {
      run(["new-session", "-d", "-s", "rt", "-x", "80", "-y", "24", "sleep 600"]);
      const server = Number(run(["display-message", "-p", "#{pid}"]).trim());
      run(["set-option", "-g", "remain-on-exit", "on"]);
      const output = join(directory, "control.out");
      client = spawn("sh", ["-c", `sleep 30 | tmux -S '${socket}' -f /dev/null -C attach -t rt > '${output}' 2>&1`], { env, stdio: "ignore" });
      await sleep(800);
      run(["new-window", "-d", "-t", "rt", "sh -c 'i=0; while [ $i -lt 300 ]; do echo yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy; sleep 0.003; i=$((i+1)); done; sleep 600'"]);
      await sleep(300);
      run(["new-session", "-d", "-s", "other"]);
      run(["move-window", "-d", "-s", "rt:1", "-t", "other:"]);
      await sleep(2_500);
      run(["move-window", "-d", "-s", "other:1", "-t", "rt:"]);
      await sleep(400);
      const pane = run(["display-message", "-p", "-t", "rt:1", "#{pane_id}"]).trim();
      respawnPane(pane, ["-k", "-t", pane, "echo respawned-here; sleep 60"], run);
      await sleep(1_500);
      expect(() => process.kill(server, 0)).not.toThrow();
      expect(run(["has-session", "-t", "rt"])).toBe("");
      // The client follows the new process from its first output.
      expect(readFileSync(output, "utf8")).toContain("respawned-here");
    } finally {
      client?.kill();
      try { run(["kill-server"]); } catch { /* gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
