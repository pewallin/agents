import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { codexReasoningEffortForSession } from "./scanner-history.js";
import { loadConfig, resolveProfile, type CommandConfigEntry } from "./config.js";
import { readStates, type StateEntry } from "./state.js";
import { getRuntimeTempDir } from "./paths.js";

export interface AgentRestoreCommandOptions {
  agent: string;
  cwd?: string;
  originalArgv?: string[];
  originalCommand?: string;
  externalSessionId?: string;
}

export interface TmuxResurrectMetadataCaptureInput {
  tmuxPaneId: string;
  agent: string;
  cwd?: string;
  externalSessionId?: string;
  commandLaunch?: string;
}

export interface TmuxResurrectMetadataCapture {
  paneID: string;
  agent: string;
  cwd: string;
  launchCommand: string;
}

export function splitCommandArgv(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      argv.push(current);
      current = "";
    }
  };

  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        escaping = true;
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    current += ch;
  }

  if (escaping) throw new Error("Invalid command: trailing escape");
  if (quote) throw new Error("Invalid command: unterminated quote");
  pushCurrent();
  if (argv.length === 0) throw new Error("No command specified");
  return argv;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shellQuoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : shellQuote(value);
}

export function renderCommand(argv: string[]): string {
  return argv.map(shellQuoteIfNeeded).join(" ");
}

const AMBIGUOUS_LAST_CLAIM_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CODEX_RESTORE_STAGGER_MS = 1500;
const CODEX_RESTORE_STAGGER_LOCK_WAIT_MS = 5000;
const CODEX_RESTORE_STAGGER_LOCK_STALE_MS = 15000;
const CODEX_RESTORE_STAGGER_MAX_FUTURE_MS = 2 * 60 * 1000;
const SHELL_COMMAND_NAMES = new Set(["$shell", "bash", "fish", "login", "nu", "sh", "tmux", "zsh"]);
const AGENT_COMMAND_NAMES = new Set(["claude", "codex", "copilot", "kiro", "kiro-cli", "kiro-cli-chat", "opencode", "pi"]);

function tokenBasename(token: string): string {
  return basename(token.replace(/^['"]+|['"]+$/g, "")).replace(/^-/, "").toLowerCase();
}

function normalizeAgentName(agent: string): string {
  const normalized = tokenBasename(agent);
  if (normalized === "kiro-cli" || normalized === "kiro-cli-chat") return "kiro";
  return normalized;
}

function isShellCommandName(value: string | undefined): boolean {
  return SHELL_COMMAND_NAMES.has(tokenBasename(value || ""));
}

function isAgentCommandName(value: string | undefined): boolean {
  return AGENT_COMMAND_NAMES.has(tokenBasename(value || ""));
}

function commandArgv(command: string): string[] {
  try {
    return splitCommandArgv(command);
  } catch {
    return command.trim().split(/\s+/).filter(Boolean);
  }
}

function executableTokens(command: string): string[] {
  const argv = commandArgv(command);
  const tokens: string[] = [];
  let skipNext = false;
  for (const token of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token === "-u" || token === "--unset") {
      skipNext = true;
      continue;
    }
    if (token.startsWith("-")) continue;
    tokens.push(token);
  }
  return tokens;
}

function firstExecutableToken(command: string): string | undefined {
  return executableTokens(command)[0];
}

function firstAgentToken(command: string): string | undefined {
  return executableTokens(command).find(isAgentCommandName);
}

function commandEnvironmentPrefix(environment?: Record<string, string>): string {
  const assignments = Object.keys(environment || {})
    .sort()
    .flatMap((key) => {
      const value = environment?.[key];
      if (value === undefined) return [];
      return [`${key}=${value}`];
    });
  return assignments.length ? `env ${assignments.map(shellQuoteIfNeeded).join(" ")} ` : "";
}

function renderConfiguredCommand(command: string, environment?: Record<string, string>): string {
  return `${commandEnvironmentPrefix(environment)}${command}`.trim();
}

function isShellishFullCommand(command: string | undefined): boolean {
  const trimmed = (command || "").replace(/^:/, "").trim();
  if (!trimmed) return true;
  return isShellCommandName(firstExecutableToken(trimmed));
}

function agentIndex(argv: string[], agent: string): number {
  const normalized = normalizeAgentName(agent);
  return argv.findIndex((token) => normalizeAgentName(token) === normalized);
}

function optionsWithValues(agent: string): Set<string> {
  switch (agent.toLowerCase()) {
    case "codex":
      return new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "--cd", "--cwd", "--sandbox", "--ask-for-approval", "--approval-policy", "--model-provider"]);
    case "opencode":
      return new Set(["--prompt", "--session"]);
    case "pi":
      return new Set([
        "--provider",
        "--model",
        "--api-key",
        "--system-prompt",
        "--append-system-prompt",
        "--mode",
        "--session",
        "--session-id",
        "--fork",
        "--session-dir",
        "--name",
        "-n",
        "--models",
        "--tools",
        "-t",
        "--exclude-tools",
        "-xt",
        "--thinking",
        "--extension",
        "-e",
        "--skill",
        "--prompt-template",
        "--theme",
        "--export",
      ]);
    default:
      return new Set(["--resume", "--session"]);
  }
}

