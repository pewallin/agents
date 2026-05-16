import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { homedir } from "os";
import path from "path";
import { scan } from "./scanner.js";
import { execFileCapture } from "./shell.js";
import { createWorkspaceOrThrow, type WorkspaceLaunchResult } from "./workspace.js";
import { resumeAgentSession } from "./resume.js";

export type AgentsTargetKind = "local" | "ssh";
export type ImplementationCheckoutRole = "landing" | "execution";
export type RuntimePhase =
  | "read_target_config"
  | "resolve_target"
  | "check_remote_runtime"
  | "resolve_repo_root"
  | "clone_repo"
  | "resolve_base_ref"
  | "resolve_start_ref"
  | "create_landing_checkout"
  | "snapshot_context"
  | "add_target_remote"
  | "push_branch_to_target"
  | "create_execution_checkout"
  | "start_session"
  | "resume_session"
  | "refresh_status"
  | "complete";

export interface RuntimeFailureShape {
  ok: false;
  phase: RuntimePhase;
  code: string;
  message: string;
  targetId?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  partialResult?: RuntimePartialResultShape;
}

export class AgentsRuntimeError extends Error {
  readonly ok = false;
  readonly phase: RuntimePhase;
  readonly code: string;
  readonly targetId?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly partialResult?: RuntimePartialResultShape;

  constructor(input: {
    phase: RuntimePhase;
    code: string;
    message: string;
    targetId?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
    partialResult?: RuntimePartialResultShape;
  }) {
    super(input.message);
    this.name = "AgentsRuntimeError";
    this.phase = input.phase;
    this.code = input.code;
    this.targetId = input.targetId;
    this.retryable = input.retryable ?? true;
    this.details = input.details;
    this.partialResult = input.partialResult;
  }

  toJSON(): RuntimeFailureShape {
    return {
      ok: false,
      phase: this.phase,
      code: this.code,
      message: this.message,
      ...(this.targetId ? { targetId: this.targetId } : {}),
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
      ...(this.partialResult ? { partialResult: this.partialResult } : {}),
    };
  }
}

export interface TargetCapabilities {
  sessions: boolean;
  implementationCheckouts: boolean;
}

export interface ImplementationTarget {
  id: string;
  kind: AgentsTargetKind;
  displayName: string;
  isEnabled: boolean;
  repoRoots: string[];
  capabilities: TargetCapabilities;
  sourceConfigId?: string;
}

export interface ImplementationCheckout {
  checkoutId: string;
  targetId: string;
  role: ImplementationCheckoutRole;
  repoPath: string;
  path: string;
  branch?: string;
  baseRef?: string;
  baseCommit?: string;
  startRef?: string;
  startCommit?: string;
  remoteName?: string;
  remoteUrl?: string;
  cloned?: boolean;
  headSha?: string;
  ahead?: number;
  behind?: number;
  merged?: boolean;
  dirty?: boolean;
  sessions?: string[];
}

export interface CheckoutCreatePartialResult {
  targetId: string;
  repoName: string;
  branch: string;
  baseRef: string;
  baseCommit?: string;
  startRef?: string;
  startCommit?: string;
  landingCheckout?: ImplementationCheckout;
  executionCheckout?: ImplementationCheckout;
}

export interface RuntimePartialResultShape {
  checkout?: CheckoutCreatePartialResult;
}

export interface CheckoutCreateResult {
  ok: true;
  phase: "complete";
  targetId: string;
  repoName: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  startRef?: string;
  startCommit?: string;
  landingCheckout?: ImplementationCheckout;
  executionCheckout: ImplementationCheckout;
}

export interface CheckoutStatusResult {
  ok: true;
  phase: "refresh_status";
  targetId: string;
  repoName: string;
  checkouts: ImplementationCheckout[];
  warnings?: Array<{ phase: RuntimePhase; message: string }>;
}

export interface SessionStartResult {
  ok: true;
  phase: "start_session";
  session: {
    sessionId: string;
    targetId: string;
    checkoutId: string;
    profile: string;
    transport: "tmux";
    tmuxSession?: string;
    paneId?: string;
    startedAt: string;
  };
  launch?: WorkspaceLaunchResult;
}

export interface SessionResumeResult {
  ok: true;
  phase: "resume_session";
  sessionId: string;
  targetId: string;
  paneId?: string;
  status?: string;
  attached: boolean;
  message?: string;
}

export interface TargetAgentSessionEntry {
  pane?: string;
  paneId?: string;
  tmuxPaneId?: string;
  agent?: string;
  status?: string;
  cwd?: string;
}

export interface TargetAgentSessionsResult {
  ok: true;
  phase: "refresh_status";
  targetId: string;
  sessions: TargetAgentSessionEntry[];
}

interface WorktreeEntry {
  path: string;
  branch?: string;
  headSha?: string;
}

interface RemoteHostEndpoint {
  kind?: string;
  username?: string;
  hostname?: string;
  connectionAddress?: string;
  port?: number;
}

interface RemoteHostConfigEntry {
  id?: string;
  displayName?: string;
  endpoint?: RemoteHostEndpoint;
  isEnabled?: boolean;
  repoRoots?: string[];
}

export interface TargetListOptions {
  repoRoot?: string;
  homeDir?: string;
  configPath?: string;
}

export interface ResolveTargetOptions extends TargetListOptions {
  targetId?: string;
}

export interface CheckoutCreateOptions extends TargetListOptions {
  targetId?: string;
  sourceRepoPath?: string;
  repoName?: string;
  remoteUrl?: string;
  baseRef?: string;
  startRef?: string;
  name: string;
  branch?: string;
  cloneIfMissing?: boolean;
  localLanding?: boolean;
  reuseExisting?: boolean;
  snapshotPaths?: string[];
}

export interface CheckoutStatusOptions extends TargetListOptions {
  targetId?: string;
  repoName?: string;
  checkoutId?: string;
  path?: string;
  branch?: string;
  baseRef?: string;
  baseCommit?: string;
  role?: ImplementationCheckoutRole;
}

export interface SessionStartOptions extends TargetListOptions {
  targetId?: string;
  checkoutId: string;
  path: string;
  profile: string;
  name: string;
  overrides?: string[];
  tmuxSession?: string;
}

