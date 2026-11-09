/**
 * The `agents` MCP server of Agents Next (`agents-app-control mcp`) in each harness's own config:
 * `agents setup --mcp` registers it, `agents uninstall --mcp` takes it out again, and
 * `agents doctor --mcp` reports it. The app runs these for its `agents-mcp` component, which the
 * user agrees to apart from the hooks.
 *
 *   - Claude Code: `claude mcp add/remove --scope user agents` (Claude rewrites ~/.claude.json
 *     while it runs, so never by hand), and `mcp__agents` in ~/.claude/settings.json's
 *     permissions.allow
 *   - Codex: a `[mcp_servers.agents]` table in ~/.codex/config.toml under a marker line, with
 *     `default_tools_approval_mode = "approve"`; its per-tool approval tables go with it
 *   - Kiro: `mcpServers.agents` in ~/.kiro/settings/mcp.json; our agents-reporting agent allows
 *     `@agents` (setup.ts writes that agent)
 *   - Copilot: `mcpServers.agents` in ~/.copilot/mcp-config.json
 *   - OpenCode: `mcp.agents` in ~/.config/opencode/config.json, plain JSON beside a user's
 *     opencode.jsonc, whose comments are never rewritten
 *   - Pi: `mcpServers.agents` in ~/.pi/agent/mcp.json, its tools declared to the model directly
 *
 * Only what we can recognise is ours: an entry named `agents` whose command is our
 * agents-app-control with the argument `mcp`, or Codex's table under our marker. A server of that
 * name that is not ours is left alone and reported as kept. What carries no marker (Claude's
 * allow rule, a file or an object we created) is recorded in the manifest, and uninstall takes
 * back only that. A file that cannot be parsed is skipped and reported, never rewritten, and a
 * file is written only when its content changes.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, accessSync, constants } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { execFileSync } from "child_process";
import { getAgentsHome, getSharedAppControlPath } from "./paths.js";
import { appendElement, insertMember, removeElement, removeMember } from "./json-text.js";
import type { SetupResult } from "./setup.js";

export const MCP_SERVER_NAME = "agents";
const MCP_ARGS = ["mcp"];
/** The longest `ask` (10 minutes) and a little more. */
const MCP_TIMEOUT_SECONDS = 660;
export const CODEX_MCP_MARKER = "# added by agents setup";
const CLAUDE_ALLOW_RULE = "mcp__agents";

/** The app's stable launcher for agents-app-control: the same path across app updates, so the
 *  harnesses' config never changes and never asks for a new review. */
export function mcpCommandPath(): string {
  return process.env.AGENTS_MCP_COMMAND || getSharedAppControlPath();
}

function isOurCommand(command: unknown, args: unknown): boolean {
  return typeof command === "string" && basename(command) === "agents-app-control"
    && JSON.stringify(args ?? []) === JSON.stringify(MCP_ARGS);
}

// ── Manifest ────────────────────────────────────────────────────────

interface McpManifest {
  /** Files setup created, removed again once nothing but ours is in them. */
  createdFiles?: string[];
  /** Per file, the JSON objects setup created (key paths joined by "."). */
  createdObjects?: Record<string, string[]>;
  claudeAllow?: boolean;
  codexSeparator?: boolean;
}

function manifestPath(): string {
  return join(getAgentsHome(), "integration.json");
}

function readManifest(): { all: Record<string, any>; mcp: McpManifest } {
  try {
    const all = JSON.parse(readFileSync(manifestPath(), "utf-8"));
    return { all, mcp: all.mcp ?? {} };
  } catch {
    return { all: {}, mcp: {} };
  }
}

