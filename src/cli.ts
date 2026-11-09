#!/usr/bin/env node
import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ModelSource } from "./state.js";
import type { AgentDoneRecordInput } from "./done.js";
import { switchBack } from "./back.js";
import { getBuildInfo, getSelfArgv } from "./paths.js";
import { insideTmux } from "./tmux-env.js";
import {
  runCodexAppServerWebSocketProxy,
  shouldRunCodexAppServerProxy,
} from "./codex-app-server-proxy.js";

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
  const build = getBuildInfo();
  if (build) {
    if (!build.gitCommit) return build.version;
    return `${build.version}+${build.gitCommit.slice(0, 12)}${build.dirty ? "-dirty" : ""}`;
  }
  const packageRoot = findPackageRoot();
  const version = readPackageVersion(packageRoot);
  const revision = readGitRevision(packageRoot);
  return revision ? `${version}+${revision}` : version;
}

const args = process.argv.slice(2);
const firstArg = args[0] || "";

// codex-acp runs CODEX_PATH (this CLI in a Codex pane) with config flags followed by
// `app-server`. In the pane-local configuration, agents bridges that stdio process to the
// pane's already-running WebSocket app-server, so the ACP view shares the TUI's thread.
if (shouldRunCodexAppServerProxy(args, process.env)) {
  process.exit(await runCodexAppServerWebSocketProxy());
}