export interface SessionResumeOptions extends TargetListOptions {
  targetId?: string;
  sessionId: string;
  checkoutId?: string;
  path?: string;
  profile?: string;
  pane?: string;
  prompt?: string;
  newSession?: boolean;
}

export interface TargetAgentSessionsOptions extends TargetListOptions {
  targetId?: string;
}

const REMOTE_HOST_CONFIG_PATH = path.join(
  homedir(),
  ".agents",
  "agents-app",
  "app",
  "config",
  "remote-hosts.json",
);

function fail(input: ConstructorParameters<typeof AgentsRuntimeError>[0]): never {
  throw new AgentsRuntimeError(input);
}

function expandHomePath(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

function defaultLocalRepoRoot(repoRoot: string): string {
  return path.dirname(path.resolve(repoRoot));
}

function targetIdForEndpoint(endpoint: RemoteHostEndpoint): string | null {
  const username = endpoint.username?.trim();
  const connectHost = endpoint.connectionAddress?.trim() || endpoint.hostname?.trim();
  if (!connectHost) return null;

  const host = username ? `${username}@${connectHost}` : connectHost;
  return endpoint.port && endpoint.port !== 22 ? `${host}:${endpoint.port}` : host;
}

function repoRootsForHost(entry: RemoteHostConfigEntry, fallbackRoot: string, homeDir: string): string[] {
  const roots = entry.repoRoots?.map((repoRoot) => repoRoot.trim()).filter(Boolean) ?? [];
  const normalizedRoots = roots.length > 0 ? roots : [fallbackRoot];
  return normalizedRoots.map((repoRoot) => (repoRoot.startsWith("~") ? repoRoot : expandHomePath(repoRoot, homeDir)));
}

function readRemoteHostConfig(options: TargetListOptions): RemoteHostConfigEntry[] {
  const configPath = options.configPath ?? REMOTE_HOST_CONFIG_PATH;
  if (!existsSync(configPath)) return [];

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    fail({
      phase: "read_target_config",
      code: "target_config_unreadable",
      message: `Could not read agents target config at ${configPath}.`,
      retryable: true,
      details: { configPath, error: error instanceof Error ? error.message : String(error) },
    });
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      fail({
        phase: "read_target_config",
        code: "target_config_invalid",
        message: `Agents target config at ${configPath} must be a JSON array.`,
        retryable: true,
        details: { configPath },
      });
    }
    return parsed as RemoteHostConfigEntry[];
  } catch (error) {
    if (error instanceof AgentsRuntimeError) throw error;
    fail({
      phase: "read_target_config",
      code: "target_config_invalid_json",
      message: `Agents target config at ${configPath} is not valid JSON.`,
      retryable: true,
      details: { configPath, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function listImplementationTargets(options: TargetListOptions = {}): { targets: ImplementationTarget[] } {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const homeDir = options.homeDir ?? homedir();
  const localRepoRoot = defaultLocalRepoRoot(repoRoot);
  const localTarget: ImplementationTarget = {
    id: "local",
    kind: "local",
    displayName: "Local",
    isEnabled: true,
    repoRoots: [localRepoRoot],
    capabilities: {
      sessions: true,
      implementationCheckouts: true,
    },
  };

  const remoteTargets = readRemoteHostConfig(options).flatMap((entry): ImplementationTarget[] => {
    const endpoint = entry.endpoint;
    if (!endpoint || endpoint.kind !== "ssh" || entry.isEnabled === false) return [];

    const targetId = targetIdForEndpoint(endpoint);
    if (!targetId) return [];

    return [{
      id: targetId,
      kind: "ssh",
      displayName: entry.displayName?.trim() || endpoint.hostname || targetId,
      isEnabled: true,
      repoRoots: repoRootsForHost(entry, localRepoRoot, homeDir),
      capabilities: {
        sessions: true,
        implementationCheckouts: true,
      },
      ...(entry.id ? { sourceConfigId: entry.id } : {}),
    }];
  });

  return { targets: [localTarget, ...remoteTargets] };
}

export function resolveImplementationTarget(options: ResolveTargetOptions = {}): ImplementationTarget {
  const requestedTargetId = options.targetId?.trim() || "local";
  const targets = listImplementationTargets(options).targets;
  const target = targets.find((candidate) => candidate.id === requestedTargetId);
  if (!target) {
    fail({
      phase: "resolve_target",
      code: "target_not_found",
      message: `Agents target "${requestedTargetId}" is not configured or is disabled.`,
      targetId: requestedTargetId,
      retryable: true,
    });
  }
  return target;
}

function slugifySegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "checkout";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shellQuoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9_~./:@%+=,-]+$/.test(value) ? value : shellQuote(value);
}

function shellJoin(args: string[]): string {
  return args.map(shellQuoteIfNeeded).join(" ");
}

function parseKeyValueOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    result[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }
  return result;
}

function parseWorktreeListOutput(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  function pushCurrent(): void {
    if (current?.path) entries.push(current);
    current = undefined;
  }

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      pushCurrent();
      continue;
    }

    if (line.startsWith("worktree ")) {
      pushCurrent();
      current = { path: line.slice("worktree ".length) };
      continue;
    }

    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.headSha = line.slice("HEAD ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }

  pushCurrent();
  return entries;
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function runtimeFailureFromJson(raw: string): RuntimeFailureShape | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<RuntimeFailureShape>;
      if (
        parsed.ok === false &&
        typeof parsed.phase === "string" &&
        typeof parsed.code === "string" &&
        typeof parsed.message === "string"
      ) {
        return {
          ok: false,
          phase: parsed.phase as RuntimePhase,
          code: parsed.code,
          message: parsed.message,
          ...(typeof parsed.targetId === "string" ? { targetId: parsed.targetId } : {}),
          retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : true,
          ...(parsed.details && typeof parsed.details === "object" ? { details: parsed.details } : {}),
          ...(parsed.partialResult && typeof parsed.partialResult === "object"
            ? { partialResult: parsed.partialResult as RuntimePartialResultShape }
            : {}),
        };
      }
    } catch {
      // Keep looking for a structured JSON failure in the remaining candidates.
    }
  }

  return undefined;
}

