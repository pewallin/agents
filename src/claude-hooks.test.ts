import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
  });
});

function runClaudeHook(scriptName: "state-hook.sh" | "stop-hook.sh", args: string[], payload: unknown): { argv: string[] } {
  const directory = mkdtempSync(join(tmpdir(), "agents-claude-hook-test-"));
  temporaryDirectories.push(directory);

  const argvLog = join(directory, "argv.jsonl");
  const shimPath = join(directory, "agents");
  writeFileSync(
    shimPath,
    [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'fs';",
      "appendFileSync(process.env.AGENTS_HOOK_ARGV_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      "",
    ].join("\n"),
  );
  chmodSync(shimPath, 0o755);

  const scriptPath = fileURLToPath(new URL(`../extensions/claude/${scriptName}`, import.meta.url));
  execFileSync("bash", [scriptPath, ...args], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      TMUX_PANE: "%fixture",
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