function explicitTargetFromArgs(agent: string, argv: string[]): string | undefined {
  const idx = agentIndex(argv, agent);
  if (idx < 0) return undefined;
  const args = argv.slice(idx + 1);

  switch (agent.toLowerCase()) {
    case "codex": {
      const resumeIndex = args.indexOf("resume");
      if (resumeIndex < 0) return undefined;
      const tail = args.slice(resumeIndex + 1);
      const valueOptions = optionsWithValues(agent);
      for (let i = 0; i < tail.length; i += 1) {
        const arg = tail[i];
        if (arg === "--") return tail[i + 1];
        if (arg === "--last") continue;
        if (valueOptions.has(arg)) {
          i += 1;
          continue;
        }
        if (arg.startsWith("--config=") || arg.startsWith("-c=")) continue;
        if (arg.startsWith("-")) continue;
        return arg;
      }
      return undefined;
    }
    case "opencode":
    case "pi": {
      const sessionArg = args.find((arg) => arg.startsWith("--session="));
      if (sessionArg) return sessionArg.slice("--session=".length) || undefined;
      const sessionIndex = args.indexOf("--session");
      const target = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    case "copilot": {
      const resumeArg = args.find((arg) => arg.startsWith("--resume="));
      if (resumeArg) return resumeArg.slice("--resume=".length) || undefined;
      const resumeIndex = args.indexOf("--resume");
      const target = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    case "claude": {
      const resumeIndex = args.indexOf("--resume");
      const target = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    case "kiro": {
      const resumeArg = args.find((arg) => arg.startsWith("--resume-id="));
      if (resumeArg) return resumeArg.slice("--resume-id=".length) || undefined;
      const resumeIndex = args.indexOf("--resume-id");
      const target = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
      return target && !target.startsWith("-") ? target : undefined;
    }
    default:
      return undefined;
  }
}

function argvFromOptions(options: AgentRestoreCommandOptions): string[] | undefined {
  if (options.originalArgv?.length) return options.originalArgv;
  if (!options.originalCommand) return undefined;
  try {
    return splitCommandArgv(options.originalCommand);
  } catch {
    return undefined;
  }
}

function profileArgvForAgent(agent: string): string[] | undefined {
  try {
    const profile = resolveProfile(agent);
    const argv = splitCommandArgv(profile.command);
    if (normalizeAgentName(argv[0] || "") !== normalizeAgentName(agent)) return undefined;
    return originalBaseArgv(agent, argv) || argv;
  } catch {
    return undefined;
  }
}

function firstNonEmptyArgv(...candidates: Array<string[] | undefined>): string[] {
  for (const candidate of candidates) {
    if (candidate?.length) return candidate;
  }
  return [];
}

function mergeBaseArgv(primary?: string[], secondary?: string[], fallback: string[] = []): string[] {
  const base = firstNonEmptyArgv(primary, secondary, fallback);
  if (!primary?.length || !secondary?.length) return base;
  if (tokenBasename(primary[0] || "") !== tokenBasename(secondary[0] || "")) return base;
  return appendUnique(primary, secondary.slice(1));
}

function defaultBaseArgv(agent: string): string[] {
  return normalizeAgentName(agent) === "kiro" ? ["kiro-cli", "chat", "--tui"] : [normalizeAgentName(agent)];
}

function appendUnique(argv: string[], args: string[]): string[] {
  const result = [...argv];
  for (const arg of args) {
    if (!result.includes(arg)) result.push(arg);
  }
  return result;
}

function stripFlagAndValue(args: string[], flags: Set<string>): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (flags.has(arg)) {
      i += 1;
      continue;
    }
    if ([...flags].some((flag) => arg.startsWith(`${flag}=`))) continue;
    result.push(arg);
  }
  return result;
}

function sessionRestoreTargetFlags(agent: string): Set<string> {
  switch (agent.toLowerCase()) {
    case "opencode":
      return new Set(["--session"]);
    case "pi":
      return new Set(["--session", "--session-id", "--fork", "--resume", "-r"]);
    default:
      return new Set();
  }
}

function sessionRestorePromptValueFlags(agent: string): Set<string> {
  switch (agent.toLowerCase()) {
    case "opencode":
      return new Set(["--prompt"]);
    default:
      return new Set();
  }
}

function shouldDropSessionRestorePositionals(agent: string): boolean {
  switch (agent.toLowerCase()) {
    case "opencode":
    case "pi":
      return true;
    default:
      return false;
  }
}

function stripSessionRestorePromptArgs(agent: string, argv: string[]): string[] {
  if (!shouldDropSessionRestorePositionals(agent)) return argv;

  const idx = agentIndex(argv, agent);
  if (idx < 0) return argv;

  const valueOptions = optionsWithValues(agent);
  const targetFlags = sessionRestoreTargetFlags(agent);
  const promptValueFlags = sessionRestorePromptValueFlags(agent);
  const beforeAndAgent = argv.slice(0, idx + 1);
  const args = argv.slice(idx + 1);
  const result: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--continue") continue;
    if (arg === "--") break;

    const equalsIndex = arg.indexOf("=");
    const flagName = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (targetFlags.has(flagName) || promptValueFlags.has(flagName)) {
      if (equalsIndex < 0) i += 1;
      continue;
    }

    if (equalsIndex >= 0) {
      result.push(arg);
      continue;
    }

    if (valueOptions.has(arg)) {
      result.push(arg);
      const value = args[i + 1];
      if (value !== undefined) {
        result.push(value);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      result.push(arg);
      continue;
    }
  }

  return [...beforeAndAgent, ...result];
}

function originalBaseArgv(agent: string, originalArgv?: string[]): string[] | undefined {
  if (!originalArgv?.length) return undefined;
  const idx = agentIndex(originalArgv, agent);
  if (idx < 0) return undefined;
  const launcher = tokenBasename(originalArgv[0] || "");
  const beforeAgent = idx > 0 && (launcher === "node" || launcher === "nodejs")
    ? [agent.toLowerCase()]
    : originalArgv.slice(0, idx + 1);
  const afterAgent = originalArgv.slice(idx + 1);

  switch (agent.toLowerCase()) {
    case "codex": {
      const resumeIndex = afterAgent.indexOf("resume");
      if (resumeIndex < 0) return [...beforeAgent, ...afterAgent];

      const base = [...beforeAgent, ...afterAgent.slice(0, resumeIndex)];
      const tail = afterAgent.slice(resumeIndex + 1);
      const valueOptions = optionsWithValues(agent);
      for (let i = 0; i < tail.length; i += 1) {
        const arg = tail[i];
        if (arg === "--last") continue;
        if (arg === "-c" || arg === "--config") {
          i += 1;
          continue;
        }
        if (arg.startsWith("--config=") || arg.startsWith("-c=")) continue;
        if (valueOptions.has(arg)) {
          const value = tail[i + 1];
          if (value) {
            base.push(arg, value);
            i += 1;
          }
          continue;
        }
        if (arg.startsWith("-")) {
          base.push(arg);
          continue;
        }
      }
      return base;
    }
    case "claude":
      return [...beforeAgent, ...stripFlagAndValue(afterAgent.filter((arg) => arg !== "--continue"), new Set(["--resume"]))];
    case "copilot":
      return [
        ...beforeAgent,
        ...stripFlagAndValue(afterAgent.filter((arg) => arg !== "--continue" && !arg.startsWith("--resume=")), new Set(["--resume"])),
      ];
    case "opencode":
    case "pi":
      return [...beforeAgent, ...stripFlagAndValue(afterAgent.filter((arg) => arg !== "--continue"), new Set(["--session"]))];
    case "kiro":
      return [
        ...beforeAgent,
        ...stripFlagAndValue(
          afterAgent.filter((arg) => arg !== "--resume" && !arg.startsWith("--resume-id=")),
          new Set(["--resume-id"]),
        ),
      ];
    default:
      return [...beforeAgent, ...afterAgent];
  }
}

function codexResumeOptions(originalArgv?: string[], sessionId?: string): string[] {
  const result: string[] = [];
  if (originalArgv) {
    const idx = agentIndex(originalArgv, "codex");
    const afterAgent = idx >= 0 ? originalArgv.slice(idx + 1) : [];
    const resumeIndex = afterAgent.indexOf("resume");
    const tail = resumeIndex >= 0 ? afterAgent.slice(resumeIndex + 1) : [];
    for (let i = 0; i < tail.length; i += 1) {
      const arg = tail[i];
      if (arg === "-c" || arg === "--config") {
        const value = tail[i + 1];
        if (value) {
          result.push(arg, value);
          i += 1;
        }
      } else if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
        result.push(arg);
      }
    }
  }

  if (!result.some((arg) => arg.includes("model_reasoning_effort")) && sessionId) {
    const effort = codexReasoningEffortForSession(sessionId);
    if (effort) result.push("-c", `model_reasoning_effort="${effort}"`);
  }

  return result;
}

