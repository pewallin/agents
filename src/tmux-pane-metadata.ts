import { basename } from "path";
import { execFileCapture } from "./shell.js";

export type TmuxPaneContentKind = "agent" | "command" | "editor" | "terminal";

export interface TmuxPaneCommandMetadata {
  id: string;
  title: string;
  contentKind: TmuxPaneContentKind;
  cwd: string;
  launchCommand: string;
}

export interface TmuxPaneCommandMetadataInput {
  agent?: string;
  command?: string;
  launchCommand?: string;
  cwd: string;
  profileName?: string;
  title?: string;
  contentKind?: TmuxPaneContentKind;
}

export interface TmuxPaneReportMetadata {
  paneCwd?: string;
  paneOwner?: string;
  commandId?: string;
  commandContentKind?: string;
  commandOwner?: string;
  commandLaunch?: string;
  foregroundCommand?: string;
}

const REPORT_METADATA_SEPARATOR = "\u001f";

const AGENT_COMMAND_NAMES = new Set(["claude", "codex", "copilot", "kiro", "kiro-cli", "kiro-cli-chat", "opencode", "pi", "hermes"]);

function splitCommandArgv(command: string): string[] {
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
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\") escaping = true;
      else current += ch;
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

  pushCurrent();
  return argv;
}