function runFile(args: {
  command: string;
  argv: string[];
  cwd?: string;
  phase: RuntimePhase;
  code: string;
  message: string;
  targetId?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}): string {
  const result = execFileCapture(args.command, args.argv, { cwd: args.cwd, timeout: 30_000 });
  if (result.status === 0) return result.stdout;

  fail({
    phase: args.phase,
    code: args.code,
    message: args.message,
    targetId: args.targetId,
    retryable: args.retryable ?? true,
    details: {
      ...(args.details ?? {}),
      command: [args.command, ...args.argv].join(" "),
      stderr: result.stderr,
      stdout: result.stdout,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    },
  });
}

function runGit(repoRoot: string, argv: string[], phase: RuntimePhase, message: string, code = "git_failed"): string {
  return runFile({
    command: "git",
    argv,
    cwd: repoRoot,
    phase,
    code,
    message,
    retryable: true,
  });
}

function runGitMaybe(repoRoot: string, argv: string[]): { ok: boolean; stdout: string } {
  const result = execFileCapture("git", argv, { cwd: repoRoot, timeout: 30_000 });
  return { ok: result.status === 0, stdout: result.stdout };
}

function resolveRepoRoot(sourceRepoPath: string): string {
  return runGit(
    sourceRepoPath,
    ["rev-parse", "--show-toplevel"],
    "resolve_repo_root",
    "Agents checkout creation requires a working git repository.",
  );
}

function branchExists(repoRoot: string, branchName: string): boolean {
  return runGitMaybe(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).ok;
}

function checkoutPathUsesBranch(checkoutPath: string, branchName: string): boolean {
  if (!existsSync(checkoutPath)) return false;
  const result = runGitMaybe(checkoutPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return result.ok && result.stdout.trim() === branchName;
}

function resolveBaseRef(repoRoot: string, baseRef?: string): { baseRef: string; baseCommit: string } {
  const candidates = baseRef?.trim() ? [baseRef.trim()] : ["origin/main", "origin/master", "main", "master"];
  for (const candidate of candidates) {
    const result = runGitMaybe(repoRoot, ["rev-parse", "--verify", `${candidate}^{commit}`]);
    if (result.ok && result.stdout) {
      return { baseRef: candidate, baseCommit: result.stdout };
    }
  }

  fail({
    phase: "resolve_base_ref",
    code: "base_ref_not_found",
    message: baseRef
      ? `Agents could not resolve base ref "${baseRef}".`
      : "Agents checkout creation needs origin/main, origin/master, main, or master to use as the clean base.",
    retryable: true,
    details: { baseRef },
  });
}

function resolveStartRef(repoRoot: string, startRef: string | undefined, fallbackRef: string): { startRef: string; startCommit: string } {
  const candidate = startRef?.trim() || fallbackRef;
  const result = runGitMaybe(repoRoot, ["rev-parse", "--verify", `${candidate}^{commit}`]);
  if (result.ok && result.stdout) {
    return { startRef: candidate, startCommit: result.stdout };
  }

  fail({
    phase: "resolve_start_ref",
    code: "start_ref_not_found",
    message: `Agents could not resolve start ref "${candidate}".`,
    retryable: true,
    details: { startRef: candidate },
  });
}

function chooseCheckoutIdentity(input: {
  repoRoot: string;
  repoName: string;
  name: string;
  branch?: string;
  reuseExisting?: boolean;
}): { worktreeName: string; branch: string; path: string } {
  const baseName = slugifySegment(input.name).slice(0, 72);
  const worktreeRoot = path.join(path.dirname(input.repoRoot), ".shape-worktrees", input.repoName);

  if (input.branch) {
    const worktreeName = baseName;
    return {
      worktreeName,
      branch: input.branch,
      path: path.join(worktreeRoot, worktreeName),
    };
  }

  for (let attempt = 1; attempt < 100; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const branch = `shape/${baseName}${suffix}`;
    const checkoutPath = path.join(worktreeRoot, `${baseName}${suffix}`);
    if (input.reuseExisting && attempt === 1 && checkoutPathUsesBranch(checkoutPath, branch)) {
      return {
        worktreeName: `${baseName}${suffix}`,
        branch,
        path: checkoutPath,
      };
    }
    if (branchExists(input.repoRoot, branch) || existsSync(checkoutPath)) continue;
    return {
      worktreeName: `${baseName}${suffix}`,
      branch,
      path: checkoutPath,
    };
  }

  fail({
    phase: "create_execution_checkout",
    code: "checkout_name_exhausted",
    message: "Agents could not find a free implementation checkout name. Clean up old worktrees and try again.",
    retryable: true,
  });
}

function createLocalWorktree(input: {
  repoRoot: string;
  checkoutPath: string;
  branch: string;
  startRef: string;
  phase: "create_landing_checkout" | "create_execution_checkout";
}): void {
  if (checkoutPathUsesBranch(input.checkoutPath, input.branch)) return;
  mkdirSync(path.dirname(input.checkoutPath), { recursive: true });
  runGit(
    input.repoRoot,
    ["worktree", "add", "-b", input.branch, input.checkoutPath, input.startRef],
    input.phase,
    input.phase === "create_landing_checkout"
      ? "Agents could not create the local landing checkout."
      : "Agents could not create the implementation checkout.",
    "worktree_create_failed",
  );
}

function toRepoRelativeSnapshotPath(repoRoot: string, inputPath: string): string {
  const trimmed = inputPath.trim();
  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(repoRoot, trimmed);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    fail({
      phase: "snapshot_context",
      code: "snapshot_path_outside_repo",
      message: `Snapshot path "${inputPath}" is outside the source repository.`,
      retryable: false,
      details: { path: inputPath, repoRoot },
    });
  }

  return relativePath.split(path.sep).join("/");
}

function normalizeSnapshotPaths(repoRoot: string, snapshotPaths: string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const inputPath of snapshotPaths ?? []) {
    if (!inputPath.trim()) continue;
    normalized.add(toRepoRelativeSnapshotPath(repoRoot, inputPath));
  }

  return [...normalized];
}

