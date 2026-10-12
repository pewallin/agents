import { mkdirSync } from "fs";
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
  return !process.execPath.startsWith(getManagedCliRoot() + "/");
}

/** How to start this CLI again: [binary] when compiled, [node, cli.js] otherwise; empty when
 *  the script is unknown. */
export function getSelfArgv(): string[] {
  if (isCompiledBinary()) return [process.execPath];
  return process.argv[1] ? [process.execPath, process.argv[1]] : [];
}

const DEFAULT_SHARED_FOLDER = ".agents";
const DEFAULT_PRODUCT_DIRNAME = "agents-app";

function resolveSharedAgentsHome(): string {
  return process.env.AGENTS_SHARED_HOME || join(homedir(), DEFAULT_SHARED_FOLDER);
}

function resolveAgentsProductDirname(): string {
  return process.env.AGENTS_PRODUCT_DIRNAME || DEFAULT_PRODUCT_DIRNAME;
}

function resolveAgentsHome(): string {
  return process.env.AGENTS_HOME || join(resolveSharedAgentsHome(), resolveAgentsProductDirname());
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

export function getGridFocusFile(): string {
  return process.env.AGENTS_GRID_FOCUS_FILE || join(getStateDir(), "grid-focus");
}

export function getLogsDir(): string {
  return process.env.AGENTS_LOG_DIR || join(resolveAgentsHome(), "logs");
}

export function getRuntimeDir(): string {
  return process.env.AGENTS_RUNTIME_DIR || join(resolveAgentsHome(), "runtime");
}

export function getRuntimeTempDir(): string {
  return process.env.AGENTS_TMP_DIR || join(getRuntimeDir(), "tmp");
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