function tokenBasename(value: string | undefined): string | undefined {
  const normalized = basename((value || "").replace(/^['"]+|['"]+$/g, "")).replace(/^-/, "").toLowerCase();
  return normalized || undefined;
}

function normalizeAgentName(value: string | undefined): string | undefined {
  const normalized = tokenBasename(value);
  if (!normalized) return undefined;
  if (normalized === "kiro-cli" || normalized === "kiro-cli-chat") return "kiro";
  return normalized;
}

function firstExecutableToken(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const argv = splitCommandArgv(command);
  let skipNext = false;
  for (const token of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "env" || token === "export" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token === "-u" || token === "--unset") {
      skipNext = true;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function agentFromCommand(command: string | undefined): string | undefined {
  const normalized = normalizeAgentName(firstExecutableToken(command));
  return normalized && AGENT_COMMAND_NAMES.has(normalized) ? normalized : undefined;
}

function displayName(value: string): string {
  switch (value) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "copilot":
      return "Copilot";
    case "kiro":
      return "Kiro";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    case "hermes":
      return "Hermes";
    default:
      return value.slice(0, 1).toUpperCase() + value.slice(1);
  }
}

export function buildTmuxPaneCommandMetadata(input: TmuxPaneCommandMetadataInput): TmuxPaneCommandMetadata {
  const agentID = normalizeAgentName(input.agent) || agentFromCommand(input.command);
  const executableID = normalizeAgentName(firstExecutableToken(input.command));
  const id = input.profileName || agentID || executableID || "command";
  const contentKind = input.contentKind || (agentID ? "agent" : id === "shell" ? "terminal" : "command");
  return {
    id,
    title: input.title || displayName(agentID || id),
    contentKind,
    cwd: input.cwd,
    launchCommand: input.launchCommand || input.command || id,
  };
}

export function tmuxPaneCommandMetadataSetOptionArguments(paneID: string, metadata: TmuxPaneCommandMetadata): string[][] {
  return [
    ["set-option", "-p", "-q", "-t", paneID, "@agents_command_id", metadata.id],
    ["set-option", "-p", "-q", "-t", paneID, "@agents_command_title", metadata.title],
    ["set-option", "-p", "-q", "-t", paneID, "@agents_command_content_kind", metadata.contentKind],
    ["set-option", "-p", "-q", "-t", paneID, "@agents_command_owner", "launcher"],
    ["set-option", "-p", "-q", "-t", paneID, "@agents_command_cwd", metadata.cwd],
    ["set-option", "-p", "-q", "-t", paneID, "@agents_command_launch", metadata.launchCommand],
  ];
}

export function tmuxPaneRestoredAgentMetadataSetOptionArguments(
  paneID: string,
  input: TmuxPaneCommandMetadataInput,
): string[][] {
  return [
    ...tmuxPaneCommandMetadataSetOptionArguments(paneID, buildTmuxPaneCommandMetadata({
      ...input,
      contentKind: "agent",
    })),
    ["set-option", "-p", "-q", "-t", paneID, "@agents_owned", "app_owned"],
  ];
}

export function tmuxPaneCommandLaunchSetOptionArguments(paneID: string, launchCommand: string, cwd?: string): string[][] {
  return [
    ...(cwd ? [["set-option", "-p", "-q", "-t", paneID, "@agents_command_cwd", cwd]] : []),
    ["set-option", "-p", "-q", "-t", paneID, "@agents_command_launch", launchCommand],
  ];
}

export function tmuxPaneBackfillLaunchCommand(reportedAgent: string, existingLaunch?: string): string {
  const normalizedReportedAgent = normalizeAgentName(reportedAgent);
  return existingLaunch && agentFromCommand(existingLaunch) === normalizedReportedAgent
    ? existingLaunch
    : reportedAgent;
}

export function setTmuxPaneCommandMetadata(paneID: string | undefined, input: TmuxPaneCommandMetadataInput): boolean {
  if (!paneID?.startsWith("%")) return false;
  const metadata = buildTmuxPaneCommandMetadata(input);
  let ok = true;
  for (const args of tmuxPaneCommandMetadataSetOptionArguments(paneID, metadata)) {
    const result = execFileCapture("tmux", args);
    if (result.status !== 0) ok = false;
  }
  return ok;
}

export function setTmuxPaneRestoredAgentMetadata(
  paneID: string | undefined,
  input: TmuxPaneCommandMetadataInput,
): boolean {
  if (!paneID?.startsWith("%")) return false;
  let ok = true;
  for (const args of tmuxPaneRestoredAgentMetadataSetOptionArguments(paneID, input)) {
    const result = execFileCapture("tmux", args);
    if (result.status !== 0) ok = false;
  }
  return ok;
}

export function parseTmuxPaneReportMetadata(raw: string): TmuxPaneReportMetadata {
  const [paneCwd, commandId, commandContentKind, commandOwner, foregroundCommand, paneOwner, commandLaunch] = raw.split(REPORT_METADATA_SEPARATOR);
  return {
    ...(paneCwd ? { paneCwd } : {}),
    ...(paneOwner ? { paneOwner } : {}),
    ...(commandId ? { commandId } : {}),
    ...(commandContentKind ? { commandContentKind } : {}),
    ...(commandOwner ? { commandOwner } : {}),
    ...(commandLaunch ? { commandLaunch } : {}),
    ...(foregroundCommand ? { foregroundCommand } : {}),
  };
}

export function readTmuxPaneReportMetadata(paneID: string | undefined): TmuxPaneReportMetadata | undefined {
  if (!paneID?.startsWith("%")) return undefined;
  const format = [
    "#{pane_current_path}",
    "#{@agents_command_id}",
    "#{@agents_command_content_kind}",
    "#{@agents_command_owner}",
    "#{pane_current_command}",
    "#{@agents_owned}",
    "#{@agents_command_launch}",
  ].join(REPORT_METADATA_SEPARATOR);
  const result = execFileCapture("tmux", ["display-message", "-p", "-t", paneID, format]);
  if (result.status !== 0) return undefined;
  return parseTmuxPaneReportMetadata(result.stdout);
}

export function readTmuxPaneCommandLaunch(paneID: string | undefined): string | undefined {
  if (!paneID?.startsWith("%")) return undefined;
  const result = execFileCapture("tmux", ["show-option", "-p", "-qv", "-t", paneID, "@agents_command_launch"]);
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export function readTmuxPaneIndex(paneID: string | undefined): string | undefined {
  if (!paneID?.startsWith("%")) return undefined;
  const result = execFileCapture("tmux", ["display-message", "-p", "-t", paneID, "#{pane_index}"]);
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export function updateTmuxPaneCommandLaunch(paneID: string | undefined, launchCommand: string | undefined, cwd?: string): boolean {
  if (!paneID?.startsWith("%") || !launchCommand) return false;
  let ok = true;
  for (const args of tmuxPaneCommandLaunchSetOptionArguments(paneID, launchCommand, cwd)) {
    const result = execFileCapture("tmux", args);
    if (result.status !== 0) ok = false;
  }
  return ok;
}

export function backfillTmuxPaneCommandMetadata(paneID: string | undefined, input: TmuxPaneCommandMetadataInput): boolean {
  if (!paneID?.startsWith("%")) return false;
  const existing = execFileCapture("tmux", ["show-option", "-p", "-qv", "-t", paneID, "@agents_command_owner"]);
  if (existing.status === 0 && existing.stdout.trim()) return false;
  return setTmuxPaneCommandMetadata(paneID, input);
}
