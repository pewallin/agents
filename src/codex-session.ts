import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { splitCommandArgv } from "./agent-restore.js";
import { spawnSync } from "child_process";
import { execFileInheritUntilExit, spawnBackgroundLogged, type ManagedBackgroundProcess } from "./shell.js";
import { getSelfArgv } from "./paths.js";

export interface CodexSessionProcessPlan {
  executable: string;
  args: string[];
}

export interface CodexSessionLaunchPlan {
  endpointMetadataPath: string;
  logPath: string;
  server: CodexSessionProcessPlan;
  /** The TUI on this pane's app-server; --remote and its endpoint go first when it starts. */
  tui: CodexSessionProcessPlan;
  /**
   * The TUI on its own, for a pane whose app-server did not start. It gets --no-daemon where the
   * Codex has it, so it never runs on the shared daemon with another pane's environment.
   */
  plainTui: CodexSessionProcessPlan;
  /** The ACP view's mode for the command's permissions (codex-acp INITIAL_AGENT_MODE). */
  viewMode?: string;
  /** A resumed thread's permissions from the command, given to it on the app-server first. */
  resumePermissions?: { threadId: string; approvalPolicy?: string; sandbox?: string };
}

export interface CodexSessionLaunchInput {
  command: string;
  paneId: string;
  runtimeTempDir: string;
  processId: number;
  /** Whether this Codex has --no-daemon; asked of `codex --help` when it is not given. */
  supportsNoDaemon?: boolean;
}

export interface PaneLocalCodexSessionInput extends CodexSessionLaunchInput {
  environment: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  /**
   * Starts the pane's ACP view (`agents acp-session --agent codex-acp`) beside its app-server,
   * warm, so the view opens without starting anything. Defaults to this CLI; null leaves it out.
   */
  acpHostArgv?: string[] | null;
}

export interface PaneLocalCodexSessionResult {
  status: number;
  signal: NodeJS.Signals | null;
  endpointMetadataRemoved: boolean;
  logPath: string;
  /** False when the app-server did not start and Codex ran without one. */
  appServer: boolean;
}

function socketStem(paneId: string): string {
  const normalized = paneId.trim().replace(/^%/, "pane-").replace(/[^A-Za-z0-9._-]/g, "-");
  return normalized || "pane-unknown";
}

export function createCodexSessionLaunchPlan(input: CodexSessionLaunchInput): CodexSessionLaunchPlan {
  const argv = splitCommandArgv(input.command);
  const executable = argv[0];
  if (basename(executable).toLowerCase() !== "codex") {
    throw new Error("Codex session command must start with the Codex executable");
  }

  const directory = join(input.runtimeTempDir, "codex-app-server");
  const stem = socketStem(input.paneId);
  const endpointMetadataPath = join(directory, `${stem}.json`);
  const logPath = join(directory, `${stem}-${input.processId}.log`);

  // This command picks how the TUI runs, so the configured command's own choice goes: Codex refuses
  // --no-daemon beside --remote, and a --remote inherited from another pane is that pane's server.
  const args = withoutCodexServerOptions(argv.slice(1));
  const supportsNoDaemon = input.supportsNoDaemon ?? codexSupportsNoDaemon(executable);
  // Codex refuses permission options on a TUI that resumes over --remote ("Permission overrides
  // are not supported when resuming a remote task", codex 0.166): the pane's app-server takes them
  // as its config, so the session runs as the command asked, in the TUI and in the ACP view.
  const permissions = codexPermissionOptions(args);

  return {
    endpointMetadataPath,
    logPath,
    server: {
      executable,
      args: ["app-server", ...permissions.serverConfig, "--listen", "ws://127.0.0.1:0"],
    },
    tui: { executable, args: isCodexResume(args) ? permissions.rest : args },
    plainTui: { executable, args: supportsNoDaemon ? ["--no-daemon", ...args] : args },
    viewMode: codexAcpMode(permissions.approvalPolicy, permissions.sandboxMode),
    resumePermissions: permissions.serverConfig.length > 0 && resumedThreadId(args)
      ? { threadId: resumedThreadId(args)!, approvalPolicy: permissions.approvalPolicy, sandbox: permissions.sandboxMode }
      : undefined,
  };
}

/** The ACP view's mode for a command's permissions (codex-acp's INITIAL_AGENT_MODE), so a turn
 *  the view starts runs as the TUI's do; none for the default (Auto review). */
export function codexAcpMode(approvalPolicy: string | undefined, sandboxMode: string | undefined): string | undefined {
  if (sandboxMode === "danger-full-access" && (approvalPolicy === "never" || approvalPolicy === undefined)) return "agent-full-access";
  if (sandboxMode === "read-only") return "read-only";
  if (sandboxMode === "workspace-write" && approvalPolicy === "on-request") return "workspace-write";
  return undefined;
}

