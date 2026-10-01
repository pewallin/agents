import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const hookLibrary = fileURLToPath(new URL("../extensions/lib/agents-hook.sh", import.meta.url));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A home with a recorded runtime whose node is `recordedNode`, a CLI shim exiting with
 *  `cliExit`, and a working node on PATH. */
function fixture(recordedNode: "broken" | "missing" | "working", cliExit = 0) {
  const directory = mkdtempSync(join(tmpdir(), "agents-hook-runtime-test-"));
  temporaryDirectories.push(directory);
  const argvLog = join(directory, "argv.jsonl");
  const cli = join(directory, "cli.mjs");
  writeFileSync(cli, [
    "import { appendFileSync } from 'fs';",
    "appendFileSync(process.env.AGENTS_HOOK_ARGV_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
    `process.exit(${cliExit});`,
    "",
  ].join("\n"));
  // Like Homebrew's node with a missing library: it cannot start (dyld aborts with 134).
  const broken = join(directory, "broken-node");
  writeFileSync(broken, "#!/bin/sh\necho 'dyld: Library not loaded' >&2\nexit 134\n");
  chmodSync(broken, 0o755);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const node = { broken, missing: join(directory, "removed-nvm-version", "node"), working: process.execPath }[recordedNode];
  writeFileSync(join(directory, "hook-runtime.env"), `AGENTS_HOOK_NODE='${node}'\nAGENTS_HOOK_CLI='${cli}'\n`);

  const run = (...args: string[]) => execFileSync("/bin/bash", ["-c", '. "$1"; shift; agents_hook_run "$@"', "test", hookLibrary, "kiro", ...args], {
    env: { HOME: directory, PATH: `${bin}:/usr/bin:/bin`, AGENTS_HOME: directory, AGENTS_HOOK_ARGV_LOG: argvLog },
    encoding: "utf-8",
  });
  const reports = () => existsSync(argvLog) ? readFileSync(argvLog, "utf-8").trim().split("\n").filter(Boolean) : [];
  const log = () => { try { return readFileSync(join(directory, "logs", "hooks.log"), "utf-8"); } catch { return ""; } };
  return { run, reports, log };
}

describe("hook runtime", () => {
  it("falls back to another node when the recorded one cannot start, and logs it", () => {
    const { run, reports, log } = fixture("broken");
    expect(run("report", "--state", "working")).toBe("");
    expect(reports()).toEqual([JSON.stringify(["report", "--state", "working"])]);
    expect(log()).toMatch(/kiro exit=134 .*Library not loaded/);
  });

  it("falls back when the recorded node is gone (a removed nvm version)", () => {
    const { run, reports, log } = fixture("missing");
    run("report", "--state", "idle");
    expect(reports()).toHaveLength(1);
    expect(log()).toBe("");
  });

  it("logs a failed report without running it again", () => {
    const { run, reports, log } = fixture("working", 1);
    run("report", "--state", "idle");
    expect(reports()).toHaveLength(1);
    expect(log()).toMatch(/kiro exit=1 /);
  });
});