// An agent pane's ACP web view: the host (`acp-session`, which codex-session starts for Codex)
// and the bundled adapters (Codex, Claude) it starts per client. Neither needs the rest of the CLI, and an
// adapter's stdout is its protocol channel.
if (firstArg === "codex-acp") {
  await (await import("./acp-host-cli.js")).runCodexAcpAgent();
}
if (firstArg === "claude-acp") {
  await (await import("./acp-host-cli.js")).runClaudeAcpAgent();
}
if (firstArg === "acp-restart") {
  const { runAcpRestart } = await import("./acp-restart.js");
  const agentsHome = process.env.AGENTS_HOME || join(process.env.HOME || "", ".agents", "agents-app");
  process.exit(await runAcpRestart(args.slice(1), process.env.AGENTS_TMP_DIR || join(agentsHome, "runtime", "tmp")));
}
if (firstArg === "acp-host-supervise") {
  process.exit(await (await import("./acp-host-supervisor.js")).runHostSupervisor(args.slice(1)));
}
if (firstArg === "acp-restart-host") {
  const agentsHome = process.env.AGENTS_HOME || join(process.env.HOME || "", ".agents", "agents-app");
  process.exit(await (await import("./acp-restart-host.js")).runAcpRestartHost(args.slice(1), process.env.AGENTS_TMP_DIR || join(agentsHome, "runtime", "tmp")));
}
if (firstArg === "codex-thread-settings") {
  const value = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const appServer = value("--app-server");
  const thread = value("--thread");
  if (!appServer || !thread) {
    console.error("codex-thread-settings needs --app-server and --thread");
    process.exit(2);
  }
  try {
    await (await import("./codex-current-thread.js")).codexResumeWithPermissions(appServer, thread, { approvalPolicy: value("--approval"), sandbox: value("--sandbox") });
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
if (firstArg === "acp-prompt") {
  const { runAcpPrompt } = await import("./acp-host-cli.js");
  const agentsHome = process.env.AGENTS_HOME || join(process.env.HOME || "", ".agents", "agents-app");
  process.exit(await runAcpPrompt(args.slice(1), process.env.AGENTS_TMP_DIR || join(agentsHome, "runtime", "tmp")));
}
// The agents with an ACP view and how each gets it (agent-registry.ts), for Agents Next and its
// agents-app-control, which keep no table of their own.
if (firstArg === "acp-agents") {
  const { ACP_VIEW_AGENTS } = await import("./agent-registry.js");
  console.log(JSON.stringify({ agents: ACP_VIEW_AGENTS }));
  process.exit(0);
}
// An agent's TUI command under the wrapper of its ACP view (codex-session or acp-session --tui),
// printed for a launcher to run: as it is for a command of no agent with a view.
if (firstArg === "agent-launch") {
  const at = args.indexOf("--command");
  const command = at >= 0 ? args[at + 1] : undefined;
  if (!command) {
    console.error("agent-launch needs --command <the agent's command>");
    process.exit(2);
  }
  const { agentLaunchCommand } = await import("./agent-registry.js");
  console.log(agentLaunchCommand(command, getSelfArgv()));
  process.exit(0);
}
// Changes no agent made, shown in the ACP view's review (Agents Next's Changes panel).
if (firstArg === "review") {
  process.exit(await (await import("./review-server.js")).runReviewCommand(args.slice(1)));
}
if (firstArg === "review-server") {
  const { acpViewRoot } = await import("./acp-host-cli.js");
  await (await import("./review-server.js")).runReviewServer(acpViewRoot());
  await new Promise(() => {});
}
if (firstArg === "acp-session") {
  const { runAcpSessionCommand } = await import("./acp-host-cli.js");
  const agentsHome = process.env.AGENTS_HOME || join(process.env.HOME || "", ".agents", "agents-app");
  await runAcpSessionCommand(args.slice(1), process.env.AGENTS_TMP_DIR || join(agentsHome, "runtime", "tmp"));
}

// Fast path: `agents back` should feel instant and does not need Commander/Ink.
if (args.length === 1 && firstArg === "back" && insideTmux()) {
  process.exit(switchBack() ? 0 : 1);
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
  codexSessionMod,
  codexSharedAppServer,
  sessionHolders,
  scannerHistory,
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
  import("./codex-session.js"),
  import("./codex-shared-app-server.js"),
  import("./session-holders.js"),
  import("./scanner-history.js"),
]);

const { Command } = commander;
const { scan, runtimeStates, getSessionHistory, detectAgentProcess, externalSessionIdFromProcessArgs } = scanner;
const { createAppBundle } = bundleMod;
const { markOpenElsewhere, describeHolder } = sessionHolders;
const { sessionTranscriptPath } = scannerHistory;
const { reportState, reportContext, reportContributorState, clearPrimaryState, getAgentStateEntry } = state;
const { setup, uninstall, autoSetupIfNeeded, doctor, probeHooks, shadowingAgentsOnPath, hookRuntimeOwner, setupMcpServer, uninstallMcpServer, doctorMcpServer } = setupMod;
const hookLogHint = () => "logs/hooks.log in the agents home";
const { createWorkspace } = workspace;
const { getProfileNames, resolveProfile } = config;
const { resumeAgentSession } = resumeMod;
const { backfillTmuxPaneCommandMetadata, readTmuxPaneCommandLaunch, readTmuxPaneIndex, readTmuxPaneReportMetadata, setTmuxPaneCommandMetadata, setTmuxPaneRestoredAgentMetadata, tmuxPaneBackfillLaunchCommand, updateTmuxPaneCommandLaunch } = tmuxPaneMetadata;
const { requiresTmuxReportProcessScan, resolveTmuxReportBinding } = reportBinding;
const {
  normalizeTmuxResurrectFile,
  resolveAgentRestoreArgv,
  renderCommand,
  claimCodexRestoreLaunchDelayMs,
  applyTmuxResurrectMetadataLaunchesFile,
  reconcileTmuxResurrectLegacyMetadata,
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
const { runPaneLocalCodexSession } = codexSessionMod;

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

function reconcileResurrectMetadata(metadataFile: string, opts: { json?: boolean }): void {
  const result = reconcileTmuxResurrectLegacyMetadata(
    readFileSync(metadataFile, "utf8"),
    scan({ requireProcess: true }).map((pane) => ({
      ...pane,
      paneIndex: readTmuxPaneIndex(pane.tmuxPaneId),
    })),
  );
  const failed: string[] = [];
  for (const repair of result.repairs) {
    const ok = setTmuxPaneRestoredAgentMetadata(repair.paneID, {
      agent: repair.agent,
      command: repair.launchCommand,
      launchCommand: repair.launchCommand,
      cwd: repair.cwd,
    });
    if (!ok) failed.push(repair.paneID);
  }
  if (failed.length === 0 && result.repairs.length > 0) {
    writeFileSync(metadataFile, result.content);
  }
  const summary = { repaired: result.repairs.length - failed.length, failed };
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(summary.repaired);
  if (failed.length > 0) process.exitCode = 1;
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

function runtimePaneProvenanceWarnings(): Map<string, string[]> {
  const warnings = new Map<string, string[]>();
  for (const pane of scan({ requireProcess: true })) {
    const agent = pane.agent.toLowerCase().replace(/[^a-z]/g, "");
    const metadata = readTmuxPaneReportMetadata(pane.tmuxPaneId);
    const foregroundAgent = metadata?.foregroundCommand
      ? detectAgentProcess(metadata.foregroundCommand, metadata.foregroundCommand) || undefined
      : undefined;
    const binding = resolveTmuxReportBinding({
      requestedSession: pane.tmuxPaneId,
      reportedAgent: agent,
      paneCwd: metadata?.paneCwd,
      paneOwner: metadata?.paneOwner,
      commandId: metadata?.commandId,
      commandContentKind: metadata?.commandContentKind,
      commandOwner: metadata?.commandOwner,
      liveAgent: agent,
      foregroundAgent,
    });
    if (binding.owned) continue;
    const list = warnings.get(agent) || [];
    list.push(`pane ${pane.tmuxPaneId} has a live ${agent} process but lacks verified ownership metadata`);
    warnings.set(agent, list);
  }
  return warnings;
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
  const [reactMod, ink, selectMod, agentTableMod] = await Promise.all([
    import("react"),
    import("ink"),
    import("./components/Select.js"),
    import("./components/AgentTable.js"),
  ]);
  return {
    React: reactMod.default,
    render: ink.render,
    Select: selectMod.Select,
    AgentTable: agentTableMod.AgentTable,
  };
}

// Auto-setup in background if hook config changed since last run
if (!["setup", "uninstall"].includes(firstArg)) autoSetupIfNeeded();

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
    // With a pane: each session another pane has open says where (openIn), to go there instead.
    if (opts.pane) markOpenElsewhere(groups, scan());
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
        const elsewhere = session.openIn ? `  (open in ${describeHolder(session.openIn)})` : "";
        console.log(`${marker} ${formatTs(session.updatedAt)}${model}  ${session.title}${elsewhere}`);
      }
    }
  });

