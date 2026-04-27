import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
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
  overrideArgs?: string[];
  directAgentLaunch?: boolean; // tmux-only: launch the main agent pane via exec script instead of shell send-keys
  name?: string;
  layout?: string;
  profile?: string;
  cwd?: string;
  tmuxSession?: string;  // target tmux session for the new window
  detached?: boolean;    // tmux-only: create the new window without focusing attached clients
  initProject?: boolean;
  agentOnly?: boolean;   // skip helper pane creation (app creates them on demand)
}

export interface ResolvedWorkspaceLaunch {
  command: string;
  agentCommand: string;
  argv: string[];
  env?: Record<string, string>;
  layout?: string;
  name?: string;
  profileName?: string;
  profileEnv?: Record<string, string>;
  alternateScreen?: boolean;
}

export interface WorkspaceLaunchResult {
  cwd: string;
  mux: "tmux" | "zellij" | null;
  windowName: string;
  resolved: ResolvedWorkspaceLaunch;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shellQuoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : shellQuote(value);
}

function renderCommand(argv: string[]): string {
  return argv.map(shellQuoteIfNeeded).join(" ");
}

function renderEnvExports(env?: Record<string, string>): string[] {
  if (!env || Object.keys(env).length === 0) return [];
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name in profile: ${key}`);
    }
    return `export ${key}=${shellQuote(String(value))}`;
  });
}

function applyProfileEnv(command: string, env?: Record<string, string>): string {
  const exports = renderEnvExports(env);
  if (exports.length === 0) return command;
  return `${exports.join("; ")}; ${command}`;
}

export function splitCommandArgv(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      argv.push(current);
      current = "";
    }
  };

  for (const ch of command) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        escaping = true;
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    current += ch;
  }

  if (escaping) throw new Error("Invalid command: trailing escape");
  if (quote) throw new Error("Invalid command: unterminated quote");
  pushCurrent();

  if (argv.length === 0) throw new Error("No command specified and no defaultCommand in config");
  return argv;
}

function buildLauncherScript(cwd: string, argv: string[], env?: Record<string, string>): string {
  const exports = renderEnvExports(env);
  const command = renderCommand(argv);
  return [
    "#!/bin/sh",
    "set -eu",
    `cd -- ${shellQuote(cwd)}`,
    ...exports,
    "rm -f -- \"$0\"",
    `exec ${command}`,
    "",
  ].join("\n");
}

function writeLauncherScript(cwd: string, argv: string[], env?: Record<string, string>): string {
  const path = join("/tmp", `agents-launch-${randomUUID()}.sh`);
  writeFileSync(path, buildLauncherScript(cwd, argv, env), { mode: 0o755 });
  return path;
}

function shellLaunchCommand(scriptPath: string): string {
  const shell = process.env.SHELL || "/bin/sh";
  return `${shellQuote(shell)} -lc ${shellQuote(`exec ${scriptPath}`)}`;
}

export function resolveWorkspaceLaunch(agentCmd?: string, name?: string, layout?: string, opts?: Partial<CreateWorkspaceOpts>): ResolvedWorkspaceLaunch {
  const config = loadConfig();
  const profileName = opts?.profile;
  const shouldUseProfile = !!profileName || !agentCmd;
  const profile = shouldUseProfile ? resolveProfile(profileName) : undefined;
  const baseCommand = agentCmd || profile?.command || config.defaultCommand;
  if (!baseCommand) {
    throw new Error("No command specified and no defaultCommand in config");
  }
  const overrideArgs = opts?.overrideArgs || [];
  const argv = [...splitCommandArgv(baseCommand), ...overrideArgs];
  const agentCommandString = renderCommand(argv);
  const layoutName = layout || profile?.workspace;
  const displayName = name || profile?.name || profileName;

  return {
    command: applyProfileEnv(agentCommandString, profile?.env),
    agentCommand: agentCommandString,
    argv,
    ...(profile?.env ? { env: profile.env } : {}),
    ...(layoutName ? { layout: layoutName } : {}),
    ...(displayName ? { name: displayName } : {}),
    ...(profileName ? { profileName } : {}),
    ...(profile?.env ? { profileEnv: profile.env } : {}),
    ...(profile?.alternate_screen !== undefined ? { alternateScreen: profile.alternate_screen } : {}),
  };
}

export function createWorkspaceOrThrow(agentCmd?: string, name?: string, layout?: string, opts?: Partial<CreateWorkspaceOpts>): WorkspaceLaunchResult {
  const config = loadConfig();
  const resolved = resolveWorkspaceLaunch(agentCmd, name, layout, opts);
  const cmd = resolved.command;
  const metadataCommand = resolved.agentCommand;
  const argv = resolved.argv;
  const launchEnv = resolved.env;
  const layoutName = resolved.layout;
  const resolvedName = resolved.name;

  if (!cmd) {
    throw new Error("No command specified and no defaultCommand in config");
  }

  if (opts?.cwd && opts.initProject && !prepareWorkspaceDir(opts.cwd)) {
    throw new Error(`Failed to create project directory: ${opts.cwd}`);
  }

  const defs = opts?.agentOnly ? [] : resolveLayout(config, layoutName);
  const cwd = opts?.cwd || process.cwd();
  const baseName = resolvedName || metadataCommand.split(/\s+/)[0];
  const cwdBase = cwd.split("/").pop() || "";
  const windowName = cwdBase ? `${baseName}:${cwdBase}` : baseName;

  // Build workspace snapshot at creation time — this is the authoritative
  // source for session name and cwd. Report hooks will preserve it.
  const muxKind = detectMultiplexer();
  const wsSnapshot: WorkspaceSnapshot = {
    command: cmd,
    cwd,
    mux: muxKind || undefined,
    sessionName: opts?.tmuxSession || undefined,
  };

  if (muxKind === "zellij") {
    createWorkspaceZellij(cmd, metadataCommand, windowName, defs, opts, wsSnapshot);
  } else {
    createWorkspaceTmux(cmd, metadataCommand, windowName, defs, opts, wsSnapshot, resolved.alternateScreen, argv, launchEnv);
  }

  return {
    cwd,
    mux: muxKind,
    windowName,
    resolved,
  };
}

export function createWorkspace(agentCmd?: string, name?: string, layout?: string, opts?: Partial<CreateWorkspaceOpts>): WorkspaceLaunchResult {
  try {
    return createWorkspaceOrThrow(agentCmd, name, layout, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

/** Seed the state file with workspace metadata right after pane creation.
 *  This captures the authoritative session/cwd before preview swaps can muddy it. */
function seedWorkspaceState(agentPaneId: string, agentCommand: string, snapshot: WorkspaceSnapshot): void {
  // Infer agent name from command (e.g. "claude --dangerously-skip-permissions" → "claude")
  const agent = agentCommand.split(/\s+/)[0].replace(/.*\//, "").toLowerCase();
  // For tmux, also capture session name from the actual pane if not already set
  if (!snapshot.sessionName && agentPaneId.startsWith("%")) {
    try {
      snapshot.sessionName = exec(`tmux display-message -t ${agentPaneId} -p '#{session_name}'`) || undefined;
    } catch {}
  }
  reportState(agent, agentPaneId, "idle", undefined, snapshot);
}

function createWorkspaceZellij(cmd: string, agentCommand: string, windowName: string, defs: WorkspaceDef[], opts?: Partial<CreateWorkspaceOpts>, wsSnapshot?: WorkspaceSnapshot): void {
  const mux = getMux();

  // Create tab — getMux().createTab returns the tab name, not pane ID
  // Snapshot panes before to find the new one after
  const before = new Set(mux.listPanes().map(p => p.id));
  mux.createTab(windowName, cmd, { cwd: opts?.cwd || process.cwd() });

  // Find the new pane (the one not in the before set)
  const after = mux.listPanes();
  const newPane = after.find(p => !before.has(p.id));
  const agentPaneId = newPane?.id || "";

  if (!agentPaneId) {
    throw new Error("Failed to create zellij tab");
  }

  if (wsSnapshot) seedWorkspaceState(agentPaneId, agentCommand, wsSnapshot);

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

function createWorkspaceTmux(cmd: string, agentCommand: string, windowName: string, defs: WorkspaceDef[], opts?: Partial<CreateWorkspaceOpts>, wsSnapshot?: WorkspaceSnapshot, alternateScreen?: boolean, argv?: string[], env?: Record<string, string>): void {
  const shouldFocusNewWindow = detectMultiplexer() === "tmux" && opts?.detached !== true;
  const cwd = opts?.cwd || process.cwd();
  // Build new-window command with optional target session and cwd
  let newWindowCmd = "tmux new-window";
  if (!shouldFocusNewWindow) {
    newWindowCmd += " -d";
  }
  if (opts?.tmuxSession) {
    newWindowCmd += ` -t ${JSON.stringify(opts.tmuxSession + ":")}`;
  }
  newWindowCmd += ` -n ${JSON.stringify(windowName)} -P -F '#{pane_id}'`;
  if (cwd) {
    newWindowCmd += ` -c ${JSON.stringify(cwd)}`;
  }
  if (opts?.directAgentLaunch) {
    const launcherPath = writeLauncherScript(cwd, argv || splitCommandArgv(agentCommand), env);
    const launchCmd = shellLaunchCommand(launcherPath);
    newWindowCmd += ` ${JSON.stringify(launchCmd)}`;
  }

  const agentPaneId = exec(newWindowCmd);
  if (!agentPaneId) {
    throw new Error("Failed to create tmux window");
  }
  exec(`tmux set-option -t ${agentPaneId} -w automatic-rename off`);
  exec(`tmux set-option -t ${agentPaneId} -w allow-rename off`);
  exec(`tmux rename-window -t ${agentPaneId} ${JSON.stringify(windowName)}`);
  if (alternateScreen === false) {
    exec(`tmux set-option -p -t ${agentPaneId} alternate-screen off`);
  }
  if (wsSnapshot) seedWorkspaceState(agentPaneId, agentCommand, wsSnapshot);
  if (!opts?.directAgentLaunch) {
    exec(`tmux send-keys -t ${agentPaneId} ${JSON.stringify(cmd)} Enter`);
  }

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

  if (shouldFocusNewWindow) {
    exec(`tmux select-pane -t ${agentPaneId}`);
  }
}
