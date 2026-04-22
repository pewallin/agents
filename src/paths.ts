import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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

export function ensureAgentsDirs(): void {
  mkdirSync(getAgentsHome(), { recursive: true });
  mkdirSync(getStateDir(), { recursive: true });
  mkdirSync(getContributorStateDir(), { recursive: true });
  mkdirSync(getLogsDir(), { recursive: true });
  mkdirSync(getRuntimeTempDir(), { recursive: true });
}