program
  .command("session-file")
  .description("Print the transcript file an agent's harness keeps of a session")
  .requiredOption("--agent <name>", "Agent (claude, codex, pi, kiro)")
  .requiredOption("--session <id>", "The agent's session id")
  .option("--json", "Output as JSON ({ file } or { file: null })")
  .action((opts) => {
    const file = sessionTranscriptPath(opts.agent, opts.session);
    if (opts.json) {
      console.log(JSON.stringify({ file: file ?? null }));
      return;
    }
    if (!file) process.exit(1);
    console.log(file);
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
  .option("--force", "Resume even if the live agent is not idle or the session is open in another pane")
  .option("--open-in <where>", "Where Agents Next shows the resumed agent: acp-view or terminal")
  .option("--json", "Output as JSON")
  .action((opts) => {
    if (opts.openIn !== undefined && opts.openIn !== "acp-view" && opts.openIn !== "terminal") {
      console.error("--open-in is acp-view or terminal");
      process.exit(2);
    }
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
      openIn: opts.openIn,
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

program
  .command("codex-session")
  .description("Run Codex through a pane-local app server")
  .requiredOption("--command <command>", "Configured Codex command")
  .action((opts) => {
    const paneId = process.env.TMUX_PANE?.trim();
    if (!paneId?.startsWith("%")) {
      console.error("codex-session requires a tmux pane");
      process.exit(1);
    }

    try {
      const result = runPaneLocalCodexSession({
        command: opts.command,
        paneId,
        runtimeTempDir: agentsRuntimeTempDir(),
        processId: process.pid,
        environment: process.env,
      });
      if (result.signal) {
        process.kill(process.pid, result.signal);
        return;
      }
      process.exit(result.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Could not start pane-local Codex: ${message}`);
      process.exit(1);
    }
  });

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
  .command("reconcile-metadata")
  .description("Repair verified legacy pane provenance after tmux-resurrect restore")
  .argument("<metadataFile>", "Agents pane metadata sidecar path")
  .option("--json", "Output as JSON")
  .action((metadataFile: string, opts) => {
    reconcileResurrectMetadata(metadataFile, opts);
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
  .option("--state <state>", "State: working, idle, approval, question, exited (the agent left the pane)")
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
  .option("--spend <n>", "Session spend so far, in --spend-unit", parseFloat)
  .option("--spend-unit <unit>", "Unit of --spend, e.g. AIU or credits")
  .option("--reporter <id>", "Auxiliary reporter identity for contributor state")
  .option("--auxiliary", "Write an auxiliary contributor state instead of the primary session state")
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
    // Workspace snapshot is seeded at creation time by createWorkspace().
    // Here we only build a fallback for agents started manually (not via `agents ws` or `n`).
    // Existing workspace data is never overwritten — reportState preserves it.
    let wsSnapshot: undefined | { command: string; cwd: string; mux?: "tmux" };
    const inTmux = insideTmux();
    const externalSessionId = opts.externalSessionId as string | undefined;
    if (inTmux && opts.agent?.trim().toLowerCase() === "codex" && session?.startsWith("%")) {
      const shared = codexSharedAppServer.resolveCodexSharedAppServerReport();
      if (shared.shared) {
        if (!shared.pane) {
          reportBinding.logRejectedSharedAppServerReport(session, shared.clients);
          return;
        }
        session = shared.pane;
      }
    }
    if (inTmux && session?.startsWith("%")) {
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
        reportedExternalSessionId: externalSessionId,
        expectedExternalSessionId: externalSessionIdFromProcessArgs(opts.agent, paneMetadata?.commandLaunch)
          ?? getAgentStateEntry(opts.agent, session)?.externalSessionId,
        foregroundAgent,
      };
      const liveAgent = requiresTmuxReportProcessScan(bindingInput)
        ? scan({ requireProcess: true, excludeProcessIDs: [process.pid], reporterProcessID: process.pid })
          .find((pane) => pane.tmuxPaneId === session)?.agent
        : undefined;
      const binding = resolveTmuxReportBinding({ ...bindingInput, liveAgent });
      if (!binding.owned) {
        reportBinding.logRejectedReport({ ...bindingInput, liveAgent });
        return;
      }

      if (binding.paneCwd) {
        wsSnapshot = { command: opts.agent, cwd: binding.paneCwd, mux: "tmux" };
        backfillTmuxPaneCommandMetadata(session, {
          agent: opts.agent,
          command: opts.agent,
          launchCommand: tmuxPaneBackfillLaunchCommand(opts.agent, paneMetadata?.commandLaunch),
          cwd: binding.paneCwd,
        });
      }
    }

    if (externalSessionId && inTmux && session?.startsWith("%") && wsSnapshot?.cwd) {
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
    const spend = typeof opts.spend === "number" && Number.isFinite(opts.spend) ? opts.spend : undefined;
    const spendUnit = spend !== undefined ? opts.spendUnit as string | undefined : undefined;
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
    } else if (opts.state === "exited") {
      clearPrimaryState(opts.agent, session);
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
        spend,
        spendUnit,
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
  .option("--mcp", "Register the agents MCP server of Agents Next instead of the hooks")
  .action((opts) => {
    const results = opts.mcp ? setupMcpServer() : setup(opts.quiet);
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
  .option("--mcp", "Remove the agents MCP server instead of the hooks")
  .action((opts) => {
    const results = opts.mcp ? uninstallMcpServer() : uninstall();
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
  .option("--mcp", "Report the agents MCP server per harness instead of the hooks")
  .action((opts) => {
    if (opts.mcp) {
      const results = doctorMcpServer();
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      for (const result of results) {
        const allowed = result.allowed === undefined ? "" : result.allowed ? "  allowed" : "  asks first";
        console.log(`${result.agent}  ${result.registered}${allowed}  ${result.reachable ? "reachable" : "command missing"}${result.detail ? ` (${result.detail})` : ""}`);
      }
      return;
    }
    const provenanceWarnings = runtimePaneProvenanceWarnings();
    const results = doctor().map((result) => {
      const supplemental = [
        ...(result.supplemental || []),
        ...(provenanceWarnings.get(result.agent) || []),
      ];
      return supplemental.length ? { ...result, supplemental } : result;
    });
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
      for (const warning of result.supplemental || []) console.log(`  warning: ${warning}`);
    }

    // The hooks above only help if a report can actually run where the agents run them.
    const probe = probeHooks();
    const describe = (lines: string[]) => lines.map((line) => {
      const [status, node, ...rest] = line.split(" ");
      return status === "ok" ? `ok (${node})` : `failed ${node}: ${rest.join(" ")}`;
    });
    console.log("hooks runtime");
    console.log(`  owner: ${hookRuntimeOwner() ?? "none (run agents setup)"}`);
    console.log(`  this shell: ${describe(probe.shellEnvironment).join("; ")}`);
    console.log(`  bare PATH: ${describe(probe.minimalEnvironment).join("; ")}`);
    const usable = (lines: string[]) => lines.some((line) => line.startsWith("ok "));
    if (!usable(probe.minimalEnvironment)) {
      console.log("  warning: agents started without your shell's PATH cannot report; run `agents setup` from a working node");
    }
    const shadowing = shadowingAgentsOnPath(agentsVersion());
    if (shadowing) {
      console.log(`  warning: \`agents\` on PATH is ${shadowing.path} (${shadowing.version}), not this CLI (${agentsVersion()})`);
    }
    if (probe.recentErrors.length) {
      console.log(`  recent hook failures (${hookLogHint()}):`);
      for (const line of probe.recentErrors) console.log(`    ${line}`);
    } else {
      console.log("  recent hook failures: none");
    }
  });

if (args.length === 0) {
  program.help();
} else {
  program.parse();
}