function saveManifest(update: (mcp: McpManifest) => void): void {
  const { all, mcp } = readManifest();
  update(mcp);
  const empty = !mcp.createdFiles?.length && !Object.keys(mcp.createdObjects ?? {}).length && !mcp.claudeAllow && !mcp.codexSeparator;
  if (empty) delete all.mcp;
  else all.mcp = mcp;
  const path = manifestPath();
  if (Object.keys(all).length === 0) {
    try { unlinkSync(path); } catch {}
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
}

// ── JSON files ──────────────────────────────────────────────────────

function readJson(path: string): { exists: boolean; text: string; value?: any; error?: string } {
  if (!existsSync(path)) return { exists: false, text: "", value: {} };
  const text = readFileSync(path, "utf-8");
  try {
    const value = text.trim() === "" ? {} : JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { exists: true, text, error: "not a JSON object" };
    return { exists: true, text, value };
  } catch (error: any) {
    return { exists: true, text, error: error.message };
  }
}

function display(path: string): string {
  const home = homedir();
  return path.startsWith(home + "/") ? `~/${path.slice(home.length + 1)}` : path;
}

interface JsonEntrySpec {
  agent: string;
  /** The harness's own directory: without it the harness is not installed and nothing is written. */
  harnessDir: string;
  file: string;
  /** Where the servers are: ["mcpServers"] or ["mcp"]. */
  container: string[];
  entry: Record<string, unknown>;
  isOurs(entry: any): boolean;
}

/** The keys of `path` that are missing in `value`, as the key paths setup creates. */
function missingObjects(value: any, path: string[]): string[] {
  const missing: string[] = [];
  let current = value;
  for (const [index, key] of path.entries()) {
    current = current?.[key];
    if (current === undefined) missing.push(path.slice(0, index + 1).join("."));
  }
  return missing;
}

function recordCreated(file: string, existed: boolean, created: string[]): void {
  if (existed && created.length === 0) return;
  saveManifest((manifest) => {
    if (!existed) manifest.createdFiles = [...new Set([...(manifest.createdFiles ?? []), file])];
    if (created.length) {
      manifest.createdObjects = manifest.createdObjects ?? {};
      manifest.createdObjects[file] = [...new Set([...(manifest.createdObjects[file] ?? []), ...created])];
    }
  });
}

/** Takes out the objects setup created that are empty again, innermost first, and the file when
 *  setup created it and nothing is left in it. */
function undoCreated(file: string, text: string): string | undefined {
  const { mcp } = readManifest();
  let next = text;
  for (const keyPath of [...(mcp.createdObjects?.[file] ?? [])].sort((a, b) => b.split(".").length - a.split(".").length)) {
    const keys = keyPath.split(".");
    let value = JSON.parse(next);
    for (const key of keys) value = value?.[key];
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) next = removeMember(next, keys.slice(0, -1), keys[keys.length - 1]);
    if (Array.isArray(value) && value.length === 0) next = removeMember(next, keys.slice(0, -1), keys[keys.length - 1]);
  }
  saveManifest((manifest) => {
    manifest.createdFiles = (manifest.createdFiles ?? []).filter((path) => path !== file);
    if (manifest.createdObjects) delete manifest.createdObjects[file];
  });
  const created = mcp.createdFiles?.includes(file);
  return created && Object.keys(JSON.parse(next)).length === 0 ? undefined : next;
}

