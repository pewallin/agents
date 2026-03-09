#!/usr/bin/env node
import { Command } from "commander";
import React from "react";
import { render, Text, Box } from "ink";
import { scan } from "./scanner.js";
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
  .action((opts) => {
    const agents = scan();
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
  .argument("[seconds]", "Refresh interval", "5")
  .action((seconds) => {
    const interval = parseInt(seconds, 10) || 5;
    const { waitUntilExit } = render(
      React.createElement(Dashboard, { interval }),
      { exitOnCtrlC: false }
    );
    waitUntilExit().then(() => process.exit(0));
  });

program
  .command("working")
  .alias("busy")
  .description("Show only agents currently working")
  .action(() => {
    const agents = scan().filter((a) => a.status === "working");
    const { unmount, waitUntilExit } = render(
      React.createElement(
        Box,
        { flexDirection: "column" },
        agents.length === 0
          ? React.createElement(
              Box,
              { paddingLeft: 2 },
              React.createElement(Text, { dimColor: true }, "No agents currently working")
            )
          : React.createElement(AgentTable, { agents })
      )
    );
    waitUntilExit().then(() => process.exit(0));
    setTimeout(() => unmount(), 100);
  });

program
  .command("count")
  .alias("c")
  .description("Print number of running agents")
  .action(() => {
    console.log(scan().length);
  });

program.parse();
