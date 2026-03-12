#!/usr/bin/env node
import { Command } from "commander";
import React from "react";
import { render, Text, Box } from "ink";
import { scan, switchBack } from "./scanner.js";
import { reportState } from "./state.js";
import { setup, uninstall } from "./setup.js";
import { createWorkspace } from "./workspace.js";
import { Dashboard } from "./components/Dashboard.js";
import { Select } from "./components/Select.js";
import { AgentTable } from "./components/AgentTable.js";

const program = new Command();

program
  .name("agents")
  .description("Monitor AI agent panes across tmux sessions")
  .version("1.0.0");

program
  .command("list", { isDefault: true })
  .alias("ls")
  .description("Show agent status with interactive selection")
  .option("--no-interactive", "Print status without interactive selection")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const agents = scan();
    if (opts.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }
    if (!opts.interactive || !process.stdin.isTTY) {
      const { unmount, waitUntilExit } = render(
        React.createElement(AgentTable, { agents })
      );
      waitUntilExit().then(() => process.exit(0));
      // Auto-unmount after render
      setTimeout(() => unmount(), 100);
    } else {
      const { waitUntilExit } = render(
        React.createElement(Select, { agents })
      );
      waitUntilExit().then(() => process.exit(0));
    }
  });

program
  .command("watch")
  .alias("w")
  .description("Live dashboard with auto-refresh")
  .argument("[seconds]", "Refresh interval", "2")
  .action((seconds) => {
    const interval = parseInt(seconds, 10) || 2;
    // Set tmux pane title
    process.stdout.write("\x1b]2;Agent Dashboard\x1b\\");
    // Clear screen for clean start (no alternate screen — conflicts with pane splits)
    process.stdout.write("\x1b[2J\x1b[H");
    const { waitUntilExit } = render(
      React.createElement(Dashboard, { interval }),
      { exitOnCtrlC: false }
    );
    waitUntilExit().then(() => {
      process.stdout.write("\x1b[2J\x1b[H");
      process.exit(0);
    });
  });

program
  .command("count")
  .alias("c")
  .description("Print number of running agents")
  .action(() => {
    console.log(scan().length);
  });

program
  .command("back")
  .description("Jump back to where you were before last agents jump")
  .action(() => {
    if (!switchBack()) {
      process.exit(1);
    }
  });

program
  .command("report")
  .description("Report agent state (called by agent hooks)")
  .requiredOption("--agent <name>", "Agent name (claude, copilot, pi)")
  .requiredOption("--state <state>", "State: working, idle, approval, question")
  .option("--session <id>", "Session ID (reads from stdin if not provided)")
  .action(async (opts) => {
    let session = opts.session;
    if (!session) {
      // Try reading session_id from stdin (hooks pipe JSON)
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        session = input.session_id || "default";
      } catch {
        session = "default";
      }
    }
    reportState(opts.agent, session, opts.state);
  });

program
  .command("workspace")
  .alias("ws")
  .description("Create a new workspace window with agent + helper panes")
  .argument("[command...]", "Agent command + args (defaults to config defaultCommand)")
  .option("-n, --name <name>", "Window name (defaults to command basename)")
  .option("-l, --layout <layout>", "Layout name (default, small, or custom)")
  .allowUnknownOption()
  .action((commandParts, opts) => {
    const cmd = commandParts.length ? commandParts.join(" ") : undefined;
    createWorkspace(cmd, opts.name, opts.layout);
  });

program
  .command("setup")
  .description("Install agent hooks for Claude, Copilot, and Pi")
  .action(() => {
    const results = setup();
    for (const r of results) {
      const icon = r.action === "installed" ? "✓" : r.action === "already-installed" ? "•" : "–";
      const detail = r.detail ? ` (${r.detail})` : "";
      console.log(`  ${icon} ${r.agent}: ${r.action}${detail}`);
    }
  });

program
  .command("uninstall")
  .description("Remove agent hooks installed by setup")
  .action(() => {
    const results = uninstall();
    for (const r of results) {
      const icon = r.action === "uninstalled" ? "✓" : "–";
      const detail = r.detail ? ` (${r.detail})` : "";
      console.log(`  ${icon} ${r.agent}: ${r.action}${detail}`);
    }
  });

program.parse();