function stateSessionIdFor(agent: string, cwd?: string): string | undefined {
  const uniqueSessionIds = stateSessionIdsFor(agent, cwd);
  return uniqueSessionIds.length === 1 ? uniqueSessionIds[0] : undefined;
}

function stateSessionIdsFor(agent: string, cwd?: string): string[] {
  const latestBySessionId = new Map<string, number>();
  for (const entry of readStates()) {
    if (entry.agent.toLowerCase() !== agent.toLowerCase()) continue;
    if (!entry.externalSessionId) continue;
    if (cwd && entry.workspace?.cwd !== cwd) continue;
    const previous = latestBySessionId.get(entry.externalSessionId);
    if (previous === undefined || entry.ts > previous) {
      latestBySessionId.set(entry.externalSessionId, entry.ts);
    }
  }
  return [...latestBySessionId.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sessionId]) => sessionId);
}

function isCodexLastResume(originalArgv?: string[]): boolean {
  if (!originalArgv?.length) return false;
  const idx = agentIndex(originalArgv, "codex");
  if (idx < 0) return false;
  const args = originalArgv.slice(idx + 1);
  const resumeIndex = args.indexOf("resume");
  return resumeIndex >= 0 && args.slice(resumeIndex + 1).includes("--last");
}

function claimPathFor(agent: string, cwd: string): string {
  const key = createHash("sha1").update(`${agent.toLowerCase()}\0${cwd}`).digest("hex");
  return join(getRuntimeTempDir(), "restore-agent-claims", `${key}.last`);
}

