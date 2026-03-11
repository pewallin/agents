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

export interface Config {
  helpers: Record<string, HelperDef[]>;
  workspace: WorkspaceDef[] | Record<string, WorkspaceDef[]>;
  defaultCommand: string;
}

const CONFIG_PATH = join(homedir(), ".agents", "config.json");

let _cached: Config | null = null;

const DEFAULT_CONFIG: Config = {
  defaultCommand: "claude --dangerously-skip-permissions",
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

export function loadConfig(): Config {
  if (_cached) return _cached;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const ws = raw.workspace;
    _cached = {
      helpers: parseHelpers(raw.helpers ?? DEFAULT_CONFIG.helpers),
      workspace: Array.isArray(ws) ? ws : (ws && typeof ws === "object" ? ws : DEFAULT_CONFIG.workspace),
      defaultCommand: raw.defaultCommand || DEFAULT_CONFIG.defaultCommand,
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
