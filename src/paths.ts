import { mkdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

function resolveAgentsHome(): string {
  return process.env.AGENTS_HOME || join(homedir(), ".agents");
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

export function getRuntimeTempDir(): string {
  return process.env.AGENTS_RUNTIME_DIR || tmpdir();
}

export function ensureAgentsDirs(): void {
  mkdirSync(getStateDir(), { recursive: true });
  mkdirSync(getContributorStateDir(), { recursive: true });
}