function snapshotContextPaths(input: {
  sourceRepoRoot: string;
  checkoutPath: string;
  snapshotPaths?: string[];
}): void {
  const snapshotPaths = normalizeSnapshotPaths(input.sourceRepoRoot, input.snapshotPaths);
  if (snapshotPaths.length === 0) return;

  for (const gitPath of snapshotPaths) {
    const sourcePath = path.join(input.sourceRepoRoot, gitPath);
    const checkoutPath = path.join(input.checkoutPath, gitPath);
    if (existsSync(sourcePath)) {
      mkdirSync(path.dirname(checkoutPath), { recursive: true });
      cpSync(sourcePath, checkoutPath, { recursive: true, force: true });
      runGit(
        input.checkoutPath,
        ["add", "-f", "--", gitPath],
        "snapshot_context",
        "Agents could not stage a snapshot context path in the implementation checkout.",
        "snapshot_stage_failed",
      );
    } else {
      rmSync(checkoutPath, { recursive: true, force: true });
      runGit(
        input.checkoutPath,
        ["rm", "-r", "--ignore-unmatch", "--", gitPath],
        "snapshot_context",
        "Agents could not stage a removed snapshot context path in the implementation checkout.",
        "snapshot_stage_failed",
      );
    }
  }

  const hasSnapshotDiff = !runGitMaybe(input.checkoutPath, ["diff", "--cached", "--quiet", "--", ...snapshotPaths]).ok;
  if (!hasSnapshotDiff) return;

  runGit(
    input.checkoutPath,
    ["commit", "-m", "Agents: snapshot checkout context"],
    "snapshot_context",
    "Agents could not commit snapshot context paths in the implementation checkout.",
    "snapshot_commit_failed",
  );
}

function buildCheckoutId(targetId: string, repoName: string, worktreeName: string): string {
  return `${targetId}:${repoName}:${worktreeName}`;
}

function getOriginRemoteUrl(repoRoot: string, explicitRemoteUrl?: string): string {
  if (explicitRemoteUrl?.trim()) return explicitRemoteUrl.trim();

  return runGit(
    repoRoot,
    ["remote", "get-url", "origin"],
    "resolve_repo_root",
    "Remote checkout creation needs the source repo to have an origin remote URL.",
    "origin_remote_missing",
  );
}

function parseSshTargetId(targetId: string): { host: string; port?: number } {
  const portMatch = targetId.match(/^(.*):([0-9]+)$/);
  return {
    host: portMatch ? portMatch[1]! : targetId,
    ...(portMatch ? { port: Number(portMatch[2]) } : {}),
  };
}

function buildSshArgs(targetId: string, command: string): string[] {
  const target = parseSshTargetId(targetId);
  return target.port ? ["-p", String(target.port), target.host, command] : [target.host, command];
}