/** The thread a `codex ... resume <id>` command resumes; none for `resume --last` or a picker. */
export function resumedThreadId(args: string[]): string | undefined {
  const end = args.indexOf("--");
  const head = end < 0 ? args : args.slice(0, end);
  const at = head.indexOf("resume");
  if (at < 0) return undefined;
  return head.slice(at + 1).find((arg) => !arg.startsWith("-"));
}

/** Whether a Codex command resumes a session (`codex ... resume ...`). */
export function isCodexResume(args: string[]): boolean {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).includes("resume");
}

const PERMISSION_CONFIG_KEYS = new Set(["approval_policy", "sandbox_mode"]);

/**
 * A Codex command's permission options, as app-server config (`-c key=value`), and the command
 * without them: --dangerously-bypass-approvals-and-sandbox (--yolo), --full-auto,
 * -a/--ask-for-approval, -s/--sandbox, and -c approval_policy=/sandbox_mode=.
 */
export function codexPermissionOptions(args: string[]): {
  serverConfig: string[];
  rest: string[];
  approvalPolicy?: string;
  sandboxMode?: string;
} {
  const config = new Map<string, string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  const set = (key: string, value: string) => {
    const plain = value.replace(/^["']|["']$/g, "");
    values.set(key, plain);
    config.set(key, `${key}=${JSON.stringify(plain)}`);
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      rest.push(...args.slice(index));
      break;
    }
    if (arg === "--dangerously-bypass-approvals-and-sandbox" || arg === "--yolo") {
      set("approval_policy", "never");
      set("sandbox_mode", "danger-full-access");
      continue;
    }
    if (arg === "--full-auto") {
      set("approval_policy", "on-request");
      set("sandbox_mode", "workspace-write");
      continue;
    }
    const valued: Array<[string[], string]> = [[["-a", "--ask-for-approval"], "approval_policy"], [["-s", "--sandbox"], "sandbox_mode"]];
    let taken = false;
    for (const [names, key] of valued) {
      const inline = names.find((name) => name.startsWith("--") && arg.startsWith(`${name}=`));
      if (inline) {
        set(key, arg.slice(inline.length + 1));
        taken = true;
      } else if (names.includes(arg) && args[index + 1] !== undefined) {
        set(key, args[index + 1]);
        index += 1;
        taken = true;
      }
    }
    if (taken) continue;
    if ((arg === "-c" || arg === "--config") && args[index + 1] !== undefined) {
      const [key, ...value] = args[index + 1].split("=");
      if (PERMISSION_CONFIG_KEYS.has(key.trim()) && value.length > 0) {
        set(key.trim(), value.join("=").trim());
        index += 1;
        continue;
      }
    }
    rest.push(arg);
  }
  return {
    serverConfig: [...config.values()].flatMap((value) => ["-c", value]),
    rest,
    approvalPolicy: values.get("approval_policy"),
    sandboxMode: values.get("sandbox_mode"),
  };
}

const CODEX_SERVER_OPTIONS_WITH_VALUE = new Set(["--remote", "--remote-auth-token-env"]);

export function withoutCodexServerOptions(args: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      output.push(...args.slice(index));
      break;
    }
    if (arg === "--no-daemon") continue;
    if (CODEX_SERVER_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if ([...CODEX_SERVER_OPTIONS_WITH_VALUE].some((option) => arg.startsWith(`${option}=`))) continue;
    output.push(arg);
  }
  return output;
}

