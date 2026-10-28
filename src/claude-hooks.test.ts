import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude hook scripts", () => {
  it("preserves model labels with spaces in state hook reports", () => {
    const result = runClaudeHook("state-hook.sh", ["working"], {
      session_id: "claude-session-1",
      model_label: "Claude Opus 4.6",
      model_id: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(valueAfter(result.argv, "--state")).toBe("working");
    expect(valueAfter(result.argv, "--model-label")).toBe("Claude Opus 4.6");
    expect(valueAfter(result.argv, "--model-id")).toBe("claude-opus-4-6");
    expect(valueAfter(result.argv, "--provider")).toBe("anthropic");
    expect(result.argv).toContain("--clear-response-preview");
  });

  it("preserves model labels with spaces in stop hook reports", () => {
    const result = runClaudeHook("stop-hook.sh", [], {
      session_id: "claude-session-1",
      last_assistant_message: "All done.",
      model_label: "Claude Opus 4.6",
      model_id: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(valueAfter(result.argv, "--state")).toBe("idle");
    expect(valueAfter(result.argv, "--model-label")).toBe("Claude Opus 4.6");
    expect(valueAfter(result.argv, "--model-id")).toBe("claude-opus-4-6");
    expect(valueAfter(result.argv, "--provider")).toBe("anthropic");
    expect(valueAfter(result.argv, "--response-preview")).toBe("All done.");
  });

  it("hands steered messages to the turn as additionalContext, once, and says the pane's Claude takes them", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-claude-steer-test-"));
    temporaryDirectories.push(directory);
    const inbox = join(directory, "runtime", "tmp", "steer", "4242-pane-7");
    const scriptPath = fileURLToPath(new URL("../extensions/claude/steer-hook.sh", import.meta.url));
    const run = () => execFileSync("bash", [scriptPath], {
      input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
      env: { ...process.env, TMUX: "/tmp/sock,4242,0", TMUX_PANE: "%7", AGENTS_HOME: directory, AGENTS_TMP_DIR: "" },
      encoding: "utf8",
    });

    // No message: nothing on stdout, and the inbox says this Claude takes steered messages.
    expect(run()).toBe("");
    const harness = JSON.parse(readFileSync(join(inbox, "harness.json"), "utf8"));
    expect(harness.harness).toBe("claude");
    expect(Number.isInteger(harness.pid)).toBe(true);

    writeFileSync(join(inbox, "m-1.msg"), JSON.stringify({ id: "m-1", text: "From coordinator: use v2" }));
    writeFileSync(join(inbox, "m-2.msg"), JSON.stringify({ id: "m-2", text: "From coordinator: skip the docs" }));
    const output = JSON.parse(run());
    expect(output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(output.hookSpecificOutput.additionalContext).toContain("From coordinator: use v2");
    expect(output.hookSpecificOutput.additionalContext).toContain("From coordinator: skip the docs");
    expect(JSON.parse(readFileSync(join(inbox, "m-1.ack.json"), "utf8")).state).toBe("steered");
    expect(existsSync(join(inbox, "m-1.msg"))).toBe(false);
    expect(existsSync(join(inbox, "m-1.taken"))).toBe(true);

    // The next tool call finds nothing left to hand over.
    expect(run()).toBe("");
  });
});

function runClaudeHook(scriptName: "state-hook.sh" | "stop-hook.sh", args: string[], payload: unknown): { argv: string[] } {
  const directory = mkdtempSync(join(tmpdir(), "agents-claude-hook-test-"));
  temporaryDirectories.push(directory);

  const argvLog = join(directory, "argv.jsonl");
  // The hooks run the CLI that `agents setup` recorded (extensions/lib/agents-hook.sh).
  const shimPath = join(directory, "cli.mjs");
  writeFileSync(
    shimPath,
    [
      "import { appendFileSync } from 'fs';",
      "appendFileSync(process.env.AGENTS_HOOK_ARGV_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(directory, "hook-runtime.env"),
    `AGENTS_HOOK_NODE='${process.execPath}'\nAGENTS_HOOK_CLI='${shimPath}'\n`,
  );

  const scriptPath = fileURLToPath(new URL(`../extensions/claude/${scriptName}`, import.meta.url));
  execFileSync("bash", [scriptPath, ...args], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      TMUX_PANE: "%fixture",
      AGENTS_HOME: directory,
      AGENTS_HOOK_ARGV_LOG: argvLog,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = readFileSync(argvLog, "utf-8").trim().split("\n");
  return { argv: JSON.parse(lines.at(-1) ?? "[]") };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
