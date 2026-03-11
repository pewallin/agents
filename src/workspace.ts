import { execSync } from "child_process";
import { loadConfig } from "./config.js";
import type { WorkspaceDef } from "./config.js";

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
    { command: "bv", split: "below", size: "20%" },
    { command: "lazygit", split: "right", size: "35%" },
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

export function createWorkspace(agentCmd: string, name?: string, layout?: string): void {
  const config = loadConfig();
  const defs = resolveLayout(config, layout);

  const windowName = name || agentCmd.split(/\s+/)[0];

  // Create window with interactive shell, then send the agent command.
  // This ensures .zshrc/.bashrc is loaded so aliases and PATH are available.
  const agentPaneId = exec(
    `tmux new-window -n ${JSON.stringify(windowName)} -P -F '#{pane_id}'`
  );
  if (!agentPaneId) {
    console.error("Failed to create tmux window");
    process.exit(1);
  }
  exec(`tmux send-keys -t ${agentPaneId} ${JSON.stringify(agentCmd)} Enter`);

  const paneMap: Record<string, string> = { agent: agentPaneId };

  for (const def of defs) {
    const targetId = paneMap[def.of || "agent"] || agentPaneId;
    const dir = def.split || "right";
    const flags = dir === "left"  ? "-hb" :
                  dir === "right" ? "-h" :
                  dir === "above" ? "-vb" :
                                    "-v";
    const sizeFlag = def.size ? ` -l ${def.size}` : "";
    const cmd = def.command;

    // Start an interactive shell, then send the command
    const paneId = exec(
      `tmux split-window ${flags} -d${sizeFlag} -t ${targetId} -P -F '#{pane_id}'`
    );
    if (paneId) {
      if (cmd !== "$SHELL") {
        exec(`tmux send-keys -t ${paneId} ${JSON.stringify(cmd)} Enter`);
      }
      const label = cmd.replace(/^\$/, "").split(/\s+/)[0].toLowerCase();
      paneMap[label] = paneId;
    }
  }

  // Focus the agent pane
  exec(`tmux select-pane -t ${agentPaneId}`);
}