function runSsh(input: {
  target: ImplementationTarget;
  command: string;
  phase: RuntimePhase;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): string {
  return runFile({
    command: "ssh",
    argv: buildSshArgs(input.target.id, input.command),
    phase: input.phase,
    code: input.code,
    message: input.message,
    targetId: input.target.id,
    retryable: true,
    details: input.details,
  });
}

function runSshRaw(input: {
  target: ImplementationTarget;
  command: string;
  phase: RuntimePhase;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): { ok: boolean; stdout: string; stderr: string; status: number } {
  const result = execFileCapture("ssh", buildSshArgs(input.target.id, input.command), { timeout: 30_000 });
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function checkRemoteRuntime(target: ImplementationTarget): void {
  runSsh({
    target,
    command: "command -v agents >/dev/null && agents --version >/dev/null",
    phase: "check_remote_runtime",
    code: "remote_agents_unavailable",
    message: `Could not find a compatible agents runtime on ${target.displayName}.`,
  });
}

function remoteRepoPathForStatus(target: ImplementationTarget, repoName: string): string {
  const remoteRepoRoot = target.repoRoots[0];
  if (!remoteRepoRoot) {
    fail({
      phase: "resolve_repo_root",
      code: "repo_root_missing",
      message: `Target "${target.displayName}" does not have a repo root configured.`,
      targetId: target.id,
      retryable: true,
    });
  }

  return path.join(remoteRepoRoot, repoName);
}

function buildSshRepoUrl(targetId: string, remoteRepoPath: string): string {
  const target = parseSshTargetId(targetId);
  const normalizedPath = remoteRepoPath.startsWith("/") ? remoteRepoPath : `/${remoteRepoPath}`;
  return `ssh://${target.host}${target.port ? `:${target.port}` : ""}${normalizedPath}`;
}

function ensureRemoteRepo(input: {
  target: ImplementationTarget;
  repoRoot: string;
  repoName: string;
  remoteUrl: string;
  cloneIfMissing?: boolean;
}): { repoPath: string; cloned: boolean } {
  const script = [
    "set -e",
    `repo_root_input=${shellQuote(input.repoRoot)}`,
    'case "$repo_root_input" in "~") repo_root="$HOME" ;; "~/"*) repo_root="$HOME/${repo_root_input#\\~/}" ;; *) repo_root="$repo_root_input" ;; esac',
    `repo_name=${shellQuote(input.repoName)}`,
    `remote_url=${shellQuote(input.remoteUrl)}`,
    'mkdir -p "$repo_root"',
    'repo_path="$repo_root/$repo_name"',
    "cloned=0",
    'if [ -d "$repo_path/.git" ]; then',
    'origin_url=$(git -C "$repo_path" remote get-url origin 2>/dev/null || true)',
    'if [ "$origin_url" != "$remote_url" ]; then',
    'printf "repoPath=%s\\noriginUrl=%s\\nexpectedRemoteUrl=%s\\n" "$repo_path" "$origin_url" "$remote_url"',
    "exit 43",
    "fi",
    "else",
    input.cloneIfMissing === false
      ? 'printf "repoPath=%s\\n" "$repo_path"; exit 44'
      : 'git clone "$remote_url" "$repo_path" >/dev/null; cloned=1',
    "fi",
    'cd "$repo_path"',
    'printf "repoPath=%s\\ncloned=%s\\n" "$(pwd -P)" "$cloned"',
  ].join("\n");

  const result = runSshRaw({
    target: input.target,
    command: script,
    phase: "clone_repo",
    code: "clone_repo_failed",
    message: `Could not prepare ${input.repoName} on ${input.target.displayName}.`,
  });
  const parsed = parseKeyValueOutput(result.stdout);

  if (!result.ok) {
    const mismatch = result.status === 43;
    const missing = result.status === 44;
    fail({
      phase: mismatch ? "resolve_repo_root" : "clone_repo",
      code: mismatch ? "remote_url_mismatch" : missing ? "remote_repo_missing" : "clone_repo_failed",
      message: mismatch
        ? `Refusing to use ${parsed.repoPath || `${input.repoRoot}/${input.repoName}`} on ${input.target.displayName} because its origin remote does not match ${input.remoteUrl}.`
        : `Could not prepare ${input.repoName} on ${input.target.displayName}.`,
      targetId: input.target.id,
      retryable: true,
      details: {
        repoName: input.repoName,
        repoRoot: input.repoRoot,
        remoteUrl: input.remoteUrl,
        originUrl: parsed.originUrl,
        stderr: result.stderr,
        status: result.status,
      },
    });
  }

  if (!parsed.repoPath) {
    fail({
      phase: "clone_repo",
      code: "repo_path_missing",
      message: `Prepared ${input.repoName} on ${input.target.displayName}, but the remote repo path was not reported.`,
      targetId: input.target.id,
      retryable: true,
    });
  }

  return {
    repoPath: parsed.repoPath,
    cloned: parsed.cloned === "1",
  };
}

function addOrUpdateRemote(input: { landingPath: string; remoteName: string; remoteUrl: string }): void {
  const existing = runGitMaybe(input.landingPath, ["remote", "get-url", input.remoteName]);
  runGit(
    input.landingPath,
    existing.ok
      ? ["remote", "set-url", input.remoteName, input.remoteUrl]
      : ["remote", "add", input.remoteName, input.remoteUrl],
    "add_target_remote",
    "Agents could not add the selected target repo as a git remote in the local landing checkout.",
    "target_remote_failed",
  );
}

function pushBranchToTarget(input: { landingPath: string; remoteName: string; branch: string }): void {
  runGit(
    input.landingPath,
    ["push", input.remoteName, `${input.branch}:${input.branch}`],
    "push_branch_to_target",
    "Agents could not push the landing branch to the selected target repo.",
    "push_branch_failed",
  );
}

function createRemoteExecutionCheckout(input: {
  target: ImplementationTarget;
  remoteRepoPath: string;
  worktreeName: string;
  branch: string;
}): { path: string; headSha?: string } {
  const script = [
    "set -e",
    `repo_path=${shellQuote(input.remoteRepoPath)}`,
    `worktree_name=${shellQuote(input.worktreeName)}`,
    `branch_name=${shellQuote(input.branch)}`,
    'worktree_root="${repo_path}.worktrees"',
    'execution_path="$worktree_root/$worktree_name"',
    'mkdir -p "$worktree_root"',
    'if [ ! -d "$execution_path/.git" ]; then git -C "$repo_path" worktree add "$execution_path" "$branch_name" >/dev/null; fi',
    'head_sha=$(git -C "$execution_path" rev-parse HEAD)',
    'printf "path=%s\\nheadSha=%s\\n" "$execution_path" "$head_sha"',
  ].join("; ");

  const output = runSsh({
    target: input.target,
    command: script,
    phase: "create_execution_checkout",
    code: "execution_checkout_failed",
    message: `Could not create the remote execution checkout on ${input.target.displayName}.`,
  });
  const parsed = parseKeyValueOutput(output);
  if (!parsed.path) {
    fail({
      phase: "create_execution_checkout",
      code: "execution_checkout_path_missing",
      message: `Created the remote execution checkout on ${input.target.displayName}, but no path was reported.`,
      targetId: input.target.id,
      retryable: true,
    });
  }

  return { path: parsed.path, headSha: parsed.headSha };
}

export function createImplementationCheckout(options: CheckoutCreateOptions): CheckoutCreateResult {
  const sourceRepoPath = path.resolve(options.sourceRepoPath ?? options.repoRoot ?? process.cwd());
  const repoRoot = resolveRepoRoot(sourceRepoPath);
  const repoName = options.repoName?.trim() || path.basename(repoRoot);
  const target = resolveImplementationTarget({ ...options, repoRoot });
  const { baseRef, baseCommit } = resolveBaseRef(repoRoot, options.baseRef);
  const { startRef, startCommit } = resolveStartRef(repoRoot, options.startRef, baseRef);
  const identity = chooseCheckoutIdentity({
    repoRoot,
    repoName,
    name: options.name,
    branch: options.branch,
    reuseExisting: options.reuseExisting,
  });

  if (target.kind === "local") {
    createLocalWorktree({
      repoRoot,
      checkoutPath: identity.path,
      branch: identity.branch,
      startRef,
      phase: "create_execution_checkout",
    });
    snapshotContextPaths({
      sourceRepoRoot: repoRoot,
      checkoutPath: identity.path,
      snapshotPaths: options.snapshotPaths,
    });
    const headSha = runGit(identity.path, ["rev-parse", "HEAD"], "snapshot_context", "Agents could not resolve implementation checkout HEAD after snapshot context setup.");

    return {
      ok: true,
      phase: "complete",
      targetId: target.id,
      repoName,
      branch: identity.branch,
      baseRef,
      baseCommit,
      startRef,
      startCommit,
      executionCheckout: {
        checkoutId: buildCheckoutId(target.id, repoName, identity.worktreeName),
        targetId: target.id,
        role: "execution",
        repoPath: repoRoot,
        path: identity.path,
        branch: identity.branch,
        baseRef,
        baseCommit,
        startRef,
        startCommit,
        headSha,
      },
    };
  }

  const remoteRepoRoot = target.repoRoots[0];
  if (!remoteRepoRoot) {
    fail({
      phase: "resolve_repo_root",
      code: "repo_root_missing",
      message: `Target "${target.displayName}" does not have a repo root configured.`,
      targetId: target.id,
      retryable: true,
    });
  }

  checkRemoteRuntime(target);
  const originRemoteUrl = getOriginRemoteUrl(repoRoot, options.remoteUrl);

  createLocalWorktree({
    repoRoot,
    checkoutPath: identity.path,
    branch: identity.branch,
    startRef,
    phase: "create_landing_checkout",
  });
  snapshotContextPaths({
    sourceRepoRoot: repoRoot,
    checkoutPath: identity.path,
    snapshotPaths: options.snapshotPaths,
  });

  const landingCheckout: ImplementationCheckout = {
    checkoutId: buildCheckoutId("local", repoName, identity.worktreeName),
    targetId: "local",
    role: "landing",
    repoPath: repoRoot,
    path: identity.path,
    branch: identity.branch,
    baseRef,
    baseCommit,
    startRef,
    startCommit,
    headSha: runGit(identity.path, ["rev-parse", "HEAD"], "snapshot_context", "Agents could not resolve landing checkout HEAD after snapshot context setup."),
  };
  let executionCheckoutMetadata: ImplementationCheckout | undefined;

  const partialCheckoutResult = (): CheckoutCreatePartialResult => ({
    targetId: target.id,
    repoName,
    branch: identity.branch,
    baseRef,
    baseCommit,
    startRef,
    startCommit,
    landingCheckout,
    ...(executionCheckoutMetadata ? { executionCheckout: executionCheckoutMetadata } : {}),
  });

  try {
    const remoteRepo = ensureRemoteRepo({
      target,
      repoRoot: remoteRepoRoot,
      repoName,
      remoteUrl: originRemoteUrl,
      cloneIfMissing: options.cloneIfMissing,
    });
    const remoteName = `agents-${slugifySegment(target.displayName).slice(0, 40) || "target"}`;
    const targetRemoteUrl = buildSshRepoUrl(target.id, remoteRepo.repoPath);
    landingCheckout.remoteName = remoteName;
    landingCheckout.remoteUrl = targetRemoteUrl;
    addOrUpdateRemote({
      landingPath: identity.path,
      remoteName,
      remoteUrl: targetRemoteUrl,
    });
    pushBranchToTarget({
      landingPath: identity.path,
      remoteName,
      branch: identity.branch,
    });
    const executionCheckout = createRemoteExecutionCheckout({
      target,
      remoteRepoPath: remoteRepo.repoPath,
      worktreeName: identity.worktreeName,
      branch: identity.branch,
    });
    executionCheckoutMetadata = {
      checkoutId: buildCheckoutId(target.id, repoName, identity.worktreeName),
      targetId: target.id,
      role: "execution",
      repoPath: remoteRepo.repoPath,
      path: executionCheckout.path,
      branch: identity.branch,
      baseRef,
      baseCommit,
      startRef,
      startCommit,
      cloned: remoteRepo.cloned,
      headSha: executionCheckout.headSha,
    };
  } catch (error) {
    if (error instanceof AgentsRuntimeError) {
      throw new AgentsRuntimeError({
        phase: error.phase,
        code: error.code,
        message: error.message,
        targetId: error.targetId,
        retryable: error.retryable,
        details: error.details,
        partialResult: {
          ...(error.partialResult ?? {}),
          checkout: partialCheckoutResult(),
        },
      });
    }
    throw error;
  }

  if (!executionCheckoutMetadata) {
    fail({
      phase: "create_execution_checkout",
      code: "execution_checkout_missing",
      message: `Created the remote execution checkout on ${target.displayName}, but no checkout metadata was produced.`,
      targetId: target.id,
      retryable: true,
      partialResult: { checkout: partialCheckoutResult() },
    });
  }

  return {
    ok: true,
    phase: "complete",
    targetId: target.id,
    repoName,
    branch: identity.branch,
    baseRef,
    baseCommit,
    startRef,
    startCommit,
    landingCheckout,
    executionCheckout: executionCheckoutMetadata,
  };
}

function sessionsForPath(checkoutPath: string): string[] {
  const normalizedPath = path.resolve(checkoutPath);
  return scan()
    .filter((entry) => entry.cwd && path.resolve(entry.cwd) === normalizedPath)
    .flatMap((entry) => entry.tmuxPaneId || entry.paneId || entry.pane ? [entry.tmuxPaneId || entry.paneId || entry.pane || ""] : [])
    .filter(Boolean);
}

function resolveStatusRepoRoot(sourcePath: string): string {
  return runGit(
    sourcePath,
    ["rev-parse", "--show-toplevel"],
    "refresh_status",
    "Agents could not inspect checkout status because the path is not a git checkout.",
    "status_repo_missing",
  );
}

function resolveStatusBaseRef(
  checkoutPath: string,
  explicitBaseRef: string | undefined,
  warnings: Array<{ phase: RuntimePhase; message: string }>,
): string | undefined {
  if (explicitBaseRef?.trim()) return explicitBaseRef.trim();

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const result = runGitMaybe(checkoutPath, ["rev-parse", "--verify", `${candidate}^{commit}`]);
    if (result.ok && result.stdout) return candidate;
  }

  warnings.push({ phase: "refresh_status", message: "Could not resolve a base ref for ahead/behind and merged status." });
  return undefined;
}

function inspectLocalCheckout(input: {
  checkoutPath: string;
  targetId: string;
  repoName?: string;
  checkoutId?: string;
  branch?: string;
  baseRef?: string;
  baseCommit?: string;
  role?: ImplementationCheckoutRole;
}): { checkout: ImplementationCheckout; warnings: Array<{ phase: RuntimePhase; message: string }> } {
  const checkoutPath = path.resolve(input.checkoutPath);
  const repoRoot = runGit(
    checkoutPath,
    ["rev-parse", "--show-toplevel"],
    "refresh_status",
    "Agents could not inspect checkout status because the path is not a git checkout.",
    "status_repo_missing",
  );
  const repoName = input.repoName?.trim() || path.basename(repoRoot);
  const branch = input.branch || runGit(checkoutPath, ["rev-parse", "--abbrev-ref", "HEAD"], "refresh_status", "Agents could not resolve the checkout branch.");
  const headSha = runGit(checkoutPath, ["rev-parse", "HEAD"], "refresh_status", "Agents could not resolve the checkout head commit.");
  const dirty = runGitMaybe(checkoutPath, ["status", "--porcelain"]).stdout.length > 0;
  const warnings: Array<{ phase: RuntimePhase; message: string }> = [];
  const baseRef = resolveStatusBaseRef(checkoutPath, input.baseRef, warnings);
  const baseCommit = input.baseCommit || (baseRef ? runGitMaybe(checkoutPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]).stdout || undefined : undefined);
  const checkout: ImplementationCheckout = {
    checkoutId: input.checkoutId || buildCheckoutId(input.targetId, repoName, path.basename(checkoutPath)),
    targetId: input.targetId,
    role: input.role || "execution",
    repoPath: repoRoot,
    path: checkoutPath,
    branch,
    baseRef,
    baseCommit,
    headSha,
    dirty,
    sessions: sessionsForPath(checkoutPath),
  };

  if (baseRef) {
    const counts = runGitMaybe(checkoutPath, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`]);
    if (counts.ok) {
      const [behindRaw, aheadRaw] = counts.stdout.split(/\s+/);
      checkout.behind = Number(behindRaw) || 0;
      checkout.ahead = Number(aheadRaw) || 0;
    } else {
      warnings.push({ phase: "refresh_status", message: `Could not compute ahead/behind against ${baseRef}.` });
    }

    const merged = runGitMaybe(checkoutPath, ["merge-base", "--is-ancestor", "HEAD", baseRef]);
    checkout.merged = merged.ok;
  }

  return { checkout, warnings };
}

function implementationWorktreeRoots(repoRoot: string, repoName: string): string[] {
  return [
    path.join(path.dirname(repoRoot), ".shape-worktrees", repoName),
    `${repoRoot}.worktrees`,
  ];
}

function discoverImplementationWorktrees(repoRoot: string, repoName: string): WorktreeEntry[] {
  const roots = implementationWorktreeRoots(repoRoot, repoName);
  const output = runGit(
    repoRoot,
    ["worktree", "list", "--porcelain"],
    "refresh_status",
    "Agents could not list implementation checkouts for this repo.",
    "status_worktree_list_failed",
  );

  return parseWorktreeListOutput(output).filter((entry) => {
    const normalizedPath = path.resolve(entry.path);
    if (normalizedPath === path.resolve(repoRoot)) return false;
    return roots.some((root) => isPathInside(normalizedPath, root));
  });
}

function statusForLocalCheckout(options: CheckoutStatusOptions, targetId: string): CheckoutStatusResult {
  if (options.path) {
    const inspected = inspectLocalCheckout({
      checkoutPath: options.path,
      targetId,
      repoName: options.repoName,
      checkoutId: options.checkoutId,
      branch: options.branch,
      baseRef: options.baseRef,
      baseCommit: options.baseCommit,
      role: options.role,
    });

    return {
      ok: true,
      phase: "refresh_status",
      targetId,
      repoName: options.repoName?.trim() || path.basename(inspected.checkout.repoPath),
      checkouts: [inspected.checkout],
      ...(inspected.warnings.length ? { warnings: inspected.warnings } : {}),
    };
  }

  const repoRoot = resolveStatusRepoRoot(path.resolve(options.repoRoot ?? process.cwd()));
  const repoName = options.repoName?.trim() || path.basename(repoRoot);
  const warnings: Array<{ phase: RuntimePhase; message: string }> = [];
  const checkouts: ImplementationCheckout[] = [];

  for (const entry of discoverImplementationWorktrees(repoRoot, repoName)) {
    const checkoutId = buildCheckoutId(targetId, repoName, path.basename(entry.path));
    if (options.checkoutId && options.checkoutId !== checkoutId) continue;
    if (options.branch && options.branch !== entry.branch) continue;

    try {
      const inspected = inspectLocalCheckout({
        checkoutPath: entry.path,
        targetId,
        repoName,
        checkoutId,
        branch: options.branch || entry.branch,
        baseRef: options.baseRef,
        baseCommit: options.baseCommit,
        role: options.role,
      });
      checkouts.push(inspected.checkout);
      warnings.push(...inspected.warnings);
    } catch (error) {
      warnings.push({
        phase: "refresh_status",
        message: error instanceof Error ? error.message : `Could not inspect implementation checkout at ${entry.path}.`,
      });
    }
  }

  return {
    ok: true,
    phase: "refresh_status",
    targetId,
    repoName,
    checkouts,
    ...(warnings.length ? { warnings } : {}),
  };
}

function runRemoteAgentsJson<T>(target: ImplementationTarget, args: string[], phase: RuntimePhase): T {
  checkRemoteRuntime(target);
  const command = shellJoin(["agents", ...args]);
  const result = runSshRaw({
    target,
    command,
    phase,
    code: `${phase}_failed`,
    message: `Remote agents ${phase} command failed on ${target.displayName}.`,
  });
  if (!result.ok) {
    const remoteFailure = runtimeFailureFromJson(result.stdout) ?? runtimeFailureFromJson(result.stderr);
    if (remoteFailure) {
      fail({
        phase: remoteFailure.phase,
        code: remoteFailure.code,
        message: remoteFailure.message,
        targetId: target.id,
        retryable: remoteFailure.retryable,
        details: {
          ...(remoteFailure.details ?? {}),
          remoteTargetId: remoteFailure.targetId,
          stdout: result.stdout,
          stderr: result.stderr,
          status: result.status,
        },
        partialResult: remoteFailure.partialResult,
      });
    }

    fail({
      phase,
      code: `${phase}_failed`,
      message: `Remote agents ${phase} command failed on ${target.displayName}.`,
      targetId: target.id,
      retryable: true,
      details: {
        command: ["ssh", ...buildSshArgs(target.id, command)].join(" "),
        stderr: result.stderr,
        stdout: result.stdout,
        status: result.status,
      },
    });
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    fail({
      phase,
      code: "invalid_remote_json",
      message: `Remote agents ${phase} command on ${target.displayName} did not return valid JSON.`,
      targetId: target.id,
      retryable: true,
      details: { output: result.stdout, error: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function getImplementationCheckoutStatus(options: CheckoutStatusOptions = {}): CheckoutStatusResult {
  const target = resolveImplementationTarget(options);
  if (target.kind === "ssh") {
    const repoName = options.repoName?.trim() || path.basename(resolveStatusRepoRoot(path.resolve(options.repoRoot ?? process.cwd())));
    const remoteRepoPath = options.path ? undefined : remoteRepoPathForStatus(target, repoName);
    const remoteResult = runRemoteAgentsJson<CheckoutStatusResult>(
      target,
      [
        "checkout",
        "status",
        "--target",
        "local",
        ...(remoteRepoPath ? ["--repo-root", remoteRepoPath] : []),
        ...(options.repoName ? ["--repo", options.repoName] : []),
        ...(options.checkoutId ? ["--checkout-id", options.checkoutId] : []),
        ...(options.path ? ["--path", options.path] : []),
        ...(options.branch ? ["--branch", options.branch] : []),
        ...(options.baseRef ? ["--base", options.baseRef] : []),
        ...(options.baseCommit ? ["--base-commit", options.baseCommit] : []),
        ...(options.role ? ["--role", options.role] : []),
        "--json",
      ],
      "refresh_status",
    );
    return {
      ...remoteResult,
      targetId: target.id,
      checkouts: remoteResult.checkouts.map((checkout) => ({
        ...checkout,
        checkoutId: checkout.checkoutId.startsWith("local:") ? `${target.id}:${checkout.checkoutId.slice("local:".length)}` : checkout.checkoutId,
        targetId: target.id,
      })),
    };
  }

  return statusForLocalCheckout(options, target.id);
}

export function startImplementationSession(options: SessionStartOptions): SessionStartResult {
  const target = resolveImplementationTarget(options);
  if (target.kind === "ssh") {
    const remoteResult = runRemoteAgentsJson<SessionStartResult>(
      target,
      [
        "session",
        "start",
        "--target",
        "local",
        "--checkout-id",
        options.checkoutId,
        "--path",
        options.path,
        "--profile",
        options.profile,
        "--name",
        options.name,
        ...(options.tmuxSession ? ["--tmux-session", options.tmuxSession] : []),
        "--json",
        ...(options.overrides?.length ? ["--", ...options.overrides] : []),
      ],
      "start_session",
    );
    return {
      ...remoteResult,
      session: {
        ...remoteResult.session,
        targetId: target.id,
        checkoutId: options.checkoutId,
      },
    };
  }

  const startedAt = new Date();
  const tmuxSession = options.tmuxSession || (process.env.TMUX ? undefined : "agents");
  let launch: WorkspaceLaunchResult;
  try {
    launch = createWorkspaceOrThrow(undefined, options.name, undefined, {
      profile: options.profile,
      cwd: options.path,
      agentOnly: true,
      directAgentLaunch: true,
      detached: true,
      requireDiscoverable: true,
      tmuxSession,
      createTmuxSessionIfMissing: Boolean(tmuxSession),
      overrideArgs: options.overrides ?? [],
    });
  } catch (error) {
    fail({
      phase: "start_session",
      code: "session_start_failed",
      message: error instanceof Error ? error.message : String(error),
      targetId: target.id,
      retryable: true,
    });
  }

  const paneId = launch.tmuxPaneId ?? launch.paneId;
  return {
    ok: true,
    phase: "start_session",
    session: {
      sessionId: options.name,
      targetId: target.id,
      checkoutId: options.checkoutId,
      profile: options.profile,
      transport: "tmux",
      tmuxSession: launch.sessionName ?? tmuxSession,
      paneId,
      startedAt: startedAt.toISOString(),
    },
    launch,
  };
}

function findSessionPane(options: SessionResumeOptions): string | undefined {
  const normalizedPath = options.path ? path.resolve(options.path) : undefined;
  const match = scan().find((entry) => {
    if (options.pane && (entry.tmuxPaneId === options.pane || entry.paneId === options.pane || entry.pane === options.pane)) return true;
    if (entry.pane?.includes(`:${options.sessionId}:`)) return true;
    if (normalizedPath && entry.cwd && path.resolve(entry.cwd) === normalizedPath) return true;
    return false;
  });

  return match?.tmuxPaneId ?? match?.paneId ?? match?.pane ?? options.pane;
}

export function resumeImplementationSession(options: SessionResumeOptions): SessionResumeResult {
  const target = resolveImplementationTarget(options);
  if (target.kind === "ssh") {
    const remoteResult = runRemoteAgentsJson<SessionResumeResult>(
      target,
      [
        "session",
        "resume",
        "--target",
        "local",
        "--session",
        options.sessionId,
        ...(options.checkoutId ? ["--checkout-id", options.checkoutId] : []),
        ...(options.path ? ["--path", options.path] : []),
        ...(options.profile ? ["--profile", options.profile] : []),
        ...(options.pane ? ["--pane", options.pane] : []),
        ...(options.prompt ? ["--prompt", options.prompt] : []),
        ...(options.newSession ? ["--new-session"] : []),
        "--json",
      ],
      "resume_session",
    );
    return {
      ...remoteResult,
      targetId: target.id,
    };
  }

  const pane = findSessionPane(options);
  if (!pane) {
    fail({
      phase: "resume_session",
      code: "session_not_found",
      message: `Agents could not find a live tmux pane for session "${options.sessionId}".`,
      targetId: target.id,
      retryable: true,
    });
  }

  if (options.newSession || options.prompt) {
    const result = resumeAgentSession({
      pane,
      profile: options.profile,
      newSession: options.newSession,
      prompt: options.prompt,
      force: true,
    });
    if (!result.ok) {
      fail({
        phase: "resume_session",
        code: "resume_failed",
        message: result.message || `Could not resume session "${options.sessionId}".`,
        targetId: target.id,
        retryable: true,
      });
    }
    return {
      ok: true,
      phase: "resume_session",
      sessionId: options.sessionId,
      targetId: target.id,
      paneId: result.tmuxPaneId ?? result.pane ?? pane,
      status: result.status,
      attached: false,
      message: result.message,
    };
  }

  return {
    ok: true,
    phase: "resume_session",
    sessionId: options.sessionId,
    targetId: target.id,
    paneId: pane,
    attached: false,
    message: `Attach with: tmux select-pane -t ${pane}`,
  };
}

export function listTargetAgentSessions(options: TargetAgentSessionsOptions = {}): TargetAgentSessionsResult {
  const target = resolveImplementationTarget(options);
  if (target.kind === "ssh") {
    const remoteSessions = runRemoteAgentsJson<TargetAgentSessionEntry[]>(
      target,
      ["list", "--json"],
      "refresh_status",
    );
    return {
      ok: true,
      phase: "refresh_status",
      targetId: target.id,
      sessions: remoteSessions,
    };
  }

  return {
    ok: true,
    phase: "refresh_status",
    targetId: target.id,
    sessions: scan().map((entry) => ({
      pane: entry.pane,
      paneId: entry.paneId,
      tmuxPaneId: entry.tmuxPaneId,
      agent: entry.agent,
      status: entry.status,
      cwd: entry.cwd,
    })),
  };
}
