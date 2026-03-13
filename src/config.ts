import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface HelperDef {
  process: string;           // match against pane_current_command
  split: "left" | "right" | "above" | "below";
  of?: string;               // pane to split from (default: "agent")
  size?: string;             // tmux -l value, e.g. "20%" or "30" (default: 20%)
}

export interface WorkspaceDef {
  command: string;             // shell command to run in this pane
  split?: "left" | "right" | "above" | "below";  // direction relative to "of"
  of?: string;                 // pane to split from (default: "agent")
  size?: string;               // tmux -l value, e.g. "30%" or "20"
}

export interface LaunchProfile {
  command: string;             // shell command to launch the agent
  workspace?: string;          // workspace layout name (default: "default")
  name?: string;               // display name for tmux window
  env?: Record<string, string>; // extra environment variables
}

export interface Config {
  helpers: Record<string, HelperDef[]>;
  workspace: WorkspaceDef[] | Record<string, WorkspaceDef[]>;
  defaultCommand: string;
  profiles: Record<string, LaunchProfile>;
  defaultProfile: string;
}

const CONFIG_PATH = join(homedir(), ".agents", "config.json");

let _cached: Config | null = null;

const DEFAULT_CONFIG: Config = {
  defaultCommand: "claude --dangerously-skip-permissions",
  profiles: {
    claude: { command: "claude --dangerously-skip-permissions", workspace: "default" },
  },
  defaultProfile: "claude",
  helpers: {
    default: [
      { process: "lazygit", split: "left", size: "20%" },
      { process: "yazi", split: "below", of: "lazygit", size: "35%" },
      { process: "bv", split: "right", size: "25%" },
      { process: "zsh", split: "below", of: "bv", size: "25%" },
    ],
    small: [
      { process: "lazygit", split: "right", size: "25%" },
      { process: "bv", split: "below", of: "lazygit", size: "40%" },
    ],
  },
  workspace: {
    default: [
      { command: "lazygit", split: "left", size: "23%" },
      { command: "yazi", split: "below", of: "lazygit", size: "30%" },
      { command: "bv", split: "right", size: "25%" },
      { command: "$SHELL", split: "below", of: "bv", size: "18%" },
    ],
    small: [
      { command: "lazygit", split: "right", size: "35%" },
      { command: "bv", split: "below", of: "lazygit", size: "40%" },
    ],
  },
};

function parseHelpers(raw: any): Record<string, HelperDef[]> {
  if (Array.isArray(raw)) return raw.length ? { default: raw } : {};
  if (raw && typeof raw === "object") return raw;
  return {};
}

/** Build profiles from config, falling back to defaultCommand for backward compat. */
function parseProfiles(raw: any): { profiles: Record<string, LaunchProfile>; defaultProfile: string } {
  if (raw.profiles && typeof raw.profiles === "object") {
    return {
      profiles: raw.profiles,
      defaultProfile: raw.defaultProfile || Object.keys(raw.profiles)[0] || "default",
    };
  }
  // Backward compat: synthesize a profile from defaultCommand
  const cmd = raw.defaultCommand || DEFAULT_CONFIG.defaultCommand;
  return {
    profiles: { default: { command: cmd, workspace: "default" } },
    defaultProfile: "default",
  };
}

export function loadConfig(): Config {
  if (_cached) return _cached;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const ws = raw.workspace;
    const { profiles, defaultProfile } = parseProfiles(raw);
    _cached = {
      helpers: parseHelpers(raw.helpers ?? DEFAULT_CONFIG.helpers),
      workspace: Array.isArray(ws) ? ws : (ws && typeof ws === "object" ? ws : DEFAULT_CONFIG.workspace),
      defaultCommand: raw.defaultCommand || DEFAULT_CONFIG.defaultCommand,
      profiles,
      defaultProfile,
    };
  } catch {
    _cached = { ...DEFAULT_CONFIG };
  }
  return _cached;
}

export function reloadConfig(): Config {
  _cached = null;
  return loadConfig();
}

/** Resolve a profile by name, falling back to the default profile. */
export function resolveProfile(profileName?: string): LaunchProfile {
  const config = loadConfig();
  const name = profileName || config.defaultProfile;
  return config.profiles[name] || config.profiles[config.defaultProfile] || { command: config.defaultCommand, workspace: "default" };
}

/** Get all profile names. */
export function getProfileNames(): string[] {
  return Object.keys(loadConfig().profiles);
}
