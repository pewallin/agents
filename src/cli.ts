#!/usr/bin/env node
import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ModelSource } from "./state.js";
import type { AgentDoneRecordInput } from "./done.js";
import { switchBack } from "./back.js";
import { setMultiplexer, detectMultiplexer, initMux } from "./multiplexer.js";

type AgentsPackageJSON = {
  version?: string;
};

function findPackageRoot(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(join(directory, "package.json"))) {
      return directory;
    }
    directory = dirname(directory);
  }
  return undefined;
}

function readPackageVersion(packageRoot: string | undefined): string {
  if (!packageRoot) {
    return "0.0.0-dev";
  }
  try {
    const packageJSON = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as AgentsPackageJSON;
    return packageJSON.version || "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

function readGitRevision(packageRoot: string | undefined): string | undefined {
  if (!packageRoot || !existsSync(join(packageRoot, ".git"))) {
    return undefined;
  }
  try {
    return execSync("git rev-parse --short=12 HEAD", {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function agentsVersion(): string {
  const packageRoot = findPackageRoot();
  const version = readPackageVersion(packageRoot);
  const revision = readGitRevision(packageRoot);
  return revision ? `${version}+${revision}` : version;
}

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
  tmuxPaneMetadata,
  reportBinding,
  implementationRuntime,
  usageMod,
  doneMod,
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
  import("./tmux-pane-metadata.js"),
  import("./report-binding.js"),
  import("./implementation-runtime.js"),
  import("./usage.js"),
  import("./done.js"),
]);

const { Command } = commander;
const { scan, runtimeStates, getSessionHistory, detectAgentProcess } = scanner;
const { createAppBundle } = bundleMod;
const { reportState, reportContext, reportContributorState } = state;
const { setup, uninstall, autoSetupIfNeeded, doctor } = setupMod;
const { createWorkspace } = workspace;
const { getProfileNames, resolveProfile } = config;
const { resumeAgentSession } = resumeMod;
const { backfillTmuxPaneCommandMetadata, readTmuxPaneCommandLaunch, readTmuxPaneReportMetadata, setTmuxPaneCommandMetadata, tmuxPaneBackfillLaunchCommand, updateTmuxPaneCommandLaunch } = tmuxPaneMetadata;
const { requiresTmuxReportProcessScan, resolveTmuxReportBinding } = reportBinding;
const {
  normalizeTmuxResurrectFile,
  resolveAgentRestoreArgv,
  renderCommand,
  claimCodexRestoreLaunchDelayMs,
  applyTmuxResurrectMetadataLaunchesFile,
  tmuxResurrectMetadataCaptures,
  tmuxResurrectRestoreProcessesForFiles,
} = agentRestore;
const {
  AgentsRuntimeError,
  listImplementationTargets,
  createImplementationCheckout,
  getImplementationCheckoutStatus,
  startImplementationSession,
  resumeImplementationSession,
  listTargetAgentSessions,
} = implementationRuntime;
const { fetchAgentUsageSnapshot } = usageMod;
const { AgentDoneError, listDoneProjection, recordDoneEvent, updateDoneProjection } = doneMod;

const CODEX_UPDATE_PREFLIGHT_TTL_MS = 15 * 60 * 1000;
const CODEX_UPDATE_PREFLIGHT_WAIT_MS = 10 * 60 * 1000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isFreshPath(path: string, ttlMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs <= ttlMs;
  } catch {
    return false;
  }
}

function agentsRuntimeTempDir(): string {
  const agentsHome = process.env.AGENTS_HOME || join(process.env.HOME || "", ".agents", "agents-app");
  return process.env.AGENTS_TMP_DIR || join(agentsHome, "runtime", "tmp");
}

function runCodexUpdatePreflight(argv: string[]): void {
  if (process.env.AGENTS_SKIP_CODEX_UPDATE_PREFLIGHT === "1") return;
  const preflightDir = join(agentsRuntimeTempDir(), "codex-update-preflight");
  const donePath = join(preflightDir, "done");
  const lockPath = join(preflightDir, "lock");

  mkdirSync(preflightDir, { recursive: true });
  if (isFreshPath(donePath, CODEX_UPDATE_PREFLIGHT_TTL_MS)) return;

  let leader = false;
  try {
    mkdirSync(lockPath);
    leader = true;
  } catch {
    leader = false;
  }

  if (leader) {
    try {
      const executable = argv[0] || "codex";
      const result = spawnSync(executable, ["update"], { stdio: "inherit", env: process.env });
      if (result.error) {
        console.error(`Codex update preflight failed: ${result.error.message}`);
      } else if (result.status && result.status !== 0) {
        console.error(`Codex update preflight exited with ${result.status}; continuing restore.`);
      }
      writeFileSync(donePath, `${Date.now()}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Codex update preflight failed: ${message}`);
      writeFileSync(donePath, `${Date.now()}\n`);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
    return;
  }

  const startedAt = Date.now();
  while (!isFreshPath(donePath, CODEX_UPDATE_PREFLIGHT_TTL_MS)) {
    if (!existsSync(lockPath)) return;
    if (Date.now() - startedAt > CODEX_UPDATE_PREFLIGHT_WAIT_MS) {
      console.error("Timed out waiting for Codex update preflight; continuing restore.");
      return;
    }
    sleepSync(500);
  }
}

function clearScreenBeforeTuiRestore(agent: string): void {
  if (agent.toLowerCase() !== "pi") return;
  if (!process.stdout.isTTY) return;

  // tmux-resurrect sends restore commands into a shell; Pi does not clear that shell line.
  process.stdout.write("\x1b[2J\x1b[H");
}

function runResurrectAgent(agent: string, args: string[]): never {
  const originalArgv = [agent, ...(args || [])];
  const argv = resolveAgentRestoreArgv({
    agent,
    cwd: process.cwd(),
    originalArgv,
  }) || originalArgv;

  setTmuxPaneCommandMetadata(process.env.TMUX_PANE, {
    agent,
    command: renderCommand(originalArgv),
    launchCommand: renderCommand(argv),
    cwd: process.cwd(),
  });

  if (agent.toLowerCase() === "codex") {
    runCodexUpdatePreflight(argv);
    sleepSync(claimCodexRestoreLaunchDelayMs());
  }

  clearScreenBeforeTuiRestore(agent);

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

function applyResurrectMetadata(file: string, metadataFile: string, opts: { json?: boolean }): void {
  const result = applyTmuxResurrectMetadataLaunchesFile(file, metadataFile);
  if (opts.json) {
    console.log(JSON.stringify({ panes: result.panes, metadata: result.metadata, changed: result.changed }, null, 2));
  }
}

function printResurrectProcesses(file: string | undefined, metadataFile: string | undefined, opts: { json?: boolean }): void {
  const processes = tmuxResurrectRestoreProcessesForFiles(file, metadataFile);
  if (opts.json) {
    console.log(JSON.stringify(processes, null, 2));
    return;
  }
  console.log(processes.join("\n"));
}

function captureResurrectMetadata(opts: { json?: boolean }): void {
  const captures = tmuxResurrectMetadataCaptures(scan().map((pane) => ({
    ...pane,
    commandLaunch: readTmuxPaneCommandLaunch(pane.tmuxPaneId),
  })));
  let updated = 0;
  const failed: string[] = [];

  for (const capture of captures) {
    const ok = updateTmuxPaneCommandLaunch(capture.paneID, capture.launchCommand, capture.cwd);
    if (ok) updated += 1;
    else failed.push(capture.paneID);
  }

  if (opts.json) {
    console.log(JSON.stringify({ scanned: captures.length, updated, failed }, null, 2));
  } else {
    console.log(updated);
  }
  if (failed.length > 0) process.exitCode = 1;
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

function handleDoneError(error: unknown, opts: { json?: boolean }): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof AgentDoneError ? error.code : "unexpected_error";
  if (opts.json || !process.stderr.isTTY) {
    console.error(JSON.stringify({ ok: false, contractVersion: 1, code, message }, null, 2));
  } else {
    console.error(message);
  }
  process.exit(1);
}

function parseBooleanOption(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new AgentDoneError("invalid_boolean", `${name} must be true or false.`);
}

async function readJSONFromStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input = Buffer.concat(chunks).toString("utf8").trim();
  if (!input) {
    throw new AgentDoneError("missing_input", "Expected a Done event JSON payload on stdin.");
  }
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentDoneError("invalid_json", `Invalid Done event JSON: ${message}`);
  }
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
  .version(agentsVersion());

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
  .command("usage")
  .description("Show normalized provider quota usage")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const snapshot = await fetchAgentUsageSnapshot();
    if (opts.json || !process.stdout.isTTY) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    if (snapshot.sources.length === 0) {
      console.log("No provider usage sources configured.");
      return;
    }

    for (const source of snapshot.sources) {
      const account = source.account?.label || source.account?.id;
      const suffix = account ? ` (${account})` : "";
      console.log(`${source.providerLabel || source.provider}${suffix}: ${source.status}`);
    }
  });

const doneCommand = program
  .command("done")
  .description("Manage persisted Done events and pinned agent sessions");

doneCommand
  .command("list")
  .description("List persisted Done events and pinned agent sessions")
  .option("--json", "Output as JSON")
  .action((opts) => {
    try {
      const projection = listDoneProjection();
      if (opts.json || !process.stdout.isTTY) {
        console.log(JSON.stringify(projection, null, 2));
        return;
      }
      const records = projection.records.filter((record) => !record.acknowledged && !record.cleared);
      console.log(`${projection.pinnedSessions.length} pinned sessions, ${records.length} recent Done records.`);
    } catch (error) {
      handleDoneError(error, opts);
    }
  });

doneCommand
  .command("record")
  .description("Record or upsert a Done event from JSON on stdin")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    try {
      const payload = await readJSONFromStdin();
      const projection = recordDoneEvent(payload as AgentDoneRecordInput);
      if (opts.json || !process.stdout.isTTY) {
        console.log(JSON.stringify(projection, null, 2));
        return;
      }
      console.log("Recorded Done event.");
    } catch (error) {
      handleDoneError(error, opts);
    }
  });