function setupJsonEntry(spec: JsonEntrySpec): SetupResult {
  if (!existsSync(spec.harnessDir)) return { agent: spec.agent, action: "skipped", detail: `${display(spec.harnessDir)} not found` };
  const file = readJson(spec.file);
  if (file.error) return { agent: spec.agent, action: "skipped", detail: `could not parse ${display(spec.file)}: ${file.error}` };
  let holder = file.value;
  for (const key of spec.container) {
    holder = holder?.[key];
    if (holder !== undefined && (!holder || typeof holder !== "object" || Array.isArray(holder))) {
      return { agent: spec.agent, action: "skipped", detail: `${spec.container.join(".")} in ${display(spec.file)} is not an object` };
    }
  }
  const existing = holder?.[MCP_SERVER_NAME];
  if (existing !== undefined && !spec.isOurs(existing)) {
    return { agent: spec.agent, action: "skipped", detail: `kept the server named ${MCP_SERVER_NAME} in ${display(spec.file)}: it is not ours` };
  }
  if (JSON.stringify(existing) === JSON.stringify(spec.entry)) return { agent: spec.agent, action: "installed" };
  const text = file.exists && file.text.trim() !== "" ? file.text : "{}\n";
  const created = missingObjects(file.value, spec.container);
  const base = existing === undefined ? text : removeMember(text, spec.container, MCP_SERVER_NAME);
  mkdirSync(dirname(spec.file), { recursive: true });
  writeFileSync(spec.file, insertMember(base, spec.container, MCP_SERVER_NAME, spec.entry));
  recordCreated(spec.file, file.exists, created);
  return { agent: spec.agent, action: "installed", detail: `added the ${MCP_SERVER_NAME} MCP server to ${display(spec.file)}` };
}

function uninstallJsonEntry(spec: Pick<JsonEntrySpec, "agent" | "file" | "container" | "isOurs">): SetupResult {
  const file = readJson(spec.file);
  if (!file.exists) return { agent: spec.agent, action: "not-installed" };
  if (file.error) return { agent: spec.agent, action: "skipped", detail: `could not parse ${display(spec.file)}: ${file.error}` };
  let holder = file.value;
  for (const key of spec.container) holder = holder?.[key];
  if (!holder || typeof holder !== "object" || holder[MCP_SERVER_NAME] === undefined) return { agent: spec.agent, action: "not-installed" };
  if (!spec.isOurs(holder[MCP_SERVER_NAME])) {
    return { agent: spec.agent, action: "skipped", detail: `kept the server named ${MCP_SERVER_NAME} in ${display(spec.file)}: it is not ours` };
  }
  const next = undoCreated(spec.file, removeMember(file.text, spec.container, MCP_SERVER_NAME));
  if (next === undefined) unlinkSync(spec.file);
  else writeFileSync(spec.file, next);
  return { agent: spec.agent, action: "uninstalled", detail: `removed the ${MCP_SERVER_NAME} MCP server from ${display(spec.file)}` };
}

function jsonEntryState(file: string, container: string[], isOurs: (entry: any) => boolean): "ours" | "foreign" | "missing" | "unreadable" {
  const json = readJson(file);
  if (json.error) return "unreadable";
  let parent = json.value;
  for (const key of container) parent = parent?.[key];
  const entry = parent?.[MCP_SERVER_NAME];
  if (entry === undefined) return "missing";
  return isOurs(entry) ? "ours" : "foreign";
}

// ── Per harness ─────────────────────────────────────────────────────

const ourStdioEntry = (entry: any) => isOurCommand(entry?.command, entry?.args);

function kiroSpec(): JsonEntrySpec {
  return {
    agent: "kiro",
    harnessDir: join(homedir(), ".kiro"),
    file: join(homedir(), ".kiro", "settings", "mcp.json"),
    container: ["mcpServers"],
    entry: { command: mcpCommandPath(), args: MCP_ARGS, timeout: MCP_TIMEOUT_SECONDS * 1000 },
    isOurs: ourStdioEntry,
  };
}

function copilotSpec(): JsonEntrySpec {
  return {
    agent: "copilot",
    harnessDir: join(homedir(), ".copilot"),
    file: join(homedir(), ".copilot", "mcp-config.json"),
    container: ["mcpServers"],
    entry: { type: "local", command: mcpCommandPath(), args: MCP_ARGS, tools: ["*"] },
    isOurs: ourStdioEntry,
  };
}

