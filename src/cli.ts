#!/usr/bin/env node
import { execSync } from "child_process";
import { switchBack } from "./back.js";
import { setMultiplexer, detectMultiplexer, initMux } from "./multiplexer.js";

// Handle --tmux flag early (before commander parses, since it's global)
if (process.argv.includes("--tmux")) {
  setMultiplexer("tmux");
  process.argv = process.argv.filter(a => a !== "--tmux");
}

const args = process.argv.slice(2);
const firstArg = args[0] || "";
const muxKind = detectMultiplexer();

// Fast path: `agents back` should feel instant and does not need Commander/Ink.
if (args.length === 1 && firstArg === "back" && muxKind === "tmux") {
  process.exit(switchBack() ? 0 : 1);
}

// If launched outside a multiplexer for a command that needs one, re-exec inside.
// Non-interactive commands (report, setup, uninstall, count, back) work fine without one.
const insideMux = !!muxKind;
if (!insideMux) {
  const hasJson = args.includes("--json");
  const needsMux = !firstArg || firstArg === "watch" || firstArg === "w"
    || ((firstArg === "list" || firstArg === "ls") && !hasJson)
    || firstArg === "workspace" || firstArg === "ws";
  if (needsMux) {
    // Try tmux (zellij auto-session creation not yet supported)
    try {
      execSync("which tmux", { stdio: "ignore" });
    } catch {
      console.error("No multiplexer detected. Run inside tmux or zellij, or install tmux.");
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
        // Lock the window name so shells/programs can't override it
        execSync(`tmux set-option -t agents:0 -w automatic-rename off`, { stdio: "ignore" });
        execSync(`tmux set-option -t agents:0 -w allow-rename off`, { stdio: "ignore" });
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
      // Re-apply styling on every attach (global theme hooks may have overridden it)
      applyStyle();
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

const [
  commander,
  reactMod,
  ink,
  scanner,
  state,
  setupMod,
  workspace,
  config,
  dashboardMod,
  selectMod,
  agentTableMod,
] = await Promise.all([
  import("commander"),
  import("react"),
  import("ink"),
  import("./scanner.js"),
  import("./state.js"),
  import("./setup.js"),
  import("./workspace.js"),
  import("./config.js"),
  import("./components/Dashboard.js"),
  import("./components/Select.js"),
  import("./components/AgentTable.js"),
]);

const { Command } = commander;
const React = reactMod.default;
const { render } = ink;
const { scan, getSessionHistory, inferContextFromContent, inferModelFromContent } = scanner;
const { reportState, reportContext } = state;
const { setup, uninstall, autoSetupIfNeeded } = setupMod;
const { createWorkspace } = workspace;
const { getProfileNames, resolveProfile } = config;
const { Dashboard } = dashboardMod;
const { Select } = selectMod;
const { AgentTable } = agentTableMod;

// Initialize multiplexer (async import of the correct backend)
await initMux();

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
  .command("history")
  .description("Show persisted session history for supported agents")
  .option("--agent <name>", "Agent backend to query (currently codex)")
  .option("--cwd <path>", "Workspace path to query (defaults to live agents, then current directory)")
  .option("--limit <n>", "Maximum sessions per agent/cwd", (value) => parseInt(value, 10), 5)
  .option("--json", "Output as JSON")
  .action((opts) => {
    const groups = getSessionHistory({ agent: opts.agent, cwd: opts.cwd, limit: opts.limit });
    if (opts.json) {
      console.log(JSON.stringify(groups, null, 2));
      return;
    }
    if (groups.length === 0) {
      console.log("No persisted session history found.");
      return;
    }

    const formatTs = (ts: number) => {
      const d = new Date(ts * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    for (const [index, group] of groups.entries()) {
      if (index > 0) console.log("");
      console.log(`${group.agent}  ${group.cwd}`);
      for (const session of group.sessions) {
        const marker = session.current ? "*" : " ";
        const model = session.model ? `  ${session.model}` : "";
        console.log(`${marker} ${formatTs(session.updatedAt)}${model}  ${session.title}`);
      }
    }
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
  .option("--state <state>", "State: working, idle, approval, question")
  .option("--detail <text>", "Current activity detail (tool name, filename, etc.)")
  .option("--model <name>", "Model currently selected for the agent")
  .option("--external-session-id <id>", "Underlying agent session ID, if different from the pane ID")
  .option("--context <text>", "Context description for this workspace")
  .option("--context-tokens <n>", "Current token usage in conversation", parseInt)
  .option("--context-max <n>", "Context window limit for the model", parseInt)
  .option("--session <id>", "Session ID (reads from stdin if not provided)")
  .action(async (opts) => {
    let session = opts.session;
    // Resolve empty session from zellij env (hooks pass $TMUX_PANE which is empty in zellij)
    if (!session && process.env.ZELLIJ_PANE_ID) {
      session = `terminal_${process.env.ZELLIJ_PANE_ID}`;
    }
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
    // Workspace snapshot is seeded at creation time by createWorkspace().
    // Here we only build a fallback for agents started manually (not via `agents ws` or `n`).
    // Existing workspace data is never overwritten — reportState preserves it.
    let wsSnapshot: undefined | { command: string; cwd: string; mux?: "tmux" | "zellij" };
    const muxKind = detectMultiplexer();
    if (muxKind === "tmux" && session?.startsWith("%")) {
      try {
        const paneCwd = execSync(
          `tmux display-message -t ${session} -p '#{pane_current_path}'`,
          { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (paneCwd) wsSnapshot = { command: opts.agent, cwd: paneCwd, mux: "tmux" };
      } catch {}
    } else if (muxKind === "zellij" && process.env.PWD) {
      wsSnapshot = { command: opts.agent, cwd: process.env.PWD, mux: "zellij" };
    }

    const externalSessionId = opts.externalSessionId as string | undefined;
    let model = opts.model as string | undefined;
    let ctxTokens = isNaN(opts.contextTokens) ? undefined : opts.contextTokens;
    let ctxMax = isNaN(opts.contextMax) ? undefined : opts.contextMax;
    if (muxKind === "tmux" && session?.startsWith("%") && (!model || ctxTokens === undefined || ctxMax === undefined)) {
      try {
        const paneTail = execSync(
          `tmux capture-pane -t ${session} -p -S -20 2>/dev/null`,
          { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (!model) model = inferModelFromContent(opts.agent, paneTail);
        const inferredContext = inferContextFromContent(opts.agent, paneTail);
        if (ctxTokens === undefined) ctxTokens = inferredContext.contextTokens;
        if (ctxMax === undefined) ctxMax = inferredContext.contextMax;
      } catch {}
    }
    if (opts.context && !opts.state) {
      // Context-only update — preserve existing state
      reportContext(opts.agent, session, opts.context, wsSnapshot, ctxTokens, ctxMax, model, externalSessionId);
    } else if (opts.state) {
      reportState(opts.agent, session, opts.state, {
        detail: opts.detail,
        model,
        externalSessionId,
        context: opts.context,
        workspace: wsSnapshot,
        contextTokens: ctxTokens,
        contextMax: ctxMax,
      });
    }
  });

program
  .command("workspace")
  .alias("ws")
  .description("Create a new agent workspace in the current directory")
  .argument("[profile]", "Profile name (omit to list available profiles)")
  .argument("[overrides...]", "Override agent command (appended after profile command)")
  .option("-n, --name <name>", "Window name override")
  .option("-l, --layout <layout>", "Layout name (default, small, or custom)")
  .option("--agent-only", "Skip helper pane creation (app creates them on demand)")
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
    createWorkspace(cmd, opts.name, opts.layout, { profile, cwd: process.cwd(), agentOnly: opts.agentOnly });
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
        const icon = r.action === "installed" ? "✓" : "–";
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