function claimAmbiguousLast(agent: string, cwd: string): boolean {
  const path = claimPathFor(agent, cwd);
  mkdirSync(join(getRuntimeTempDir(), "restore-agent-claims"), { recursive: true });

  try {
    const stat = statSync(path);
    if (Date.now() - stat.mtimeMs > AMBIGUOUS_LAST_CLAIM_TTL_MS) {
      unlinkSync(path);
    }
  } catch {}

  try {
    writeFileSync(path, `${Date.now()}\n`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function codexRestoreStaggerMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTS_CODEX_RESTORE_STAGGER_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CODEX_RESTORE_STAGGER_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CODEX_RESTORE_STAGGER_MS;
  return parsed;
}

function readNumericFile(path: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function acquireDirectoryLock(
  lockPath: string,
  sleepMs: (ms: number) => void,
  nowMs: () => number
): boolean {
  const startedAt = nowMs();
  while (true) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch {
      try {
        if (nowMs() - statSync(lockPath).mtimeMs > CODEX_RESTORE_STAGGER_LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}

      if (nowMs() - startedAt > CODEX_RESTORE_STAGGER_LOCK_WAIT_MS) return false;
      sleepMs(25);
    }
  }
}

export function claimCodexRestoreLaunchDelayMs(options: {
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
  sleepMs?: (ms: number) => void;
} = {}): number {
  const intervalMs = codexRestoreStaggerMs(options.env);
  if (intervalMs === 0) return 0;

  const nowMs = options.nowMs || Date.now;
  const sleepMs = options.sleepMs || ((ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const staggerDir = join(getRuntimeTempDir(), "codex-restore-stagger");
  const lockPath = join(staggerDir, "lock");
  const nextStartPath = join(staggerDir, "next-start");

  mkdirSync(staggerDir, { recursive: true });
  if (!acquireDirectoryLock(lockPath, sleepMs, nowMs)) return 0;

  try {
    const now = nowMs();
    const persistedNextStart = readNumericFile(nextStartPath);
    const nextStart = persistedNextStart === undefined
      || persistedNextStart < now
      || persistedNextStart > now + CODEX_RESTORE_STAGGER_MAX_FUTURE_MS
      ? now
      : persistedNextStart;
    const delayMs = Math.max(0, nextStart - now);
    writeFileSync(nextStartPath, `${nextStart + intervalMs}\n`);
    return delayMs;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function ambiguousLastSessionId(agent: string, cwd: string | undefined, originalArgv?: string[]): string | undefined {
  if (agent.toLowerCase() !== "codex") return undefined;
  if (!cwd || !isCodexLastResume(originalArgv)) return undefined;
  const sessionIds = stateSessionIdsFor(agent, cwd);
  if (sessionIds.length <= 1) return undefined;
  return claimAmbiguousLast(agent, cwd) ? sessionIds[0] : undefined;
}

function resolveSessionId(options: AgentRestoreCommandOptions, originalArgv?: string[]): string | undefined {
  return (originalArgv ? explicitTargetFromArgs(options.agent, originalArgv) : undefined)
    || options.externalSessionId
    || stateSessionIdFor(options.agent, options.cwd)
    || ambiguousLastSessionId(options.agent, options.cwd, originalArgv);
}

export function resolveAgentRestoreArgv(options: AgentRestoreCommandOptions): string[] | undefined {
  const agent = normalizeAgentName(options.agent);
  const originalArgv = argvFromOptions(options);
  const sessionId = resolveSessionId(options, originalArgv);

  const profileArgv = profileArgvForAgent(agent);
  const originalBase = originalBaseArgv(agent, originalArgv);
  const mergedBaseArgv = mergeBaseArgv(profileArgv, originalBase, defaultBaseArgv(agent));
  const baseArgv = sessionId ? stripSessionRestorePromptArgs(agent, mergedBaseArgv) : mergedBaseArgv;

  if (!sessionId) {
    return baseArgv;
  }

  switch (agent) {
    case "claude":
      return appendUnique(baseArgv, ["--resume", sessionId]);
    case "codex":
      return [...baseArgv, "resume", ...codexResumeOptions(originalArgv, sessionId), sessionId];
    case "copilot":
      return appendUnique(baseArgv, [`--resume=${sessionId}`]);
    case "opencode":
    case "pi":
      return appendUnique(baseArgv, ["--session", sessionId]);
    case "kiro":
      return appendUnique(baseArgv, ["--resume-id", sessionId]);
    default:
      return undefined;
  }
}

export function resolveAgentRestoreCommand(options: AgentRestoreCommandOptions): string | undefined {
  const argv = resolveAgentRestoreArgv(options);
  return argv ? renderCommand(argv) : undefined;
}

function absoluteRestoreCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return join(homedir(), cwd.slice(2));
  return cwd;
}

export function tmuxResurrectMetadataCaptures(
  panes: TmuxResurrectMetadataCaptureInput[],
): TmuxResurrectMetadataCapture[] {
  const captures: TmuxResurrectMetadataCapture[] = [];
  const seenPanes = new Set<string>();

  for (const pane of panes) {
    if (!pane.tmuxPaneId.startsWith("%") || !pane.cwd || seenPanes.has(pane.tmuxPaneId)) continue;
    const agent = normalizeAgentName(pane.agent);
    const cwd = absoluteRestoreCwd(pane.cwd);
    let launchCommand: string | undefined;

    if (pane.externalSessionId) {
      const argv = resolveAgentRestoreArgv({
        agent,
        cwd,
        originalArgv: [agent],
        externalSessionId: pane.externalSessionId,
      });
      if (argv) launchCommand = renderCommand(argv);
    } else if (pane.commandLaunch) {
      const explicit = explicitAgentSessionTarget(pane.commandLaunch);
      if (explicit && normalizeAgentName(explicit.agent) === agent) {
        launchCommand = pane.commandLaunch;
      }
    }
    if (!launchCommand) continue;

    captures.push({
      paneID: pane.tmuxPaneId,
      agent,
      cwd,
      launchCommand,
    });
    seenPanes.add(pane.tmuxPaneId);
  }

  return captures;
}

export function resolveStateRestoreCommand(entry: StateEntry): string | undefined {
  const workspace = entry.workspace;
  if (!workspace?.command) return undefined;
  return resolveAgentRestoreCommand({
    agent: entry.agent,
    cwd: workspace.cwd,
    originalCommand: workspace.command,
    externalSessionId: entry.externalSessionId,
  });
}

interface MetadataPaneEntry {
  sessionName: string;
  windowNumber: string;
  paneIndex: string;
  commandId?: string;
  commandCwd?: string;
  commandLaunch?: string;
}

interface ResolvedMetadataLaunch {
  command: string;
  cwd?: string;
  source: "metadata" | "config-command" | "profile";
  commandId?: string;
}

export interface TmuxResurrectMetadataApplyResult {
  panes: number;
  metadata: number;
  changed: number;
  content: string;
}

function metadataKey(entry: Pick<MetadataPaneEntry, "sessionName" | "windowNumber" | "paneIndex">): string {
  return `${entry.sessionName}\0${entry.windowNumber}\0${entry.paneIndex}`;
}

function parseMetadataEntries(content: string): MetadataPaneEntry[] {
  return content.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const fields = line.split("|");
    if (fields.length < 18) return [];
    return [{
      sessionName: fields[0] || "",
      windowNumber: fields[1] || "",
      paneIndex: fields[2] || "",
      commandId: fields[4]?.trim() || undefined,
      commandCwd: fields[7]?.trim() || undefined,
      commandLaunch: fields[17]?.trim() || undefined,
    }];
  }).filter((entry) => entry.sessionName && entry.windowNumber && entry.paneIndex);
}

function commandById(commandId: string): CommandConfigEntry | undefined {
  return loadConfig().commands.find((entry) => entry.id === commandId);
}

function configuredLaunchForCommandId(commandId: string | undefined): ResolvedMetadataLaunch | undefined {
  if (!commandId || commandId === "shell") return undefined;

  const commandEntry = commandById(commandId);
  if (commandEntry && !isShellCommandName(firstExecutableToken(commandEntry.command))) {
    return {
      command: renderConfiguredCommand(commandEntry.command, commandEntry.environment),
      cwd: commandEntry.cwd,
      source: "config-command",
    };
  }

  const profile = loadConfig().profiles[commandId];
  if (profile?.command) {
    return {
      command: renderConfiguredCommand(profile.command, profile.env),
      source: "profile",
    };
  }

  return undefined;
}

function resolvedLaunchForMetadata(entry: MetadataPaneEntry): ResolvedMetadataLaunch | undefined {
  if (entry.commandLaunch) {
    return {
      command: entry.commandLaunch,
      cwd: entry.commandCwd,
      source: "metadata",
      commandId: entry.commandId,
    };
  }

  const configured = configuredLaunchForCommandId(entry.commandId);
  if (!configured) return undefined;
  return {
    ...configured,
    cwd: entry.commandCwd || configured.cwd,
    commandId: entry.commandId,
  };
}

function shouldApplyMetadataLaunch(savedFullCommand: string | undefined, launch: ResolvedMetadataLaunch): boolean {
  if (launch.source === "metadata") return true;
  if (isShellishFullCommand(savedFullCommand)) return true;
  return !firstAgentToken(launch.command);
}

function explicitAgentSessionTarget(command: string): { agent: string; target: string } | undefined {
  const agent = firstAgentToken(command);
  if (!agent) return undefined;
  const target = explicitTargetFromArgs(normalizeAgentName(agent), commandArgv(command));
  return target ? { agent, target } : undefined;
}

function paneProcessEntryForCommand(command: string, options: { wrapExplicitAgentSession?: boolean } = {}): string | undefined {
  const agent = firstAgentToken(command);
  if (agent) {
    if (!options.wrapExplicitAgentSession && explicitAgentSessionTarget(command)) {
      return `~${tokenBasename(agent)}`;
    }
    return `~${tokenBasename(agent)} -> agents resurrect agent ${normalizeAgentName(agent)} *`;
  }

  const executable = firstExecutableToken(command);
  if (!executable || isShellCommandName(executable)) return undefined;
  return `~${tokenBasename(executable)}`;
}

function configuredRestoreProcessEntries(agentsWithExplicitSessionLaunches: Set<string> = new Set()): string[] {
  const config = loadConfig();
  const entries: string[] = [];

  for (const profile of Object.values(config.profiles)) {
    if (!profile.command) continue;
    const command = renderConfiguredCommand(profile.command, profile.env);
    const explicit = explicitAgentSessionTarget(command);
    const agent = explicit?.agent || firstAgentToken(command);
    if (agent && agentsWithExplicitSessionLaunches.has(normalizeAgentName(agent))) continue;
    const entry = paneProcessEntryForCommand(command, { wrapExplicitAgentSession: true });
    if (entry) entries.push(entry);
  }

  for (const command of config.commands) {
    if (!command.command || command.id === "shell") continue;
    const rendered = renderConfiguredCommand(command.command, command.environment);
    const explicit = explicitAgentSessionTarget(rendered);
    const agent = explicit?.agent || firstAgentToken(rendered);
    if (agent && agentsWithExplicitSessionLaunches.has(normalizeAgentName(agent))) continue;
    const entry = paneProcessEntryForCommand(rendered, { wrapExplicitAgentSession: true });
    if (entry) entries.push(entry);
  }

  return entries;
}

export function tmuxResurrectRestoreProcesses(content = "", metadataContent = ""): string[] {
  const entries = new Set<string>();
  const agentsWithExplicitSessionLaunches = new Set<string>();

  for (const metadata of parseMetadataEntries(metadataContent)) {
    const launch = resolvedLaunchForMetadata(metadata);
    if (!launch) continue;
    const explicit = explicitAgentSessionTarget(launch.command);
    if (explicit) agentsWithExplicitSessionLaunches.add(normalizeAgentName(explicit.agent));
  }

  for (const line of content.split("\n")) {
    const fields = line.split("\t");
    if (fields[0] !== "pane" || fields.length < 11) continue;
    const savedFullCommand = fields[10]?.startsWith(":") ? fields[10].slice(1) : fields[10];
    const explicit = explicitAgentSessionTarget(savedFullCommand || "");
    if (explicit) agentsWithExplicitSessionLaunches.add(normalizeAgentName(explicit.agent));
  }

  for (const entry of configuredRestoreProcessEntries(agentsWithExplicitSessionLaunches)) entries.add(entry);

  for (const metadata of parseMetadataEntries(metadataContent)) {
    const launch = resolvedLaunchForMetadata(metadata);
    if (!launch) continue;
    const entry = paneProcessEntryForCommand(launch.command);
    if (entry) entries.add(entry);
  }

  for (const line of content.split("\n")) {
    const fields = line.split("\t");
    if (fields[0] !== "pane" || fields.length < 11) continue;
    const savedFullCommand = fields[10]?.startsWith(":") ? fields[10].slice(1) : fields[10];
    const entry = paneProcessEntryForCommand(savedFullCommand || "");
    if (entry) entries.add(entry);
  }

  return [...entries];
}

export function tmuxResurrectRestoreProcessesForFiles(file?: string, metadataFile?: string): string[] {
  const content = file ? readFileSync(file, "utf-8") : "";
  let metadataContent = "";
  if (metadataFile) {
    try {
      metadataContent = readFileSync(metadataFile, "utf-8");
    } catch {}
  }
  return tmuxResurrectRestoreProcesses(content, metadataContent);
}

export function applyTmuxResurrectMetadataLaunches(
  content: string,
  metadataContent: string,
): TmuxResurrectMetadataApplyResult {
  const launches = new Map<string, ResolvedMetadataLaunch>();
  const metadataEntries = parseMetadataEntries(metadataContent);
  for (const entry of metadataEntries) {
    const launch = resolvedLaunchForMetadata(entry);
    if (!launch) continue;
    launches.set(metadataKey(entry), launch);
  }

  let panes = 0;
  let changed = 0;
  const normalized = content.split("\n").map((line) => {
    const fields = line.split("\t");
    if (fields[0] !== "pane" || fields.length < 11) return line;
    panes += 1;

    const launch = launches.get(metadataKey({
      sessionName: fields[1],
      windowNumber: fields[2],
      paneIndex: fields[5],
    }));
    if (!launch) return line;

    const savedFullCommand = fields[10]?.startsWith(":") ? fields[10].slice(1) : fields[10];
    if (!shouldApplyMetadataLaunch(savedFullCommand, launch)) return line;

    const nextFullCommand = `:${launch.command}`;
    const nextDir = launch.cwd ? `:${launch.cwd}` : fields[7];
    if (fields[10] === nextFullCommand && fields[7] === nextDir) return line;
    fields[10] = nextFullCommand;
    fields[7] = nextDir;
    changed += 1;
    return fields.join("\t");
  }).join("\n");

  return { panes, metadata: metadataEntries.length, changed, content: normalized };
}

export function applyTmuxResurrectMetadataLaunchesFile(file: string, metadataFile: string): TmuxResurrectMetadataApplyResult {
  const result = applyTmuxResurrectMetadataLaunches(
    readFileSync(file, "utf-8"),
    readFileSync(metadataFile, "utf-8"),
  );
  if (result.changed > 0) {
    writeFileSync(file, result.content);
  }
  return result;
}

export interface TmuxResurrectNormalizeResult {
  panes: number;
  changed: number;
  content: string;
}

export type TmuxPaneIdResolver = (target: {
  sessionName: string;
  windowNumber: string;
  paneIndex: string;
}) => string | undefined;

function resolveLiveTmuxPaneId(target: { sessionName: string; windowNumber: string; paneIndex: string }): string | undefined {
  try {
    return execFileSync("tmux", [
      "display-message",
      "-p",
      "-t",
      `${target.sessionName}:${target.windowNumber}.${target.paneIndex}`,
      "#{pane_id}",
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function stateEntriesByPaneId(entries: StateEntry[]): Map<string, StateEntry> {
  const byPaneId = new Map<string, StateEntry>();
  for (const entry of entries) {
    if (!entry.session || !entry.externalSessionId) continue;
    const existing = byPaneId.get(entry.session);
    if (!existing || entry.ts > existing.ts) {
      byPaneId.set(entry.session, entry);
    }
  }
  return byPaneId;
}

export function normalizeTmuxResurrectContent(
  content: string,
  resolvePaneId: TmuxPaneIdResolver = resolveLiveTmuxPaneId,
  entries: StateEntry[] = readStates(),
): TmuxResurrectNormalizeResult {
  const byPaneId = stateEntriesByPaneId(entries);
  let panes = 0;
  let changed = 0;

  const normalized = content.split("\n").map((line) => {
    const fields = line.split("\t");
    if (fields[0] !== "pane" || fields.length < 11) return line;
    panes += 1;

    const paneId = resolvePaneId({
      sessionName: fields[1],
      windowNumber: fields[2],
      paneIndex: fields[5],
    });
    if (!paneId) return line;

    const entry = byPaneId.get(paneId);
    if (!entry) return line;

    const savedFullCommand = fields[10]?.startsWith(":") ? fields[10].slice(1) : fields[10];
    const command = resolveAgentRestoreCommand({
      agent: entry.agent,
      cwd: entry.workspace?.cwd,
      originalCommand: savedFullCommand,
      externalSessionId: entry.externalSessionId,
    }) || resolveStateRestoreCommand(entry);
    if (!command) return line;

    const nextFullCommand = `:${command}`;
    if (fields[10] === nextFullCommand) return line;
    fields[10] = nextFullCommand;
    changed += 1;
    return fields.join("\t");
  }).join("\n");

  return { panes, changed, content: normalized };
}

export function normalizeTmuxResurrectFile(path: string): TmuxResurrectNormalizeResult {
  const result = normalizeTmuxResurrectContent(readFileSync(path, "utf-8"));
  if (result.changed > 0) {
    writeFileSync(path, result.content);
  }
  return result;
}