function opencodeSpec(): JsonEntrySpec {
  return {
    agent: "opencode",
    harnessDir: join(homedir(), ".config", "opencode"),
    file: join(homedir(), ".config", "opencode", "config.json"),
    container: ["mcp"],
    entry: { type: "local", command: [mcpCommandPath(), ...MCP_ARGS], enabled: true, timeout: MCP_TIMEOUT_SECONDS * 1000 },
    isOurs: (entry: any) => Array.isArray(entry?.command) && isOurCommand(entry.command[0], entry.command.slice(1)),
  };
}

function piSpec(): JsonEntrySpec {
  return {
    agent: "pi",
    harnessDir: join(homedir(), ".pi", "agent"),
    file: join(homedir(), ".pi", "agent", "mcp.json"),
    container: ["mcpServers"],
    entry: {
      command: mcpCommandPath(),
      args: MCP_ARGS,
      exposure: "direct",
      timeout: MCP_TIMEOUT_SECONDS,
      description: "Agents Next coordination: report, ask your coordinator, send messages, see workers",
    },
    isOurs: ourStdioEntry,
  };
}

/** Whether our server is in Kiro's mcp.json: our Kiro agent then allows its tools. */
export function kiroMcpInstalled(): boolean {
  return jsonEntryState(kiroSpec().file, ["mcpServers"], ourStdioEntry) === "ours";
}

// Claude Code

function claudeBinary(): string {
  return process.env.AGENTS_CLAUDE_BIN || "claude";
}

function claudeConfigPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
}

function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function runClaude(args: string[]): void {
  execFileSync(claudeBinary(), args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
}

function claudeServerState(): "ours" | "foreign" | "missing" | "unreadable" {
  return jsonEntryState(claudeConfigPath(), ["mcpServers"], (entry) => ourStdioEntry(entry) && (entry.type === undefined || entry.type === "stdio"));
}

function setupClaudeMcp(): SetupResult {
  if (!existsSync(join(homedir(), ".claude"))) return { agent: "claude", action: "skipped", detail: "~/.claude/ not found" };
  const state = claudeServerState();
  if (state === "foreign") return { agent: "claude", action: "skipped", detail: `kept the server named ${MCP_SERVER_NAME} in ${display(claudeConfigPath())}: it is not ours` };
  if (state === "unreadable") return { agent: "claude", action: "skipped", detail: `could not parse ${display(claudeConfigPath())}` };
  const details: string[] = [];
  const current = readJson(claudeConfigPath()).value?.mcpServers?.[MCP_SERVER_NAME];
  const wanted = state === "ours" && current?.command === mcpCommandPath();
  if (!wanted) {
    try {
      if (state === "ours") runClaude(["mcp", "remove", "--scope", "user", MCP_SERVER_NAME]);
      runClaude(["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", mcpCommandPath(), ...MCP_ARGS]);
      details.push("claude mcp add --scope user agents");
    } catch (error: any) {
      return { agent: "claude", action: "skipped", detail: `claude mcp add failed: ${String(error.stderr || error.message).trim().split("\n")[0]}` };
    }
  }
  // The allow rule, so a call runs without a prompt; recorded, as a rule carries no marker.
  const settingsPath = claudeSettingsPath();
  const settings = readJson(settingsPath);
  if (settings.error) {
    details.push(`could not parse ${display(settingsPath)}; tools ask before they run`);
  } else {
    const value = settings.value;
    const allow: unknown = value.permissions?.allow;
    if (!(Array.isArray(allow) && allow.includes(CLAUDE_ALLOW_RULE))) {
      if (value.permissions !== undefined && (typeof value.permissions !== "object" || Array.isArray(value.permissions) || (allow !== undefined && !Array.isArray(allow)))) {
        details.push(`permissions in ${display(settingsPath)} has another shape; tools ask before they run`);
      } else {
        const text = settings.exists && settings.text.trim() !== "" ? settings.text : "{}\n";
        const created = missingObjects(value, ["permissions", "allow"]);
        const next = Array.isArray(allow)
          ? appendElement(text, ["permissions", "allow"], CLAUDE_ALLOW_RULE)
          : insertMember(text, ["permissions"], "allow", [CLAUDE_ALLOW_RULE]);
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, next);
        recordCreated(settingsPath, settings.exists, created);
        saveManifest((manifest) => { manifest.claudeAllow = true; });
        details.push(`allowed ${CLAUDE_ALLOW_RULE} in ${display(settingsPath)}`);
      }
    }
  }
  return { agent: "claude", action: "installed", ...(details.length ? { detail: details.join("; ") } : {}) };
}

