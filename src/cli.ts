#!/usr/bin/env node
import { Command } from "commander";
import React from "react";
import { render, Text, Box } from "ink";
import { execSync } from "child_process";
import { scan, switchBack } from "./scanner.js";
import { reportState } from "./state.js";
import { setup, uninstall, autoSetupIfNeeded } from "./setup.js";
import { createWorkspace } from "./workspace.js";
import { getProfileNames, resolveProfile } from "./config.js";
import { Dashboard } from "./components/Dashboard.js";
import { Select } from "./components/Select.js";
import { AgentTable } from "./components/AgentTable.js";

// If launched outside tmux for a command that needs it, re-exec inside a tmux session.
// Non-interactive commands (report, setup, uninstall, count) work fine without tmux.
if (!process.env.TMUX) {
  const args = process.argv.slice(2);
  const firstArg = args[0] || "";
  const needsTmux = !firstArg || firstArg === "watch" || firstArg === "w"
    || firstArg === "list" || firstArg === "ls"
    || firstArg === "workspace" || firstArg === "ws"
    || firstArg === "back";
  if (needsTmux) {
    try {
      execSync("which tmux", { stdio: "ignore" });
    } catch {
      console.error("tmux is required but not installed.");
      process.exit(1);
    }
    // Attach to existing 'agents' session or create a new one
    const fullCmd = [process.argv[0], process.argv[1], ...args].map(a => JSON.stringify(a)).join(" ");
    // Inline script that applies agents styling — used as a session-level
    // hook so it runs AFTER any global hooks (like user theme scripts).
    const styleScript = [
      `tmux set -t agents status-bg '#a3be8c'`,
      `tmux set -t agents status-fg '#2e3440'`,
      `tmux set -t agents pane-active-border-style 'fg=#a3be8c'`,
      `tmux set -t agents pane-border-style 'fg=#4c566a'`,
    ].join(" \\; ");
    const applyStyle = () => {
      try {
        execSync(`tmux rename-window -t agents: "agents"`, { stdio: "ignore" });
        // Apply immediately
        execSync(styleScript, { stdio: "ignore" });
        // Inherit user's border format settings
        try {
          const borderStatus = execSync(`tmux show -gv pane-border-status 2>/dev/null`, { encoding: "utf-8" }).trim();
          if (borderStatus) execSync(`tmux set -t agents pane-border-status '${borderStatus}'`, { stdio: "ignore" });
          const borderFormat = execSync(`tmux show -gv pane-border-format 2>/dev/null`, { encoding: "utf-8" }).trim();
          if (borderFormat) execSync(`tmux set -t agents pane-border-format '${borderFormat}'`, { stdio: "ignore" });
        } catch {}
        // Set session-level hooks so our style wins over global theme hooks.
        // Global hooks fire first, then session hooks override.
        for (const hook of ["client-attached", "after-new-session", "session-window-changed", "window-pane-changed"]) {
          execSync(`tmux set-hook -t agents ${hook} 'run-shell "${styleScript}"'`, { stdio: "ignore" });
        }
      } catch {}
    };
    try {
      execSync("tmux has-session -t agents 2>/dev/null");
      // Session exists — run the command in it
      if (!firstArg || firstArg === "watch" || firstArg === "w") {
        // Dashboard: attach to existing session
        execSync(`tmux attach-session -t agents`, { stdio: "inherit" });
      } else {
        // Other commands: run in the existing session
        execSync(`tmux send-keys -t agents ${JSON.stringify(fullCmd)} Enter`, { stdio: "inherit" });
        execSync(`tmux attach-session -t agents`, { stdio: "inherit" });
      }
    } catch {
      // Create new session running the command
      execSync(`tmux new-session -d -s agents -n agents ${fullCmd}`, { stdio: "ignore" });
      applyStyle();
      execSync(`tmux attach-session -t agents`, { stdio: "inherit" });
    }
    process.exit(0);
  }
}

// Auto-setup in background if hook config changed since last run
autoSetupIfNeeded();

const program = new Command();

program
  .name("agents")
  .description("Monitor AI agent panes across tmux sessions")
  .version("1.0.0");

program
  .command("list")
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
  .command("watch", { isDefault: true })
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
  .description("Create a new agent workspace in the current directory")
  .argument("[profile]", "Profile name (omit to list available profiles)")
  .argument("[overrides...]", "Override agent command (appended after profile command)")
  .option("-n, --name <name>", "Window name override")
  .option("-l, --layout <layout>", "Layout name (default, small, or custom)")
  .allowUnknownOption()
  .action((profile, overrides, opts) => {
    const profiles = getProfileNames();
    if (!profile) {
      console.log("Available profiles:");
      for (const name of profiles) {
        const p = resolveProfile(name);
        console.log(`  ${name}  ${p.command}`);
      }
      process.exit(0);
    }
    if (!profiles.includes(profile)) {
      console.error(`Unknown profile "${profile}". Available: ${profiles.join(", ")}`);
      process.exit(1);
    }
    const resolved = resolveProfile(profile);
    const cmd = overrides.length ? `${resolved.command} ${overrides.join(" ")}` : undefined;
    createWorkspace(cmd, opts.name, opts.layout, { profile, cwd: process.cwd() });
    // New pane shell startups trigger iTerm2/terminal DA queries whose responses
    // leak back to this pane's input buffer. Drain them before exiting.
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", () => {});
        setTimeout(() => process.exit(0), 300);
        return;
      } catch {}
    }
  });

program
  .command("setup")
  .description("Install agent hooks for Claude, Copilot, and Pi")
  .option("--quiet", "Suppress output (used by auto-setup)")
  .action((opts) => {
    const results = setup(opts.quiet);
    if (!opts.quiet) {
      for (const r of results) {
        const icon = r.action === "installed" ? "✓" : r.action === "already-installed" ? "•" : "–";
        const detail = r.detail ? ` (${r.detail})` : "";
        console.log(`  ${icon} ${r.agent}: ${r.action}${detail}`);
      }
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
