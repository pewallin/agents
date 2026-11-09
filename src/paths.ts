import { mkdirSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** Set by scripts/build-binary.ts when the CLI is compiled to a single executable. */
declare const AGENTS_BUILD_INFO: string | undefined;

export interface AgentsBuildInfo {
  version: string;
  gitCommit: string;
  /** src/, extensions/ or package files had uncommitted changes when it was built. */
  dirty: boolean;
  target: string;
  builtAt: string;
}

/** Build metadata of a compiled binary; undefined when running from dist/ or src/. */
export function getBuildInfo(): AgentsBuildInfo | undefined {
  if (typeof AGENTS_BUILD_INFO === "undefined" || !AGENTS_BUILD_INFO) return undefined;
  return JSON.parse(AGENTS_BUILD_INFO) as AgentsBuildInfo;
}

export function isCompiledBinary(): boolean {
  return getBuildInfo() !== undefined;
}

/** The directory that holds extensions/ and the other files shipped beside the code: the repo
 *  root when running from dist/ or src/, the executable's directory for a compiled binary (its
 *  code lives in Bun's virtual file system, so import.meta.url does not point at real files). */
export function getResourceRoot(): string {
  if (process.env.AGENTS_RESOURCE_ROOT) return process.env.AGENTS_RESOURCE_ROOT;
  if (isCompiledBinary()) return dirname(process.execPath);
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Where the app installs compiled binaries (<shared home>/agents-cli/versions/<commit>/agents). */
export function getManagedCliRoot(): string {
  return process.env.AGENTS_MANAGED_CLI_ROOT || join(resolveSharedAgentsHome(), "agents-cli");
}

/** A compiled binary outside the app's install location, e.g. a fresh dist-bin/ build being
 *  tried out. It must not point the user's hooks at itself on its own. */
export function isUninstalledBinary(): boolean {
  if (!isCompiledBinary()) return false;
  // execPath is a real path; the root may be reached through a symlink (/tmp on macOS).
  const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  return !real(process.execPath).startsWith(real(getManagedCliRoot()) + "/");
}

/** How to start this CLI again: [binary] when compiled, [node, cli.js] otherwise; empty when
 *  the script is unknown. */
export function getSelfArgv(): string[] {
  if (isCompiledBinary()) return [process.execPath];
  return process.argv[1] ? [process.execPath, process.argv[1]] : [];
}

// Every folder the CLI and the app share is worked out here, from two names: the shared folder
// (~/.agents, AGENTS_SHARED_HOME) and the app's folder in it (agents-app, AGENTS_PRODUCT_DIRNAME,
// which a private app instance sets). Renaming the app changes DEFAULT_PRODUCT_DIRNAME alone.
// Agents Next follows the same rules (AgentsPaths in AgentsCore).
const DEFAULT_SHARED_FOLDER = ".agents";
export const DEFAULT_PRODUCT_DIRNAME = "agents-app";

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}

/** ~/.agents: the folder several agents share (skills, the user's instructions, programs). */
export function getSharedAgentsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_SHARED_HOME || join(homeOf(env), DEFAULT_SHARED_FOLDER);
}

/** The app instance's folder in it: ~/.agents/agents-app, or a private instance's own. */
export function getProductHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(getSharedAgentsHome(env), env.AGENTS_PRODUCT_DIRNAME || DEFAULT_PRODUCT_DIRNAME);
}

function resolveSharedAgentsHome(): string {
  return getSharedAgentsHome();
}

/** Where the CLI keeps its state: AGENTS_HOME, else the app instance's folder. */
function resolveAgentsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_HOME || getProductHome(env);
}

export function getAgentsHome(): string {
  return resolveAgentsHome();
}

export function getStateDir(): string {
  return process.env.AGENTS_STATE_DIR || join(resolveAgentsHome(), "state");
}

export function getContributorStateDir(): string {
  return process.env.AGENTS_CONTRIB_STATE_DIR || join(resolveAgentsHome(), "state-contrib");
}

export function getConfigPath(): string {
  return process.env.AGENTS_CONFIG_PATH || join(resolveAgentsHome(), "config.json");
}

export function getSetupHashPath(): string {
  return process.env.AGENTS_SETUP_HASH_PATH || join(resolveAgentsHome(), ".setup-hash");
}


export function getLogsDir(): string {
  return process.env.AGENTS_LOG_DIR || join(resolveAgentsHome(), "logs");
}

export function getRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_RUNTIME_DIR || join(resolveAgentsHome(env), "runtime");
}

/** ACP hosts' metadata, steer inboxes and Codex app-server endpoints of the panes. */
export function getRuntimeTempDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_TMP_DIR || join(getRuntimeDir(env), "tmp");
}

/** The app's own runtime folder: its control socket and token. */
export function getAppRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_APP_RUNTIME_DIR || join(getProductHome(env), "app", "runtime");
}

/** The command every agent of the app instance runs agents-app-control by. */
export function getSharedAppControlPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getProductHome(env), "bin", "agents-app-control");
}

/** Where coordinators keep their programs (briefs, reports, messages), shared by app instances. */
export function getProgramsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getSharedAgentsHome(env), "programs");
}

/** What the user wants every coordinator and worker to know; the app's Settings edits it. */
export function getUserInstructionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_INSTRUCTIONS_PATH || join(getSharedAgentsHome(env), "instructions.md");
}

/** The app's remote hosts. */
export function getRemoteHostConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getProductHome(env), "app", "config", "remote-hosts.json");
}

export function getRuntimeStateEventsPath(): string {
  return process.env.AGENTS_RUNTIME_STATE_EVENTS_PATH || join(getRuntimeDir(), "state-events.jsonl");
}

export function getDoneStorePath(): string {
  return process.env.AGENTS_DONE_STORE_PATH || join(resolveAgentsHome(), "recent-done.json");
}

export function ensureAgentsDirs(): void {
  mkdirSync(getAgentsHome(), { recursive: true });
  mkdirSync(getStateDir(), { recursive: true });
  mkdirSync(getContributorStateDir(), { recursive: true });
  mkdirSync(getLogsDir(), { recursive: true });
  mkdirSync(getRuntimeTempDir(), { recursive: true });
}