// A Codex from before the shared daemon has no --no-daemon and refuses it.
function codexSupportsNoDaemon(executable: string): boolean {
  const help = spawnSync(executable, ["--help"], { encoding: "utf8", timeout: 5_000 });
  return help.status === 0 && /--no-daemon\b/.test(help.stdout || "");
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readListeningEndpoint(logPath: string): string | undefined {
  try {
    const match = readFileSync(logPath, "utf8").match(/listening on:\s*(ws:\/\/127\.0\.0\.1:\d+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function writeEndpointMetadata(path: string, url: string, processId: number): void {
  const temporaryPath = `${path}.${processId}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ url, processId }));
  renameSync(temporaryPath, path);
}

function removeOwnedEndpointMetadata(path: string, processId: number): void {
  try {
    const metadata = JSON.parse(readFileSync(path, "utf8")) as { processId?: unknown };
    if (metadata.processId === processId) rmSync(path, { force: true });
  } catch {
    // Preserve unreadable metadata in case another process replaced it.
  }
}

export function runPaneLocalCodexSession(input: PaneLocalCodexSessionInput): PaneLocalCodexSessionResult {
  const plan = createCodexSessionLaunchPlan(input);
  const startupTimeoutMs = input.startupTimeoutMs ?? 5_000;
  mkdirSync(dirname(plan.endpointMetadataPath), { recursive: true });
  rmSync(plan.endpointMetadataPath, { force: true });
  rmSync(plan.logPath, { force: true });

  const server = spawnBackgroundLogged(plan.server.executable, plan.server.args, {
    env: input.environment,
    logPath: plan.logPath,
  });

  let endpoint: string | undefined;
  try {
    endpoint = waitForListeningEndpoint(server, plan.logPath, startupTimeoutMs);
  } catch (error) {
    // The agent matters more than its web view: Codex starts without an app-server, as it would
    // have without this command, and only the ACP view is unavailable in this pane.
    server.terminate();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`The ACP view is unavailable in this pane: ${message}. Starting Codex without it.`);
    const result = execFileInheritUntilExit(plan.plainTui.executable, plan.plainTui.args, input.environment);
    if (result.error) throw result.error;
    return {
      status: result.status,
      signal: result.signal,
      endpointMetadataRemoved: !existsSync(plan.endpointMetadataPath),
      logPath: plan.logPath,
      appServer: false,
    };
  }

  let tuiStatus = 1;
  let tuiSignal: NodeJS.Signals | null = null;
  let acpHost: ManagedBackgroundProcess | undefined;
  try {
    writeEndpointMetadata(plan.endpointMetadataPath, endpoint, input.processId);
    // A resumed thread takes the command's permissions from its app-server: the TUI may not give
    // them when it resumes over --remote. Resumed here with them, the TUI finds them on the thread.
    if (plan.resumePermissions) resumeWithPermissions(input, plan, endpoint);
    acpHost = startAcpHost(input, plan, endpoint);

    const result = execFileInheritUntilExit(
      plan.tui.executable,
      ["--remote", endpoint, ...plan.tui.args],
      input.environment,
    );
    if (result.error) throw result.error;
    tuiStatus = result.status;
    tuiSignal = result.signal;
  } finally {
    acpHost?.terminate();
    server.terminate();
    removeOwnedEndpointMetadata(plan.endpointMetadataPath, input.processId);
  }
  return {
    status: tuiStatus,
    signal: tuiSignal,
    endpointMetadataRemoved: !existsSync(plan.endpointMetadataPath),
    logPath: plan.logPath,
    appServer: true,
  };
}

/** Resumes the thread on the pane's app-server with the command's permissions (`agents
 *  codex-thread-settings`); a failure leaves the thread as it was, logged beside the server's. */
function resumeWithPermissions(input: PaneLocalCodexSessionInput, plan: CodexSessionLaunchPlan, endpoint: string): void {
  const argv = input.acpHostArgv === undefined ? getSelfArgv() : input.acpHostArgv;
  const settings = plan.resumePermissions;
  if (!argv || argv.length === 0 || !settings) return;
  const result = spawnSync(argv[0], [
    ...argv.slice(1), "codex-thread-settings", "--app-server", endpoint, "--thread", settings.threadId,
    ...(settings.approvalPolicy ? ["--approval", settings.approvalPolicy] : []),
    ...(settings.sandbox ? ["--sandbox", settings.sandbox] : []),
  ], { env: input.environment, encoding: "utf8", timeout: 20_000 });
  try {
    appendFileSync(plan.logPath, `codex-thread-settings ${settings.threadId}: ${result.status === 0 ? "ok" : `failed (${result.status ?? result.signal}) ${(result.stderr || result.stdout || "").trim()}`}\n`);
  } catch {}
}

/** The pane's ACP view: optional, so nothing about Codex depends on it starting. */
function startAcpHost(
  input: PaneLocalCodexSessionInput,
  plan: CodexSessionLaunchPlan,
  endpoint: string,
): ManagedBackgroundProcess | undefined {
  if (input.environment.AGENTS_ACP_HOST === "0") return undefined;
  const argv = input.acpHostArgv === undefined ? getSelfArgv() : input.acpHostArgv;
  if (!argv || argv.length === 0) return undefined;
  try {
    return spawnBackgroundLogged(
      argv[0],
      [...argv.slice(1), "acp-session", "--agent", "codex-acp", "--pane", input.paneId, "--app-server", endpoint, "--cwd", process.cwd()],
      {
        env: plan.viewMode ? { ...input.environment, INITIAL_AGENT_MODE: plan.viewMode } : input.environment,
        logPath: plan.logPath.replace(/\.log$/, "-acp-session.log"),
      },
    );
  } catch {
    return undefined;
  }
}

function waitForListeningEndpoint(
  server: ManagedBackgroundProcess,
  logPath: string,
  timeoutMs: number,
): string {
  const deadline = Date.now() + timeoutMs;
  let endpoint: string | undefined;
  while (!(endpoint = readListeningEndpoint(logPath))) {
    if (server.error) throw server.error;
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Codex app-server exited before its endpoint was ready. Log: ${logPath}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Codex app-server. Log: ${logPath}`);
    }
    sleepSync(25);
  }
  return endpoint;
}