function uninstallClaudeMcp(): SetupResult {
  const details: string[] = [];
  const state = claudeServerState();
  if (state === "ours") {
    try {
      runClaude(["mcp", "remove", "--scope", "user", MCP_SERVER_NAME]);
      details.push("claude mcp remove --scope user agents");
    } catch (error: any) {
      details.push(`claude mcp remove failed: ${String(error.stderr || error.message).trim().split("\n")[0]}`);
    }
  } else if (state === "foreign") {
    details.push(`kept the server named ${MCP_SERVER_NAME}: it is not ours`);
  }
  const { mcp } = readManifest();
  const settingsPath = claudeSettingsPath();
  if (mcp.claudeAllow) {
    const settings = readJson(settingsPath);
    if (settings.exists && !settings.error && Array.isArray(settings.value.permissions?.allow)) {
      const next = undoCreated(settingsPath, removeElement(settings.text, ["permissions", "allow"], CLAUDE_ALLOW_RULE));
      if (next === undefined) unlinkSync(settingsPath);
      else writeFileSync(settingsPath, next);
      details.push(`removed ${CLAUDE_ALLOW_RULE} from ${display(settingsPath)}`);
    }
    saveManifest((manifest) => { delete manifest.claudeAllow; });
  }
  if (details.length === 0) return { agent: "claude", action: "not-installed" };
  return { agent: "claude", action: state === "ours" || mcp.claudeAllow ? "uninstalled" : "skipped", detail: details.join("; ") };
}

// Codex

function codexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexMcpBlock(command: string = mcpCommandPath()): string[] {
  return [
    CODEX_MCP_MARKER,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = [${MCP_ARGS.map(tomlString).join(", ")}]`,
    `tool_timeout_sec = ${MCP_TIMEOUT_SECONDS}`,
    `default_tools_approval_mode = "approve"`,
  ];
}

const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

function tomlTableName(line: string): string | undefined {
  const match = line.match(TOML_HEADER);
  return match ? match[1].replace(/\s*\.\s*/g, ".").replace(/"([A-Za-z0-9_-]+)"/g, "$1") : undefined;
}

/** The lines of a table: from its header to the next header, less the comment lines just above
 *  that header, which belong to it. */
function tomlTableEnd(lines: string[], header: number): number {
  let next = header + 1;
  while (next < lines.length && tomlTableName(lines[next]) === undefined) next += 1;
  if (next >= lines.length) return lines.length;
  let end = next;
  while (end > header + 1 && /^\s*#/.test(lines[end - 1])) end -= 1;
  return end;
}

interface CodexTables { main?: number; ours: boolean; subtables: number[] }

function codexTables(lines: string[]): CodexTables {
  const result: CodexTables = { ours: false, subtables: [] };
  lines.forEach((line, index) => {
    const name = tomlTableName(line);
    if (name === `mcp_servers.${MCP_SERVER_NAME}`) result.main = index;
    else if (name?.startsWith(`mcp_servers.${MCP_SERVER_NAME}.`)) result.subtables.push(index);
  });
  result.ours = result.main !== undefined && result.main > 0 && lines[result.main - 1].trim() === CODEX_MCP_MARKER;
  return result;
}

/** Codex's config with our table added or brought up to date; `separator` when a blank line was
 *  added before it. */
export function ensureCodexMcpConfig(text: string, command: string = mcpCommandPath()): { text: string; changed: boolean; separator?: boolean; foreign?: boolean } {
  const lines = text.split("\n");
  const tables = codexTables(lines);
  const block = codexMcpBlock(command);
  if (tables.main !== undefined && !tables.ours) return { text, changed: false, foreign: true };
  if (tables.main !== undefined) {
    // Our table's own lines, without the blank lines after it.
    let end = tomlTableEnd(lines, tables.main);
    while (end > tables.main + 1 && lines[end - 1].trim() === "") end -= 1;
    const current = lines.slice(tables.main - 1, end);
    if (current.join("\n") === block.join("\n")) return { text, changed: false };
    lines.splice(tables.main - 1, end - tables.main + 1, ...block);
    return { text: lines.join("\n"), changed: true };
  }
  if (text === "") return { text: `${block.join("\n")}\n`, changed: true };
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const separator = !body.endsWith("\n\n");
  return { text: `${body}${separator ? "\n" : ""}${block.join("\n")}\n`, changed: true, separator: separator || !text.endsWith("\n") };
}

/** Codex's config without our table and the tables under it (Codex's per-tool approvals). */
export function removeCodexMcpConfig(text: string, separator = false): { text: string; changed: boolean; foreign?: boolean } {
  const lines = text.split("\n");
  const tables = codexTables(lines);
  if (tables.main === undefined) return { text, changed: false };
  if (!tables.ours) return { text, changed: false, foreign: true };
  const ranges: Array<[number, number]> = [[tables.main - 1, tomlTableEnd(lines, tables.main)]];
  for (const header of tables.subtables) ranges.push([header, tomlTableEnd(lines, header)]);
  ranges.sort((a, b) => b[0] - a[0]);
  let atEnd = false;
  for (const [start, end] of ranges) {
    // The file's last line is the empty string after its final newline.
    if (end >= lines.length - 1) atEnd = true;
    lines.splice(start, end - start);
  }
  let result = lines.join("\n");
  if (atEnd && !result.endsWith("\n") && result !== "") result += "\n";
  if (atEnd && separator && result.endsWith("\n\n")) result = result.slice(0, -1);
  return { text: result, changed: true };
}

function setupCodexMcp(): SetupResult {
  if (!existsSync(join(homedir(), ".codex"))) return { agent: "codex", action: "skipped", detail: "~/.codex/ not found" };
  const path = codexConfigPath();
  const existed = existsSync(path);
  const text = existed ? readFileSync(path, "utf-8") : "";
  const result = ensureCodexMcpConfig(text);
  if (result.foreign) return { agent: "codex", action: "skipped", detail: `kept [mcp_servers.${MCP_SERVER_NAME}] in ~/.codex/config.toml: it is not ours` };
  if (!result.changed) return { agent: "codex", action: "installed" };
  writeFileSync(path, result.text);
  saveManifest((manifest) => {
    if (result.separator) manifest.codexSeparator = true;
    if (!existed) manifest.createdFiles = [...new Set([...(manifest.createdFiles ?? []), path])];
  });
  return { agent: "codex", action: "installed", detail: `added [mcp_servers.${MCP_SERVER_NAME}] to ~/.codex/config.toml` };
}

function uninstallCodexMcp(): SetupResult {
  const path = codexConfigPath();
  if (!existsSync(path)) return { agent: "codex", action: "not-installed" };
  const { mcp } = readManifest();
  const result = removeCodexMcpConfig(readFileSync(path, "utf-8"), mcp.codexSeparator === true);
  if (result.foreign) return { agent: "codex", action: "skipped", detail: `kept [mcp_servers.${MCP_SERVER_NAME}] in ~/.codex/config.toml: it is not ours` };
  if (!result.changed) return { agent: "codex", action: "not-installed" };
  if (mcp.createdFiles?.includes(path) && result.text.trim() === "") unlinkSync(path);
  else writeFileSync(path, result.text);
  saveManifest((manifest) => {
    delete manifest.codexSeparator;
    manifest.createdFiles = (manifest.createdFiles ?? []).filter((file) => file !== path);
  });
  return { agent: "codex", action: "uninstalled", detail: `removed [mcp_servers.${MCP_SERVER_NAME}] from ~/.codex/config.toml` };
}

// ── Entry points ────────────────────────────────────────────────────

function commandReachable(command: string): boolean {
  try {
    accessSync(command, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Registers the server with every harness that is installed. `afterKiro` rewrites our Kiro
 *  agent, which allows the server's tools while the server is in Kiro's mcp.json. */
export function setupMcp(afterKiro: () => void = () => {}): SetupResult[] {
  if (!commandReachable(mcpCommandPath())) {
    const detail = `${display(mcpCommandPath())} not found: Agents Next writes it; open the app with Agent Integration on`;
    return ["claude", "codex", "kiro", "copilot", "opencode", "pi"].map((agent) => ({ agent, action: "skipped" as const, detail }));
  }
  const kiro = setupJsonEntry(kiroSpec());
  afterKiro();
  return [setupClaudeMcp(), setupCodexMcp(), kiro, setupJsonEntry(copilotSpec()), setupJsonEntry(opencodeSpec()), setupJsonEntry(piSpec())];
}

export function uninstallMcp(afterKiro: () => void = () => {}): SetupResult[] {
  const kiro = uninstallJsonEntry(kiroSpec());
  afterKiro();
  return [uninstallClaudeMcp(), uninstallCodexMcp(), kiro, uninstallJsonEntry(copilotSpec()), uninstallJsonEntry(opencodeSpec()), uninstallJsonEntry(piSpec())];
}

export interface McpDoctorResult {
  agent: string;
  registered: "ours" | "foreign" | "missing" | "unreadable" | "not-installed";
  /** Whether its tools run without a prompt. */
  allowed?: boolean;
  reachable: boolean;
  detail?: string;
}

export function doctorMcp(): McpDoctorResult[] {
  const reachable = commandReachable(mcpCommandPath());
  const results: McpDoctorResult[] = [];
  const claudeAllowed = (() => {
    const allow = readJson(claudeSettingsPath()).value?.permissions?.allow;
    return Array.isArray(allow) && allow.includes(CLAUDE_ALLOW_RULE);
  })();
  results.push(existsSync(join(homedir(), ".claude"))
    ? { agent: "claude", registered: claudeServerState(), allowed: claudeAllowed, reachable }
    : { agent: "claude", registered: "not-installed", reachable });
  if (existsSync(join(homedir(), ".codex"))) {
    const text = existsSync(codexConfigPath()) ? readFileSync(codexConfigPath(), "utf-8") : "";
    const tables = codexTables(text.split("\n"));
    const registered = tables.main === undefined ? "missing" : tables.ours ? "ours" : "foreign";
    results.push({ agent: "codex", registered, allowed: registered === "ours" ? text.includes(`default_tools_approval_mode = "approve"`) : undefined, reachable });
  } else {
    results.push({ agent: "codex", registered: "not-installed", reachable });
  }
  for (const spec of [kiroSpec(), copilotSpec(), opencodeSpec(), piSpec()]) {
    if (!existsSync(spec.harnessDir)) {
      results.push({ agent: spec.agent, registered: "not-installed", reachable });
      continue;
    }
    const registered = jsonEntryState(spec.file, spec.container, spec.isOurs);
    const allowed = spec.agent === "copilot" ? undefined : spec.agent === "kiro" ? registered === "ours" : registered === "ours";
    results.push({
      agent: spec.agent,
      registered,
      allowed,
      reachable,
      ...(spec.agent === "copilot" ? { detail: "Copilot asks before each tool unless it is started with --allow-tool agents (unverified)" } : {}),
    });
  }
  return results;
}