doneCommand
  .command("update")
  .description("Update Done event state or session pin state")
  .option("--session-identity <id>", "Stable agent session identity for pin/unpin")
  .option("--external-session-id <id>", "External agent session id for pin/unpin")
  .option("--done-event-id <id>", "Done event id for acknowledge/clear")
  .option("--pin <true|false>", "Pin or unpin a session")
  .option("--acknowledge <true|false>", "Acknowledge or unacknowledge a Done event")
  .option("--clear <true|false>", "Clear or restore a Done event")
  .option("--json", "Output as JSON")
  .action((opts) => {
    try {
      const projection = updateDoneProjection({
        sessionIdentity: opts.sessionIdentity,
        externalSessionID: opts.externalSessionId,
        doneEventID: opts.doneEventId,
        pin: parseBooleanOption(opts.pin, "--pin"),
        acknowledge: parseBooleanOption(opts.acknowledge, "--acknowledge"),
        clear: parseBooleanOption(opts.clear, "--clear"),
      });
      if (opts.json || !process.stdout.isTTY) {
        console.log(JSON.stringify(projection, null, 2));
        return;
      }
      console.log("Updated Done state.");
    } catch (error) {
      handleDoneError(error, opts);
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
  .option("--start <ref>", "Explicit start ref for the implementation branch")
  .option("--branch <name>", "Branch name override")
  .option("--no-clone-if-missing", "Fail instead of cloning when the target repo is missing")
  .option("--local-landing", "Create a local landing checkout for remote execution")
  .option("--reuse-existing", "Reuse the stable checkout path when it already exists on the requested branch")
  .option("--snapshot-path <path>", "Repo-relative context path to snapshot into the implementation branch", (value, previous: string[] = []) => [...previous, value], [])
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
        startRef: opts.start,
        branch: opts.branch,
        name: opts.name,
        cloneIfMissing: opts.cloneIfMissing,
        localLanding: !!opts.localLanding,
        reuseExisting: !!opts.reuseExisting,
        snapshotPaths: opts.snapshotPath,
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
  .command("capture-metadata")
  .description("Capture live agent launches into tmux pane metadata before save")
  .option("--json", "Output as JSON")
  .action((opts) => {
    captureResurrectMetadata(opts);
  });

resurrect
  .command("normalize")
  .description("Rewrite a tmux-resurrect save file to prefer explicit agent session ids")
  .argument("<file>", "tmux-resurrect save file path")
  .option("--json", "Output as JSON")
  .action((file: string, opts) => {
    normalizeResurrectFile(file, opts);
  });

resurrect
  .command("apply-metadata")
  .description("Rewrite a tmux-resurrect save file from Agents pane metadata and config")
  .argument("<file>", "tmux-resurrect save file path")
  .argument("<metadataFile>", "Agents pane metadata sidecar path")
  .option("--json", "Output as JSON")
  .action((file: string, metadataFile: string, opts) => {
    applyResurrectMetadata(file, metadataFile, opts);
  });

resurrect
  .command("processes")
  .description("Print tmux-resurrect process entries from Agents config and metadata")
  .argument("[file]", "tmux-resurrect save file path")
  .argument("[metadataFile]", "Agents pane metadata sidecar path")
  .option("--json", "Output as JSON")
  .action((file: string | undefined, metadataFile: string | undefined, opts) => {
    printResurrectProcesses(file, metadataFile, opts);
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
  .requiredOption("--agent <name>", "Agent name (claude, copilot, pi, opencode, codex, kiro, hermes)")
  .option("--state <state>", "State: working, idle, approval, question")
  .option("--detail <text>", "Current activity detail (tool name, filename, etc.)")
  .option("--clear-detail", "Clear any previously reported activity detail")
  .option("--intent <text>", "Current user intent/prompt summary")
  .option("--clear-intent", "Clear any previously reported intent")
  .option("--response-preview <text>", "Beginning of the latest assistant response")
  .option("--clear-response-preview", "Clear any previously reported response preview")
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
      const paneMetadata = readTmuxPaneReportMetadata(session);
      const foregroundAgent = paneMetadata?.foregroundCommand
        ? detectAgentProcess(paneMetadata.foregroundCommand, paneMetadata.foregroundCommand) || undefined
        : undefined;
      const bindingInput = {
        requestedSession: session,
        reportedAgent: opts.agent,
        paneCwd: paneMetadata?.paneCwd,
        paneOwner: paneMetadata?.paneOwner,
        commandId: paneMetadata?.commandId,
        commandContentKind: paneMetadata?.commandContentKind,
        commandOwner: paneMetadata?.commandOwner,
        foregroundAgent,
      };
      const liveAgent = requiresTmuxReportProcessScan(bindingInput)
        ? scan({ requireProcess: true }).find((pane) => pane.tmuxPaneId === session)?.agent
        : undefined;
      const binding = resolveTmuxReportBinding({ ...bindingInput, liveAgent });
      if (!binding.owned) return;

      if (binding.paneCwd) {
        wsSnapshot = { command: opts.agent, cwd: binding.paneCwd, mux: "tmux" };
        backfillTmuxPaneCommandMetadata(session, {
          agent: opts.agent,
          command: opts.agent,
          launchCommand: tmuxPaneBackfillLaunchCommand(opts.agent, paneMetadata?.commandLaunch),
          cwd: binding.paneCwd,
        });
      }
    } else if (muxKind === "zellij" && process.env.PWD) {
      wsSnapshot = { command: opts.agent, cwd: process.env.PWD, mux: "zellij" };
    }

    const externalSessionId = opts.externalSessionId as string | undefined;
    if (externalSessionId && muxKind === "tmux" && session?.startsWith("%") && wsSnapshot?.cwd) {
      const restoreArgv = resolveAgentRestoreArgv({
        agent: opts.agent,
        cwd: wsSnapshot.cwd,
        originalArgv: [opts.agent],
        externalSessionId,
      });
      updateTmuxPaneCommandLaunch(session, restoreArgv ? renderCommand(restoreArgv) : undefined, wsSnapshot.cwd);
    }

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
        intent: opts.intent,
        clearIntent: !!opts.clearIntent,
      });
    } else if (opts.state && opts.auxiliary) {
      reportContributorState(opts.agent, session, opts.reporter, opts.state, {
        ...(opts.detail ? { detail: opts.detail } : {}),
      });
    } else if (opts.state) {
      reportState(opts.agent, session, opts.state, {
        detail: opts.detail,
        clearDetail: !!opts.clearDetail,
        intent: opts.intent,
        clearIntent: !!opts.clearIntent,
        responsePreview: opts.responsePreview,
        clearResponsePreview: !!opts.clearResponsePreview,
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
