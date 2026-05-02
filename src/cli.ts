#!/usr/bin/env node
import { execSync, spawnSync } from "child_process";
import type { ModelSource } from "./state.js";
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

// If launched outside a multiplexer for a command that truly requires a live
// dashboard pane, re-exec inside tmux. Other commands may still talk to tmux,
// but they should not force an attach just because they were launched from a
// plain shell.
const insideMux = !!muxKind;
if (!insideMux) {
  const needsMux = !firstArg || firstArg === "watch" || firstArg === "w";
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
  scanner,
  bundleMod,
  state,
  setupMod,
  workspace,
  config,
  resumeMod,
  agentRestore,
  implementationRuntime,
] = await Promise.all([
  import("commander"),
  import("./scanner.js"),
  import("./bundle.js"),
  import("./state.js"),
  import("./setup.js"),
  import("./workspace.js"),
  import("./config.js"),
  import("./resume.js"),
  import("./agent-restore.js"),
  import("./implementation-runtime.js"),
]);

const { Command } = commander;
const { scan, runtimeStates, getSessionHistory } = scanner;
const { createAppBundle } = bundleMod;
const { reportState, reportContext, reportContributorState } = state;
const { setup, uninstall, autoSetupIfNeeded, doctor } = setupMod;
const { createWorkspace } = workspace;
const { getProfileNames, resolveProfile } = config;
const { resumeAgentSession } = resumeMod;
const { normalizeTmuxResurrectFile, resolveAgentRestoreArgv } = agentRestore;
const {
  AgentsRuntimeError,
  listImplementationTargets,
  createImplementationCheckout,
  getImplementationCheckoutStatus,
  startImplementationSession,
  resumeImplementationSession,
  listTargetAgentSessions,
} = implementationRuntime;

function runResurrectAgent(agent: string, args: string[]): never {
  const originalArgv = [agent, ...(args || [])];
  const argv = resolveAgentRestoreArgv({
    agent,
    cwd: process.cwd(),
    originalArgv,
  }) || originalArgv;

  const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env: process.env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(127);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal as NodeJS.Signals);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function normalizeResurrectFile(file: string, opts: { json?: boolean }): void {
  const result = normalizeTmuxResurrectFile(file);
  if (opts.json) {
    console.log(JSON.stringify({ panes: result.panes, changed: result.changed }, null, 2));
  }
}

function printRuntimeResult(result: unknown, opts: { json?: boolean }, fallback: string): void {
  if (opts.json || !process.stdout.isTTY) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(fallback);
}

