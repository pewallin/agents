import { existsSync, mkdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { exec } from "./shell.js";
import { getMux, detectMultiplexer } from "./multiplexer.js";
import { loadConfig, resolveProfile } from "./config.js";
import { readStates, reportState } from "./state.js";
import type { WorkspaceDef, LaunchProfile } from "./config.js";
import type { StateEntry, WorkspaceSnapshot } from "./state.js";

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
  initProject?: boolean;
  agentOnly?: boolean;   // skip helper pane creation (app creates them on demand)
}

export interface RestorableWorkspace {
  key: string;
  agent: string;
  cwd: string;
  command: string;
  context?: string;
  sessionName?: string;
}

export type WorkspacePathState = "valid" | "creatable" | "invalid";

function nearestExistingAncestor(path: string): string | null {
  let cur = resolve(path);
  while (true) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function getWorkspacePathState(path: string): WorkspacePathState {
  if (!path) return "invalid";
  try {
    if (existsSync(path)) return statSync(path).isDirectory() ? "valid" : "invalid";
    const ancestor = nearestExistingAncestor(path);
    return ancestor && statSync(ancestor).isDirectory() ? "creatable" : "invalid";
  } catch {
    return "invalid";
  }
}

export function prepareWorkspaceDir(path: string): boolean {
  try {
    const state = getWorkspacePathState(path);
    if (state === "valid") return true;
    if (state !== "creatable") return false;
    mkdirSync(path, { recursive: true });
    exec(`git -C ${JSON.stringify(path)} init`);
    return existsSync(path) && statSync(path).isDirectory() && existsSync(join(path, ".git"));
  } catch {
    return false;
  }
}

export function getRestorableWorkspacesFromStates(entries: StateEntry[]): RestorableWorkspace[] {
  const seen = new Set<string>();
  const list: RestorableWorkspace[] = [];

  for (const entry of entries) {
    const ws = entry.workspace;
    if (!ws?.cwd || !ws.command) continue;
    const key = `${entry.agent}:${entry.session}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      key,
      agent: entry.agent,
      cwd: ws.cwd,
      command: ws.command,
      context: entry.context,
      sessionName: ws.sessionName,
    });
  }

  return list;
}

export function getRestorableWorkspaces(): RestorableWorkspace[] {
  return getRestorableWorkspacesFromStates(readStates());
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

  if (opts?.cwd && opts.initProject && !prepareWorkspaceDir(opts.cwd)) {
    console.error(`Failed to create project directory: ${opts.cwd}`);
    process.exit(1);
  }

  const defs = opts?.agentOnly ? [] : resolveLayout(config, layoutName);
  const baseName = name || cmd.split(/\s+/)[0];
  const cwdBase = (opts?.cwd || process.cwd()).split("/").pop() || "";
  const windowName = cwdBase ? `${baseName}:${cwdBase}` : baseName;

  // Build workspace snapshot at creation time — this is the authoritative
  // source for session name and cwd. Report hooks will preserve it.
  const muxKind = detectMultiplexer();
  const wsSnapshot: WorkspaceSnapshot = {
    command: cmd,
    cwd: opts?.cwd || process.cwd(),
    mux: muxKind || undefined,
    sessionName: opts?.tmuxSession || undefined,
  };

  if (muxKind === "zellij") {
    createWorkspaceZellij(cmd, windowName, defs, opts, wsSnapshot);
  } else {
    createWorkspaceTmux(cmd, windowName, defs, opts, wsSnapshot);
  }
}

/** Seed the state file with workspace metadata right after pane creation.
 *  This captures the authoritative session/cwd before preview swaps can muddy it. */
function seedWorkspaceState(agentPaneId: string, cmd: string, snapshot: WorkspaceSnapshot): void {
  // Infer agent name from command (e.g. "claude --dangerously-skip-permissions" → "claude")
  const agent = cmd.split(/\s+/)[0].replace(/.*\//, "").toLowerCase();
  // For tmux, also capture session name from the actual pane if not already set
  if (!snapshot.sessionName && agentPaneId.startsWith("%")) {
    try {
      snapshot.sessionName = exec(`tmux display-message -t ${agentPaneId} -p '#{session_name}'`) || undefined;
    } catch {}
  }
  reportState(agent, agentPaneId, "idle", undefined, snapshot);
}

function createWorkspaceZellij(cmd: string, windowName: string, defs: WorkspaceDef[], opts?: Partial<CreateWorkspaceOpts>, wsSnapshot?: WorkspaceSnapshot): void {
  const mux = getMux();

  // Create tab — getMux().createTab returns the tab name, not pane ID
  // Snapshot panes before to find the new one after
  const before = new Set(mux.listPanes().map(p => p.id));
  mux.createTab(windowName, cmd, { cwd: opts?.cwd });

  // Find the new pane (the one not in the before set)
  const after = mux.listPanes();
  const newPane = after.find(p => !before.has(p.id));
  const agentPaneId = newPane?.id || "";

  if (!agentPaneId) {
    console.error("Failed to create zellij tab");
    return;
  }

  if (wsSnapshot) seedWorkspaceState(agentPaneId, cmd, wsSnapshot);

  const paneMap: Record<string, string> = { agent: agentPaneId };

  for (const def of defs) {
    const targetId = paneMap[def.of || "agent"] || agentPaneId;
    const dir = def.split || "right";
    // Map tmux directions to zellij's simpler right/down
    const direction: "right" | "down" = (dir === "left" || dir === "right") ? "right" : "down";

    // Convert percentage size to absolute columns/rows
    let size: string | undefined;
    if (def.size) {
      const pctMatch = def.size.match(/^(\d+)%$/);
      if (pctMatch) {
        const pct = parseInt(pctMatch[1], 10);
        const targetPane = mux.listPanes().find(p => p.id === targetId);
        if (targetPane) {
          const total = direction === "right" ? targetPane.geometry.width : targetPane.geometry.height;
          size = String(Math.round(total * pct / 100));
        }
      } else {
        size = def.size;
      }
    }

    const paneId = mux.createSplit(targetId, direction, size);
    if (paneId) {
      if (def.command !== "$SHELL") {
        mux.sendKeys(paneId, def.command + "\n");
      }
      const label = def.command.replace(/^\$/, "").split(/\s+/)[0].toLowerCase();
      paneMap[label] = paneId;
    }
  }

  // Focus the agent pane
  mux.focusPane(agentPaneId);
}

function createWorkspaceTmux(cmd: string, windowName: string, defs: WorkspaceDef[], opts?: Partial<CreateWorkspaceOpts>, wsSnapshot?: WorkspaceSnapshot): void {
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
  exec(`tmux set-option -t ${agentPaneId} -w automatic-rename off`);
  exec(`tmux set-option -t ${agentPaneId} -w allow-rename off`);
  exec(`tmux rename-window -t ${agentPaneId} ${JSON.stringify(windowName)}`);
  if (wsSnapshot) seedWorkspaceState(agentPaneId, cmd, wsSnapshot);
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
