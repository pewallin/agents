import { execFileSync, spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "..", "extensions", "lib", "coordinator-reminder.sh");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

// A private tmux server: never the user's (whose $TMUX every command here would otherwise reach).
describe.skipIf(!hasTmux)("coordinator reminder after a compaction", () => {
  let root: string;
  let socket: string;
  let pane: string;
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf-8" }).trim();

  beforeAll(() => {
    root = mkdtempSync(join("/tmp", "agents-reminder-"));
    socket = join(root, "s");
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "t", "sh");
    pane = tmux("display-message", "-p", "-t", "t", "#{pane_id}");
  });
  afterAll(() => {
    spawnSync("tmux", ["-S", socket, "kill-server"]);
    rmSync(root, { recursive: true, force: true });
  });

  const run = () => spawnSync(SCRIPT, [], {
    encoding: "utf-8",
    env: { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane },
  });

  it("gives a coordinator its protocol back", () => {
    const program = join(root, "program");
    mkdirSync(join(program, "bin"), { recursive: true });
    const cli = join(program, "bin", "coordinator-abcdef12");
    writeFileSync(cli, `#!/bin/sh\necho '{"ok":true,"result":{"text":"You coordinate."}}'\n`);
    chmodSync(cli, 0o755);
    tmux("set-option", "-p", "-t", pane, "@agents_role", "coordinator");
    tmux("set-option", "-p", "-t", pane, "@agents_uuid", "abcdef12-3456");
    tmux("set-option", "-p", "-t", pane, "@agents_program", program);

    const output = JSON.parse(run().stdout);
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "You coordinate." } });
  });

  it("says nothing in any other pane", () => {
    tmux("set-option", "-p", "-t", pane, "@agents_role", "worker");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