function handleRuntimeError(error: unknown, opts: { json?: boolean }): never {
  if (error instanceof AgentsRuntimeError) {
    if (opts.json || !process.stderr.isTTY) {
      console.error(JSON.stringify(error.toJSON(), null, 2));
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (opts.json || !process.stderr.isTTY) {
    console.error(JSON.stringify({ ok: false, phase: "complete", code: "unexpected_error", message, retryable: true }, null, 2));
  } else {
    console.error(message);
  }
  process.exit(1);
}

async function loadUiModules() {
  const [reactMod, ink, dashboardMod, selectMod, agentTableMod] = await Promise.all([
    import("react"),
    import("ink"),
    import("./components/Dashboard.js"),
    import("./components/Select.js"),
    import("./components/AgentTable.js"),
  ]);
  return {
    React: reactMod.default,
    render: ink.render,
    Dashboard: dashboardMod.Dashboard,
    Select: selectMod.Select,
    AgentTable: agentTableMod.AgentTable,
  };
}

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
  .action(async (opts) => {
    const agents = scan();
    if (opts.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }
    const { React, render, Select, AgentTable } = await loadUiModules();
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
  .action(async (seconds) => {
    const interval = parseInt(seconds, 10) || 2;
    // Set tmux pane title
    process.stdout.write("\x1b]2;Agent Dashboard\x1b\\");
    // Clear screen for clean start (no alternate screen — conflicts with pane splits)
    process.stdout.write("\x1b[2J\x1b[H");
    const { React, render, Dashboard } = await loadUiModules();
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
  .command("runtime")
  .description("Show reconciled runtime status for existing panes")
  .option("--json", "Output as JSON")
  .option("--pane <id>", "tmux pane ID to query", (value, prev: string[] = []) => [...prev, value], [])
  .action((opts) => {
    const states = runtimeStates(opts.pane);
    if (opts.json || !process.stdout.isTTY) {
      console.log(JSON.stringify(states, null, 2));
      return;
    }

    for (const state of states) {
      const detail = state.detail ? ` ${state.detail}` : "";
      console.log(`${state.session} ${state.status}${detail}`);
    }
  });

program
  .command("bundle")
  .description("Create an app-installable bundle directory for managed installs")
  .argument("<outDir>", "Output directory (must be empty or not yet exist)")
  .option("--json", "Output bundle metadata as JSON")
  .action((outDir, opts) => {
    try {
      const metadata = createAppBundle(outDir);
      if (opts.json) {
        console.log(JSON.stringify(metadata, null, 2));
        return;
      }
      console.log(`Wrote agents bundle to ${metadata.outputDir}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    }
  });

program
  .command("history")
  .description("Show persisted session history for supported agents")
  .option("--agent <name>", "Agent backend to query (e.g. codex, pi)")
  .option("--pane <id>", "tmux pane ID to query")
  .option("--cwd <path>", "Workspace path to query (defaults to live agents, then current directory)")
  .option("--limit <n>", "Maximum sessions per agent/cwd", (value) => parseInt(value, 10), 5)
  .option("--json", "Output as JSON")
  .action((opts) => {
    const groups = getSessionHistory({ agent: opts.agent, pane: opts.pane, cwd: opts.cwd, limit: opts.limit });
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
  .command("resume")
  .description("Resume a persisted agent session in a live pane")
  .requiredOption("--pane <id>", "tmux pane ID to resume into")
  .option("--agent <name>", "Agent backend to run when it differs from the live pane")
  .option("--profile <name>", "Profile to use for the restarted agent command")
  .option("--new-session", "Start a new agent session")
  .option("--prompt <text>", "Initial prompt when starting a new agent session")
  .option("--session <id>", "Session ID to resume")
  .option("--session-path <path>", "Session file path to resume")
  .option("--target <value>", "Generic resume target")
  .option("--target-kind <kind>", "Generic resume target kind (session-id, session-path, or new-session)")
  .option("--force", "Resume even if the live agent is not idle")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const targetKind = opts.targetKind === "session-path" || opts.targetKind === "session-id" || opts.targetKind === "new-session"
      ? opts.targetKind
      : undefined;
    const result = resumeAgentSession({
      pane: opts.pane,
      agent: opts.agent,
      profile: opts.profile,
      newSession: !!opts.newSession,
      prompt: opts.prompt,
      session: opts.session,
      sessionPath: opts.sessionPath,
      target: opts.target,
      targetKind,
      force: !!opts.force,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(`Resumed ${result.agent} in ${result.tmuxPaneId}.`);
    } else if (result.requiresForce) {
      console.error(result.message || "Agent is not idle; pass --force to resume anyway.");
    } else {
      console.error(result.message || "Resume failed.");
    }

    if (!result.ok && !result.requiresForce) {
      process.exit(1);
    }
  });

const targetCommand = program
  .command("target")
  .description("List and resolve reusable execution targets");

targetCommand
  .command("list")
  .description("List configured local and remote execution targets")
  .option("--repo-root <path>", "Repo path used to derive the local repo root", process.cwd())
  .option("--json", "Output as JSON")
  .action((opts) => {
    try {
      const result = listImplementationTargets({ repoRoot: opts.repoRoot });
      printRuntimeResult(result, opts, result.targets.map((target) => `${target.id}\t${target.kind}\t${target.displayName}`).join("\n"));
    } catch (error) {
      handleRuntimeError(error, opts);
    }
  });

const checkoutCommand = program
  .command("checkout")
  .description("Create and inspect implementation checkouts");

checkoutCommand
  .command("create")
  .description("Create a local or remote implementation checkout")
  .requiredOption("--name <name>", "Stable checkout name seed")
  .option("--target <id>", "Execution target id", "local")
  .option("--repo-root <path>", "Repo path used for target config and source repo", process.cwd())
  .option("--source-repo <path>", "Source git repo path (defaults to --repo-root)")
  .option("--repo <name>", "Repository name override")
  .option("--remote-url <url>", "Canonical source remote URL")
  .option("--base <ref>", "Explicit base ref")
  .option("--branch <name>", "Branch name override")
  .option("--no-clone-if-missing", "Fail instead of cloning when the target repo is missing")
  .option("--local-landing", "Create a local landing checkout for remote execution")
  .option("--reuse-existing", "Reuse the stable checkout path when it already exists on the requested branch")
  .option("--json", "Output as JSON")
  .action((opts) => {
    try {
      const result = createImplementationCheckout({
        targetId: opts.target,
        repoRoot: opts.repoRoot,
        sourceRepoPath: opts.sourceRepo,
        repoName: opts.repo,
        remoteUrl: opts.remoteUrl,
        baseRef: opts.base,
        branch: opts.branch,
        name: opts.name,
        cloneIfMissing: opts.cloneIfMissing,
        localLanding: !!opts.localLanding,
        reuseExisting: !!opts.reuseExisting,
      });
      printRuntimeResult(result, opts, `Created ${result.executionCheckout.checkoutId} at ${result.executionCheckout.path}`);
    } catch (error) {
      handleRuntimeError(error, opts);
    }
  });

checkoutCommand
  .command("status")
  .description("Report implementation checkout status")
  .option("--target <id>", "Execution target id", "local")
  .option("--repo-root <path>", "Repo path used for target config", process.cwd())
  .option("--repo <name>", "Repository name")
  .option("--checkout-id <id>", "Checkout id")
  .option("--path <path>", "Inspect a single checkout path instead of discovering implementation checkouts")
  .option("--branch <name>", "Branch name")
  .option("--base <ref>", "Base ref")
  .option("--base-commit <sha>", "Base commit")
  .option("--role <role>", "Checkout role: landing or execution")
  .option("--json", "Output as JSON")
  .action((opts) => {
    try {
      const result = getImplementationCheckoutStatus({
        targetId: opts.target,
        repoRoot: opts.repoRoot,
        repoName: opts.repo,
        checkoutId: opts.checkoutId,
        path: opts.path,
        branch: opts.branch,
        baseRef: opts.base,
        baseCommit: opts.baseCommit,
        role: opts.role,
      });
      printRuntimeResult(
        result,
        opts,
        result.checkouts.map((checkout) => `${checkout.checkoutId}\t${checkout.branch || ""}\t${checkout.path}`).join("\n"),
      );
    } catch (error) {
      handleRuntimeError(error, opts);
    }
  });

const sessionCommand = program
  .command("session")
  .description("Start or resume tmux-backed implementation sessions");

sessionCommand
  .command("list")
  .description("List agent sessions for a local or remote target")
  .option("--target <id>", "Execution target id", "local")
  .option("--repo-root <path>", "Repo path used for target config", process.cwd())
  .option("--json", "Output as JSON")
  .action((opts) => {
    try {
      const result = listTargetAgentSessions({
        targetId: opts.target,
        repoRoot: opts.repoRoot,
      });
      printRuntimeResult(
        result,
        opts,
        result.sessions.map((session) => `${session.tmuxPaneId || session.paneId || session.pane || ""}\t${session.status || ""}\t${session.cwd || ""}`).join("\n"),
      );
    } catch (error) {
      handleRuntimeError(error, opts);
    }
  });

sessionCommand
  .command("start")
  .description("Start an agent session in an implementation checkout")
  .requiredOption("--checkout-id <id>", "Implementation checkout id")
  .requiredOption("--path <path>", "Execution checkout path")
  .requiredOption("--profile <name>", "Agent profile")
  .option("--target <id>", "Execution target id", "local")
  .option("--repo-root <path>", "Repo path used for target config", process.cwd())
  .option("--name <name>", "Session/window name")
  .option("--tmux-session <session>", "tmux session to create the workspace window in")
  .option("--json", "Output as JSON")
  .argument("[overrides...]", "Override agent command arguments")
  .allowUnknownOption()
  .action((overrides, opts) => {
    try {
      const name = opts.name || String(opts.checkoutId).split(":").pop() || "agent";
      const result = startImplementationSession({
        targetId: opts.target,
        repoRoot: opts.repoRoot,
        checkoutId: opts.checkoutId,
        path: opts.path,
        profile: opts.profile,
        name,
        tmuxSession: opts.tmuxSession,
        overrides,
      });
      printRuntimeResult(result, opts, `Started ${result.session.sessionId} (${result.session.paneId || "pending"}).`);
    } catch (error) {
      handleRuntimeError(error, opts);
    }
  });

sessionCommand
  .command("resume")
  .description("Resume or start a follow-up session in an existing agent pane")
  .requiredOption("--session <id>", "Session id")
  .option("--target <id>", "Execution target id", "local")
  .option("--repo-root <path>", "Repo path used for target config", process.cwd())
  .option("--checkout-id <id>", "Implementation checkout id")
  .option("--path <path>", "Checkout path")
  .option("--profile <name>", "Agent profile")
  .option("--pane <id>", "Known tmux pane id")
  .option("--prompt <text>", "Prompt for a new follow-up session")
  .option("--new-session", "Start a new agent session in the existing pane")
  .option("--json", "Output as JSON")
  .action((opts) => {
    try {
      const result = resumeImplementationSession({
        targetId: opts.target,
        repoRoot: opts.repoRoot,
        sessionId: opts.session,
        checkoutId: opts.checkoutId,
        path: opts.path,
        profile: opts.profile,
        pane: opts.pane,
        prompt: opts.prompt,
        newSession: !!opts.newSession,
      });
      printRuntimeResult(result, opts, result.message || `Resolved ${result.sessionId}.`);
    } catch (error) {
      handleRuntimeError(error, opts);
    }
  });

const resurrect = program
  .command("resurrect")
  .description("tmux-resurrect integration helpers");

resurrect
  .command("agent")
  .description("Run an agent command during tmux-resurrect restore")
  .argument("<agent>", "Agent backend to restore")
  .argument("[args...]", "Original command arguments after the agent executable")
  .allowUnknownOption(true)
  .action((agent: string, args: string[]) => {
    runResurrectAgent(agent, args);
  });

resurrect
  .command("normalize")
  .description("Rewrite a tmux-resurrect save file to prefer explicit agent session ids")
  .argument("<file>", "tmux-resurrect save file path")
  .option("--json", "Output as JSON")
  .action((file: string, opts) => {
    normalizeResurrectFile(file, opts);
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
  .requiredOption("--agent <name>", "Agent name (claude, copilot, pi, opencode, codex)")
  .option("--state <state>", "State: working, idle, approval, question")
  .option("--detail <text>", "Current activity detail (tool name, filename, etc.)")
  .option("--clear-detail", "Clear any previously reported activity detail")
  .option("--model <name>", "Backward-compatible model display string")
  .option("--provider <id>", "Model provider ID")
  .option("--model-id <id>", "Canonical model ID")
  .option("--model-label <label>", "Presentation label for the selected model")
  .option("--model-source <source>", "Model source: hook, sdk, transcript, session-log, inferred")
  .option("--external-session-id <id>", "Underlying agent session ID, if different from the pane ID")
  .option("--context <text>", "Context description for this workspace")
  .option("--context-tokens <n>", "Current token usage in conversation", parseInt)
  .option("--context-max <n>", "Context window limit for the model", parseInt)
  .option("--reporter <id>", "Auxiliary reporter identity for contributor state")
  .option("--auxiliary", "Write an auxiliary contributor state instead of the primary session state")
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
    let provider = opts.provider as string | undefined;
    let modelId = opts.modelId as string | undefined;
    let modelLabel = opts.modelLabel as string | undefined;
    let modelSource = opts.modelSource as string | undefined;
    let ctxTokens = isNaN(opts.contextTokens) ? undefined : opts.contextTokens;
    let ctxMax = isNaN(opts.contextMax) ? undefined : opts.contextMax;
    if (opts.auxiliary && !opts.reporter) {
      console.error("--auxiliary requires --reporter");
      process.exit(1);
    }

    if (opts.context && !opts.state) {
      // Context-only update — preserve existing state
      reportContext(opts.agent, session, opts.context, {
        workspace: wsSnapshot,
        contextTokens: ctxTokens,
        contextMax: ctxMax,
        model,
        provider,
        modelId,
        modelLabel,
        modelSource: modelSource as ModelSource | undefined,
        externalSessionId,
      });
    } else if (opts.state && opts.auxiliary) {
      reportContributorState(opts.agent, session, opts.reporter, opts.state, {
        ...(opts.detail ? { detail: opts.detail } : {}),
      });
    } else if (opts.state) {
      reportState(opts.agent, session, opts.state, {
        detail: opts.detail,
        clearDetail: !!opts.clearDetail,
        model,
        provider,
        modelId,
        modelLabel,
        modelSource: modelSource as ModelSource | undefined,
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
  .argument("[profile]", "Profile name (omit to use the configured default profile)")
  .argument("[overrides...]", "Override agent command (appended after profile command)")
  .option("-n, --name <name>", "Window name override")
  .option("-l, --layout <layout>", "Layout name (default, small, or custom)")
  .option("--list-profiles", "List available profiles and exit")
  .option("--agent-only", "Skip helper pane creation (app creates them on demand)")
  .option("--direct-agent-launch", "tmux only: launch the main agent pane directly instead of through the shell")
  .option("--tmux-session <session>", "tmux session to create the workspace window in")
  .option("--require-discoverable", "Fail unless the launched agent pane becomes visible to agents scanner")
  .option("--json", "Output launch metadata as JSON")
  .allowUnknownOption()
  .action((profile, overrides, opts) => {
    const profiles = getProfileNames();
    if (opts.listProfiles) {
      console.log("Available profiles:");
      for (const name of profiles) {
        const p = resolveProfile(name);
        console.log(`  ${name}  ${p.command}`);
      }
      process.exit(0);
    }
    const selectedProfile = profile || undefined;
    if (selectedProfile && !profiles.includes(selectedProfile)) {
      console.error(`Unknown profile "${profile}". Available: ${profiles.join(", ")}`);
      process.exit(1);
    }
    const result = createWorkspace(undefined, opts.name, opts.layout, {
      profile: selectedProfile,
      cwd: process.cwd(),
      agentOnly: opts.agentOnly,
      directAgentLaunch: opts.directAgentLaunch,
      tmuxSession: opts.tmuxSession,
      requireDiscoverable: opts.requireDiscoverable,
      overrideArgs: overrides,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `Started ${result.windowName} in ${result.sessionName || result.mux || "workspace"} (${result.paneId}).`
    );
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
  .description("Install or update supported agent integrations")
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

program
  .command("doctor")
  .description("Inspect integration coverage and installation status for supported agents")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const results = doctor();
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    for (const result of results) {
      const detail = result.detail ? ` (${result.detail})` : "";
      console.log(`${result.agent}  ${result.status}  ${result.installMethod}${detail}`);
      console.log(`  events: ${result.installedEvents.length ? result.installedEvents.join(", ") : "none"}`);
      console.log(`  missing lifecycle: ${result.missingLifecycle.length ? result.missingLifecycle.join(", ") : "none"}`);
      console.log(`  missing metadata: ${result.missingMetadata.length ? result.missingMetadata.join(", ") : "none"}`);
    }
  });

if (args.length === 0) {
  program.parse([process.argv[0], process.argv[1], "watch"]);
} else {
  program.parse();
}
