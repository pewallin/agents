import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { createCodexSessionLaunchPlan, runPaneLocalCodexSession } from "./codex-session.js";

describe("createCodexSessionLaunchPlan", () => {
  it("routes the Codex TUI through a pane-local app server", () => {
    const plan = createCodexSessionLaunchPlan({
      command: "codex --dangerously-bypass-approvals-and-sandbox resume 'thread-123'",
      paneId: "%346",
      runtimeTempDir: "/tmp/agents-runtime",
      processId: 4242,
    });

    expect(plan.endpointMetadataPath).toBe("/tmp/agents-runtime/codex-app-server/pane-346.json");
    expect(plan.logPath).toBe("/tmp/agents-runtime/codex-app-server/pane-346-4242.log");
    expect(plan.server).toEqual({
      executable: "codex",
      args: [
        "app-server",
        "--listen",
        "ws://127.0.0.1:0",
      ],
    });
    expect(plan.tui).toEqual({
      executable: "codex",
      args: [
        "--dangerously-bypass-approvals-and-sandbox",
        "resume",
        "thread-123",
      ],
    });
  });

  it("drops --no-daemon, which Codex refuses beside the --remote it adds", () => {
    const plan = createCodexSessionLaunchPlan({
      command: "codex --no-daemon -m gpt-6-astra 'ROLE: worker.'",
      paneId: "%25",
      runtimeTempDir: "/tmp/agents-runtime",
      processId: 4242,
    });

    expect(plan.tui.args).toEqual(["-m", "gpt-6-astra", "ROLE: worker."]);
  });

  it("keeps the pane identity in the app-server environment and cleans up", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-codex-session-"));
    const runtimeDirectory = `/private/tmp/agents-codex-runtime-${process.pid}`;
    const executable = join(directory, "codex");
    const outputPath = join(directory, "tui.json");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "app-server") {
  process.stderr.write("  listening on: ws://127.0.0.1:43123\\n");
  const timer = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
} else {
  fs.writeFileSync(process.env.CODEX_SESSION_TEST_OUTPUT, JSON.stringify({
    args,
    paneId: process.env.TMUX_PANE,
    endpoint: JSON.parse(fs.readFileSync(process.env.CODEX_SESSION_TEST_METADATA_PATH, "utf8")),
  }));
}
`);
    chmodSync(executable, 0o755);

    try {
      const result = runPaneLocalCodexSession({
        command: `${executable} --model gpt-test`,
        paneId: "%55",
        runtimeTempDir: runtimeDirectory,
        processId: 101,
        environment: {
          ...process.env,
          TMUX_PANE: "%55",
          CODEX_SESSION_TEST_OUTPUT: outputPath,
          CODEX_SESSION_TEST_METADATA_PATH: join(runtimeDirectory, "codex-app-server", "pane-55.json"),
        },
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
        args: [
          "--remote",
          "ws://127.0.0.1:43123",
          "--model",
          "gpt-test",
        ],
        paneId: "%55",
        endpoint: {
          url: "ws://127.0.0.1:43123",
          processId: 101,
        },
      });
      expect(result.endpointMetadataRemoved).toBe(true);
    } catch (error) {
      const logPath = join(runtimeDirectory, "codex-app-server", "pane-55-101.log");
      const log = readFileSync(logPath, "utf8");
      throw new Error(`${String(error)}\n${log}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  });

  it("starts Codex without an app-server when the app-server does not start, so the agent still runs", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-codex-session-"));
    const runtimeDirectory = `/private/tmp/agents-codex-runtime-fallback-${process.pid}`;
    const executable = join(directory, "codex");
    const outputPath = join(directory, "tui.json");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "app-server") {
  process.stderr.write("error: address in use\\n");
  process.exit(1);
} else {
  fs.writeFileSync(process.env.CODEX_SESSION_TEST_OUTPUT, JSON.stringify({ args }));
  process.exit(7);
}
`);
    chmodSync(executable, 0o755);

    try {
      const result = runPaneLocalCodexSession({
        command: `${executable} --no-daemon -m gpt-test 'ROLE: worker.'`,
        paneId: "%56",
        runtimeTempDir: runtimeDirectory,
        processId: 102,
        startupTimeoutMs: 500,
        environment: { ...process.env, TMUX_PANE: "%56", CODEX_SESSION_TEST_OUTPUT: outputPath },
      });

      // The configured command as it was, --no-daemon included, and its own exit status.
      expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({
        args: ["--no-daemon", "-m", "gpt-test", "ROLE: worker."],
      });
      expect(result.status).toBe(7);
      expect(result.appServer).toBe(false);
      expect(result.endpointMetadataRemoved).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  });

  it("removes the endpoint when Codex exits, so no one connects to an app-server that is gone", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-codex-session-"));
    const runtimeDirectory = `/private/tmp/agents-codex-runtime-exit-${process.pid}`;
    const executable = join(directory, "codex");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "app-server") {
  process.stderr.write("  listening on: ws://127.0.0.1:43124\\n");
  const timer = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
} else {
  process.exit(3);
}
`);
    chmodSync(executable, 0o755);

    try {
      const result = runPaneLocalCodexSession({
        command: `${executable}`,
        paneId: "%57",
        runtimeTempDir: runtimeDirectory,
        processId: 103,
        environment: { ...process.env, TMUX_PANE: "%57" },
      });

      expect(result.status).toBe(3);
      expect(result.appServer).toBe(true);
      expect(result.endpointMetadataRemoved).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  });
});
