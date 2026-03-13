import { execSync } from "child_process";
import { loadConfig, resolveProfile } from "./config.js";
import type { WorkspaceDef, LaunchProfile } from "./config.js";

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

const DEFAULT_LAYOUTS: Record<string, WorkspaceDef[]> = {
  default: [
    { command: "lazygit", split: "left", size: "23%" },
    { command: "bv", split: "right", size: "25%" },
    { command: "$SHELL", split: "below", of: "bv", size: "18%" },
  ],
  small: [
    { command: "lazygit", split: "right", size: "35%" },
    { command: "bv", split: "below", of: "lazygit", size: "40%" },
  ],
};

function resolveLayout(config: ReturnType<typeof loadConfig>, layout?: string): WorkspaceDef[] {
  const ws = config.workspace;
  if (Array.isArray(ws)) {
    // Flat array — only usable as "default"
    return ws.length ? ws : DEFAULT_LAYOUTS[layout || "default"] || DEFAULT_LAYOUTS.default;
  }
  // Named layouts object
  const name = layout || "default";
  if (ws[name]?.length) return ws[name];
  if (DEFAULT_LAYOUTS[name]) return DEFAULT_LAYOUTS[name];
  return DEFAULT_LAYOUTS.default;
}

export interface CreateWorkspaceOpts {
  agentCmd?: string;
  name?: string;
  layout?: string;
  profile?: string;
  cwd?: string;
  tmuxSession?: string;  // target tmux session for the new window
}

export function createWorkspace(agentCmd?: string, name?: string, layout?: string, opts?: Partial<CreateWorkspaceOpts>): void {
  const config = loadConfig();

  // Resolve command: explicit arg > profile > defaultCommand
  let cmd = agentCmd;
  let layoutName = layout;
  if (!cmd && opts?.profile) {
    const profile = resolveProfile(opts.profile);
    cmd = profile.command;
    layoutName = layoutName || profile.workspace;
    if (!name) name = profile.name || opts.profile;
  }
  cmd = cmd || config.defaultCommand;

  if (!cmd) {
    console.error("No command specified and no defaultCommand in config");
    process.exit(1);
  }

  const defs = resolveLayout(config, layoutName);
  const windowName = name || cmd.split(/\s+/)[0];

  // Build new-window command with optional target session and cwd
  let newWindowCmd = "tmux new-window";
  if (opts?.tmuxSession) {
    newWindowCmd += ` -t ${JSON.stringify(opts.tmuxSession + ":")}`;
  }
  newWindowCmd += ` -n ${JSON.stringify(windowName)} -P -F '#{pane_id}'`;
  if (opts?.cwd) {
    newWindowCmd += ` -c ${JSON.stringify(opts.cwd)}`;
  }

  // Create window with interactive shell, then send the agent command.
  // This ensures .zshrc/.bashrc is loaded so aliases and PATH are available.
  const agentPaneId = exec(newWindowCmd);
  if (!agentPaneId) {
    console.error("Failed to create tmux window");
    process.exit(1);
  }
  exec(`tmux send-keys -t ${agentPaneId} ${JSON.stringify(cmd)} Enter`);

  const paneMap: Record<string, string> = { agent: agentPaneId };

  for (const def of defs) {
    const targetId = paneMap[def.of || "agent"] || agentPaneId;
    const dir = def.split || "right";
    const flags = dir === "left"  ? "-hb" :
                  dir === "right" ? "-h" :
                  dir === "above" ? "-vb" :
                                    "-v";
    const sizeFlag = def.size ? ` -l ${def.size}` : "";
    const paneCmd = def.command;

    // Start an interactive shell, then send the command
    const cwdFlag = opts?.cwd ? ` -c ${JSON.stringify(opts.cwd)}` : "";
    const paneId = exec(
      `tmux split-window ${flags} -d${sizeFlag}${cwdFlag} -t ${targetId} -P -F '#{pane_id}'`
    );
    if (paneId) {
      if (paneCmd !== "$SHELL") {
        exec(`tmux send-keys -t ${paneId} ${JSON.stringify(paneCmd)} Enter`);
      }
      const label = paneCmd.replace(/^\$/, "").split(/\s+/)[0].toLowerCase();
      paneMap[label] = paneId;
    }
  }

  // Focus the agent pane
  exec(`tmux select-pane -t ${agentPaneId}`);
}
