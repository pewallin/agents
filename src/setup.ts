/**
 * Setup and uninstall logic for agents hook integrations.
 *
 * Supports:
 *   - Claude Code: patches ~/.claude/settings.json with hooks
 *   - Codex CLI: patches ~/.codex/config.toml and ~/.codex/hooks.json
 *   - Copilot CLI: symlinks extension to ~/.copilot/extensions/agents-reporting/
 *   - Pi: symlinks extension to ~/.pi/agent/extensions/agents-reporting/
 *   - OpenCode: symlinks plugin to ~/.config/opencode/node_modules/ and patches config.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readdirSync, rmdirSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";
import { getAgentsHome, getSetupHashPath } from "./paths.js";
import {
  INTEGRATION_SPECS,
  LIFECYCLE_CAPABILITIES,
  METADATA_CAPABILITIES,
  missingLifecycleCapabilities,
  missingMetadataCapabilities,
  type AgentIntegrationName,
  type AgentIntegrationSpec,
} from "./integrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// extensions/ lives next to src/ in the repo root
const REPO_ROOT = join(__dirname, "..");
const EXTENSIONS_DIR = join(REPO_ROOT, "extensions");

export interface SetupResult {
  agent: string;
  action: "installed" | "uninstalled" | "skipped" | "not-installed";
  detail?: string;
}

export interface DoctorResult {
  agent: AgentIntegrationName;
  installMethod: AgentIntegrationSpec["installMethod"];
  status: "installed" | "partial" | "not-installed" | "unavailable" | "broken";
  detail?: string;
  expectedEvents: string[];
  installedEvents: string[];
  missingLifecycle: ReturnType<typeof missingLifecycleCapabilities>;
  missingMetadata: ReturnType<typeof missingMetadataCapabilities>;
  supplemental?: string[];
  notes?: string[];
}

// ── Claude Code ─────────────────────────────────────────────────────

const STATE_HOOK_SCRIPT = join(EXTENSIONS_DIR, "claude", "state-hook.sh");
const STOP_HOOK_SCRIPT = join(EXTENSIONS_DIR, "claude", "stop-hook.sh");

const CLAUDE_HOOKS = {
  PreToolUse: [{ hooks: [{ type: "command", command: `${STATE_HOOK_SCRIPT} working` }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: `${STATE_HOOK_SCRIPT} working` }] }],
  Stop: [{ hooks: [{ type: "command", command: STOP_HOOK_SCRIPT }] }],
  Notification: [
    { matcher: "idle_prompt", hooks: [{ type: "command", command: `${STATE_HOOK_SCRIPT} idle` }] },
    { matcher: "permission_prompt", hooks: [{ type: "command", command: `${STATE_HOOK_SCRIPT} approval` }] },
    { matcher: "elicitation_dialog", hooks: [{ type: "command", command: `${STATE_HOOK_SCRIPT} question` }] },
  ],
};

// Hook events from older versions that should be cleaned up on setup/uninstall
const LEGACY_EVENTS = ["PermissionRequest"];

function matchesHookDef(candidate: any, expected: any): boolean {
  return JSON.stringify(candidate) === JSON.stringify(expected);
}

function detailFromMissingEvents(
  expectedEvents: string[],
  installedEvents: string[],
  unavailableDetail: string,
): { status: DoctorResult["status"]; detail?: string } {
  if (installedEvents.length === expectedEvents.length) {
    return { status: "installed" };
  }
  if (installedEvents.length === 0) {
    return { status: "not-installed", detail: unavailableDetail };
  }
  const missing = expectedEvents.filter((event) => !installedEvents.includes(event));
  return {
    status: "partial",
    detail: `missing ${missing.join(", ")}`,
  };
}

function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function installedFileVersion(
  target: string,
  source: string,
): { status: "missing" | "current" | "outdated" | "unreadable"; detail?: string } {
  if (!existsSync(target)) {
    return { status: "missing" };
  }

  try {
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      const targetRealpath = realpathSync(target);
      const sourceRealpath = realpathSync(source);
      if (targetRealpath === sourceRealpath) {
        return { status: "current", detail: "symlinked to repo source" };
      }
    }

    const targetContent = readFileSync(target);
    const sourceContent = readFileSync(source);
    const targetHash = contentHash(targetContent);
    const sourceHash = contentHash(sourceContent);
    if (targetHash === sourceHash) {
      return { status: "current", detail: `content hash ${targetHash}` };
    }
    return {
      status: "outdated",
      detail: `installed hash ${targetHash}, expected ${sourceHash}`,
    };
  } catch {
    return { status: "unreadable" };
  }
}

function mergeDetail(primary?: string, secondary?: string): string | undefined {
  if (primary && secondary) return `${primary}; ${secondary}`;
  return primary || secondary;
}

function applyCapabilityOverrides(
  spec: AgentIntegrationSpec,
  overrides?: Partial<AgentIntegrationSpec["capabilities"]>,
): Pick<DoctorResult, "missingLifecycle" | "missingMetadata"> {
  const capabilities = { ...spec.capabilities, ...overrides };
  return {
    missingLifecycle: LIFECYCLE_CAPABILITIES.filter((capability) => !capabilities[capability]),
    missingMetadata: METADATA_CAPABILITIES.filter((capability) => !capabilities[capability]),
  };
}

function setupClaude(): SetupResult {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(join(homedir(), ".claude"))) {
    return { agent: "claude", action: "skipped", detail: "~/.claude/ not found" };
  }

  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      return { agent: "claude", action: "skipped", detail: "could not parse settings.json" };
    }
  }

  // Idempotent: strip our hooks, re-add current ones, write only if changed.
  settings.hooks = settings.hooks || {};
  const before = JSON.stringify(settings.hooks);

  // Strip our hooks from all events (current + legacy).
  // Match inline `agents report` commands AND script references from extensions/claude/.
  const isOurHook = (h: any) => {
    const s = JSON.stringify(h);
    return s.includes("agents report --agent claude") || s.includes("extensions/claude/") || s.includes("state-hook.sh");
  };
  for (const event of [...Object.keys(CLAUDE_HOOKS), ...LEGACY_EVENTS]) {
    const hooks: any[] = settings.hooks[event] || [];
    const filtered = hooks.filter((h: any) => !isOurHook(h));
    if (filtered.length === 0) {
      delete settings.hooks[event];
    } else {
      settings.hooks[event] = filtered;
    }
  }

  // Add current hooks
  for (const [event, hookDefs] of Object.entries(CLAUDE_HOOKS)) {
    const existing: any[] = settings.hooks[event] || [];
    settings.hooks[event] = [...existing, ...hookDefs];
  }

  if (JSON.stringify(settings.hooks) === before) {
    return { agent: "claude", action: "installed" };
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { agent: "claude", action: "installed", detail: "patched ~/.claude/settings.json" };
}

function uninstallClaude(): SetupResult {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    return { agent: "claude", action: "not-installed" };
  }

  let settings: any;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return { agent: "claude", action: "skipped", detail: "could not parse settings.json" };
  }

  if (!settings.hooks) {
    return { agent: "claude", action: "not-installed" };
  }

  const isOurHook = (h: any) => {
    const s = JSON.stringify(h);
    return s.includes("agents report --agent claude") || s.includes("extensions/claude/") || s.includes("state-hook.sh");
  };
  let removed = false;
  for (const event of [...Object.keys(CLAUDE_HOOKS), ...LEGACY_EVENTS]) {
    const hooks: any[] = settings.hooks[event] || [];
    const filtered = hooks.filter((h: any) => !isOurHook(h));
    if (filtered.length !== hooks.length) {
      removed = true;
      if (filtered.length === 0) {
        delete settings.hooks[event];
      } else {
        settings.hooks[event] = filtered;
      }
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (!removed) {
    return { agent: "claude", action: "not-installed" };
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { agent: "claude", action: "uninstalled", detail: "removed hooks from ~/.claude/settings.json" };
}

// ── Codex CLI ───────────────────────────────────────────────────────

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const CODEX_HOOKS_PATH = join(homedir(), ".codex", "hooks.json");
const CODEX_REPORT_SCRIPT = join(EXTENSIONS_DIR, "codex", "report-state.sh");
const CODEX_STOP_SCRIPT = join(EXTENSIONS_DIR, "codex", "stop-hook.sh");

function codexHookEntries(): Record<string, any[]> {
  return {
    UserPromptSubmit: [
      {
        suppressOutput: true,
        hooks: [{ type: "command", command: `${CODEX_REPORT_SCRIPT} working` }],
      },
    ],
    Stop: [
      {
        suppressOutput: true,
        hooks: [{ type: "command", command: CODEX_STOP_SCRIPT }],
      },
    ],
  };
}

function codexHooksConfig(): { hooks: Record<string, any[]> } {
  return { hooks: codexHookEntries() };
}

function isOurCodexHook(group: any): boolean {
  const s = JSON.stringify(group);
  return s.includes("extensions/codex/") || s.includes("report-state.sh") || s.includes("stop-hook.sh") || s.includes("--agent codex");
}

function ensureCodexHooksEnabled(configText: string): { text: string; changed: boolean } {
  if (/^codex_hooks\s*=\s*true\s*$/m.test(configText)) return { text: configText, changed: false };

  if (/^codex_hooks\s*=\s*false\s*$/m.test(configText)) {
    return { text: configText.replace(/^codex_hooks\s*=\s*false\s*$/m, "codex_hooks = true"), changed: true };
  }

  if (/^\[features\]\s*$/m.test(configText)) {
    return {
      text: configText.replace(/^\[features\]\s*$/m, `[features]\ncodex_hooks = true`),
      changed: true,
    };
  }

  const suffix = configText.endsWith("\n") || configText.length === 0 ? "" : "\n";
  return { text: `${configText}${suffix}\n[features]\ncodex_hooks = true\n`, changed: true };
}

function normalizeCodexHooksJson(hooksJson: Record<string, any>): { hooksJson: Record<string, any>; hookRoot: Record<string, any[]>; changed: boolean } {
  const desiredEvents = Object.keys(codexHookEntries());
  const legacyRoot = Object.fromEntries(
    Object.entries(hooksJson).filter(([key, value]) => desiredEvents.includes(key) && Array.isArray(value))
  ) as Record<string, any[]>;
  const nestedRoot = hooksJson.hooks && typeof hooksJson.hooks === "object" && !Array.isArray(hooksJson.hooks)
    ? hooksJson.hooks as Record<string, any[]>
    : {};

  const changed = JSON.stringify(legacyRoot) !== "{}" || !hooksJson.hooks;
  const normalized: Record<string, any> = { ...hooksJson, hooks: { ...legacyRoot, ...nestedRoot } };
  for (const event of desiredEvents) delete normalized[event];

  return { hooksJson: normalized, hookRoot: normalized.hooks as Record<string, any[]>, changed };
}

function setupCodex(): SetupResult {
  const codexDir = join(homedir(), ".codex");
  if (!existsSync(codexDir)) {
    return { agent: "codex", action: "skipped", detail: "~/.codex/ not found" };
  }

  for (const source of [CODEX_REPORT_SCRIPT, CODEX_STOP_SCRIPT]) {
    if (!existsSync(source)) {
      return { agent: "codex", action: "skipped", detail: `${source} not found in repo` };
    }
  }

  let configText = "";
  try {
    configText = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf-8") : "";
  } catch {
    return { agent: "codex", action: "skipped", detail: "could not read ~/.codex/config.toml" };
  }

  const featureUpdate = ensureCodexHooksEnabled(configText);

  let hooksChanged = false;
  let hooksJson: Record<string, any> = {};
  if (existsSync(CODEX_HOOKS_PATH)) {
    try {
      hooksJson = JSON.parse(readFileSync(CODEX_HOOKS_PATH, "utf-8"));
    } catch {
      return { agent: "codex", action: "skipped", detail: "could not parse ~/.codex/hooks.json" };
    }
  }

  const normalized = normalizeCodexHooksJson(hooksJson);
  hooksJson = normalized.hooksJson;
  const hookRoot = normalized.hookRoot;
  hooksChanged = normalized.changed;

  const desiredHooks = codexHookEntries();
  for (const [event, groups] of Object.entries(desiredHooks)) {
    const existing = Array.isArray(hookRoot[event]) ? hookRoot[event] : [];
    const filtered = existing.filter((group) => !isOurCodexHook(group));
    const next = [...filtered, ...groups];
    if (JSON.stringify(existing) !== JSON.stringify(next)) hooksChanged = true;
    hookRoot[event] = next;
  }

  for (const event of Object.keys(hookRoot)) {
    if (event in desiredHooks) continue;
    const existing = Array.isArray(hookRoot[event]) ? hookRoot[event] : [];
    const filtered = existing.filter((group) => !isOurCodexHook(group));
    if (filtered.length !== existing.length) hooksChanged = true;
    if (filtered.length === 0) {
      delete hookRoot[event];
    } else {
      hookRoot[event] = filtered;
    }
  }

  if (!featureUpdate.changed && !hooksChanged) {
    return { agent: "codex", action: "installed", detail: "hooks configured" };
  }

  if (featureUpdate.changed) writeFileSync(CODEX_CONFIG_PATH, featureUpdate.text);
  if (hooksChanged) writeFileSync(CODEX_HOOKS_PATH, JSON.stringify(hooksJson, null, 2) + "\n");

  return { agent: "codex", action: "installed", detail: "patched ~/.codex/config.toml and ~/.codex/hooks.json" };
}

function uninstallCodex(): SetupResult {
  if (!existsSync(CODEX_HOOKS_PATH)) {
    return { agent: "codex", action: "not-installed" };
  }

  let hooksJson: Record<string, any>;
  try {
    hooksJson = JSON.parse(readFileSync(CODEX_HOOKS_PATH, "utf-8"));
  } catch {
    return { agent: "codex", action: "skipped", detail: "could not parse ~/.codex/hooks.json" };
  }

  const normalized = normalizeCodexHooksJson(hooksJson);
  hooksJson = normalized.hooksJson;
  const hookRoot = normalized.hookRoot;

  let removed = normalized.changed;
  for (const event of Object.keys(hookRoot)) {
    const existing = Array.isArray(hookRoot[event]) ? hookRoot[event] : [];
    const filtered = existing.filter((group) => !isOurCodexHook(group));
    if (filtered.length !== existing.length) removed = true;
    if (filtered.length === 0) {
      delete hookRoot[event];
    } else {
      hookRoot[event] = filtered;
    }
  }

  if (!removed) return { agent: "codex", action: "not-installed" };

  if (Object.keys(hookRoot).length === 0) {
    delete hooksJson.hooks;
  }

  if (Object.keys(hooksJson).length === 0) {
    unlinkSync(CODEX_HOOKS_PATH);
  } else {
    writeFileSync(CODEX_HOOKS_PATH, JSON.stringify(hooksJson, null, 2) + "\n");
  }

  return { agent: "codex", action: "uninstalled", detail: "removed hooks from ~/.codex/hooks.json" };
}

// ── Copilot CLI ─────────────────────────────────────────────────────

function setupCopilot(): SetupResult {
  const copilotDir = join(homedir(), ".copilot");
  if (!existsSync(copilotDir)) {
    return { agent: "copilot", action: "skipped", detail: "~/.copilot/ not found" };
  }

  const extDir = join(copilotDir, "extensions", "agents-reporting");
  const target = join(extDir, "extension.mjs");
  const source = join(EXTENSIONS_DIR, "copilot", "extension.mjs");

  if (!existsSync(source)) {
    return { agent: "copilot", action: "skipped", detail: "extension source not found in repo" };
  }

  if (existsSync(target)) {
    // Check if it's our symlink
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        return { agent: "copilot", action: "installed", detail: "symlinked" };
      }
    } catch {}
    // File exists but isn't our symlink — check content
    try {
      const content = readFileSync(target, "utf-8");
      if (content.includes("agents report")) {
        return { agent: "copilot", action: "installed", detail: "extension present" };
      }
    } catch {}
  }

  mkdirSync(extDir, { recursive: true });
  // Symlink so updates to the repo propagate
  try {
    if (existsSync(target)) unlinkSync(target);
    symlinkSync(source, target);
  } catch {
    // Fallback: copy the file
    writeFileSync(target, readFileSync(source, "utf-8"));
  }

  return { agent: "copilot", action: "installed", detail: "symlinked" };
}

function uninstallCopilot(): SetupResult {
  const extDir = join(homedir(), ".copilot", "extensions", "agents-reporting");
  if (!existsSync(extDir)) {
    return { agent: "copilot", action: "not-installed" };
  }

  const target = join(extDir, "extension.mjs");
  if (existsSync(target)) {
    // Verify it's ours before removing
    try {
      const content = readFileSync(target, "utf-8");
      if (!content.includes("agents report")) {
        return { agent: "copilot", action: "skipped", detail: "extension.mjs doesn't look like ours" };
      }
    } catch {}
    unlinkSync(target);
  }

  // Remove directory if empty
  try {
    const remaining = readdirSync(extDir);
    if (remaining.length === 0) rmdirSync(extDir);
  } catch {}

  return { agent: "copilot", action: "uninstalled", detail: "removed ~/.copilot/extensions/agents-reporting/" };
}

// ── Pi ──────────────────────────────────────────────────────────────

function setupPi(): SetupResult {
  const piExtDir = join(homedir(), ".pi", "agent", "extensions");
  if (!existsSync(join(homedir(), ".pi", "agent"))) {
    return { agent: "pi", action: "skipped", detail: "~/.pi/agent/ not found" };
  }

  const target = join(piExtDir, "agents-reporting.ts");
  const source = join(EXTENSIONS_DIR, "pi", "dustbot-reporting.ts");

  if (!existsSync(source)) {
    return { agent: "pi", action: "skipped", detail: "extension source not found in repo" };
  }

  if (existsSync(target)) {
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        return { agent: "pi", action: "installed", detail: "symlinked" };
      }
    } catch {}
    try {
      const content = readFileSync(target, "utf-8");
      if (content.includes("agents report")) {
        return { agent: "pi", action: "installed", detail: "extension present" };
      }
    } catch {}
  }

  mkdirSync(piExtDir, { recursive: true });
  try {
    if (existsSync(target)) unlinkSync(target);
    symlinkSync(source, target);
  } catch {
    writeFileSync(target, readFileSync(source, "utf-8"));
  }

  return { agent: "pi", action: "installed", detail: "symlinked" };
}

function uninstallPi(): SetupResult {
  const target = join(homedir(), ".pi", "agent", "extensions", "agents-reporting.ts");
  if (!existsSync(target)) {
    return { agent: "pi", action: "not-installed" };
  }

  try {
    const content = readFileSync(target, "utf-8");
    if (!content.includes("agents report")) {
      return { agent: "pi", action: "skipped", detail: "extension doesn't look like ours" };
    }
  } catch {}

  unlinkSync(target);
  return { agent: "pi", action: "uninstalled", detail: "removed ~/.pi/agent/extensions/agents-reporting.ts" };
}

// ── OpenCode ─────────────────────────────────────────────────────────

const OPENCODE_PLUGIN_NAME = "opencode-agents-reporting";

function setupOpencode(): SetupResult {
  const configDir = join(homedir(), ".config", "opencode");
  if (!existsSync(configDir)) {
    return { agent: "opencode", action: "skipped", detail: "~/.config/opencode/ not found" };
  }

  const source = join(EXTENSIONS_DIR, "opencode");
  if (!existsSync(join(source, "index.mjs"))) {
    return { agent: "opencode", action: "skipped", detail: "extension source not found in repo" };
  }

  // 1. Symlink plugin package into opencode's node_modules
  const nmDir = join(configDir, "node_modules");
  mkdirSync(nmDir, { recursive: true });
  const target = join(nmDir, OPENCODE_PLUGIN_NAME);

  if (existsSync(target)) {
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        // Already symlinked — check if it points to the right place
        const linkTarget = readFileSync(target + "/index.mjs", "utf-8");
        if (!linkTarget.includes("agents report")) {
          // Wrong symlink, replace it
          unlinkSync(target);
        }
      }
    } catch {}
  }

  if (!existsSync(target)) {
    try {
      symlinkSync(source, target);
    } catch {
      // Fallback: create directory and copy files
      mkdirSync(target, { recursive: true });
      for (const f of ["index.mjs", "package.json"]) {
        writeFileSync(join(target, f), readFileSync(join(source, f), "utf-8"));
      }
    }
  }

  // 2. Add plugin to global config
  const configPath = join(configDir, "config.json");
  let config: any = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  }

  const plugins: string[] = config.plugin || [];
  if (plugins.includes(OPENCODE_PLUGIN_NAME)) {
    return { agent: "opencode", action: "installed", detail: "symlinked" };
  }

  config.plugin = [...plugins, OPENCODE_PLUGIN_NAME];
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return { agent: "opencode", action: "installed", detail: "added plugin to ~/.config/opencode/config.json" };
}

function uninstallOpencode(): SetupResult {
  const configDir = join(homedir(), ".config", "opencode");
  let removed = false;

  // Remove from config
  const configPath = join(configDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const plugins: string[] = config.plugin || [];
      const filtered = plugins.filter((p: string) => p !== OPENCODE_PLUGIN_NAME);
      if (filtered.length !== plugins.length) {
        removed = true;
        if (filtered.length === 0) {
          delete config.plugin;
        } else {
          config.plugin = filtered;
        }
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      }
    } catch {}
  }

  // Remove symlink/directory from node_modules
  const target = join(configDir, "node_modules", OPENCODE_PLUGIN_NAME);
  if (existsSync(target)) {
    removed = true;
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) {
        unlinkSync(target);
      } else {
        // Directory copy — remove files then dir
        for (const f of readdirSync(target)) unlinkSync(join(target, f));
        rmdirSync(target);
      }
    } catch {}
  }

  return { agent: "opencode", action: removed ? "uninstalled" : "not-installed",
    detail: removed ? "removed plugin from ~/.config/opencode/" : undefined };
}

// ── Public API ──────────────────────────────────────────────────────

export function setup(quiet: boolean = false): SetupResult[] {
  // Verify agents CLI is available
  try {
    execSync("which agents", { encoding: "utf-8", timeout: 3000 });
  } catch {
    if (!quiet) console.error("Warning: 'agents' command not found on PATH. Hooks will fail until it is installed.");
  }

  const results = [setupClaude(), setupCodex(), setupCopilot(), setupPi(), setupOpencode()];
  saveSetupHash();
  return results;
}

export function uninstall(): SetupResult[] {
  return [uninstallClaude(), uninstallCodex(), uninstallCopilot(), uninstallPi(), uninstallOpencode()];
}

function doctorClaude(spec: AgentIntegrationSpec): DoctorResult {
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) {
    return doctorResult(spec, "unavailable", "~/.claude/ not found", []);
  }

  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    return doctorResult(spec, "not-installed", "~/.claude/settings.json not found", []);
  }

  let settings: any;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return doctorResult(spec, "broken", "could not parse ~/.claude/settings.json", []);
  }

  const hooksRoot = settings.hooks || {};
  const installedEvents: string[] = [];
  const exactHooks = [
    { name: "PreToolUse", event: "PreToolUse", def: CLAUDE_HOOKS.PreToolUse[0] },
    { name: "UserPromptSubmit", event: "UserPromptSubmit", def: CLAUDE_HOOKS.UserPromptSubmit[0] },
    { name: "Stop", event: "Stop", def: CLAUDE_HOOKS.Stop[0] },
    { name: "Notification:idle_prompt", event: "Notification", def: CLAUDE_HOOKS.Notification[0] },
    { name: "Notification:permission_prompt", event: "Notification", def: CLAUDE_HOOKS.Notification[1] },
    { name: "Notification:elicitation_dialog", event: "Notification", def: CLAUDE_HOOKS.Notification[2] },
  ];

  for (const hook of exactHooks) {
    const existing = Array.isArray(hooksRoot[hook.event]) ? hooksRoot[hook.event] : [];
    if (existing.some((candidate: any) => matchesHookDef(candidate, hook.def))) {
      installedEvents.push(hook.name);
    }
  }

  const verdict = detailFromMissingEvents(spec.configuredEvents, installedEvents, "no agents hooks found");
  return doctorResult(spec, verdict.status, verdict.detail, installedEvents);
}

function doctorCodex(spec: AgentIntegrationSpec): DoctorResult {
  const codexDir = join(homedir(), ".codex");
  if (!existsSync(codexDir)) {
    return doctorResult(spec, "unavailable", "~/.codex/ not found", []);
  }

  let configText = "";
  try {
    configText = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, "utf-8") : "";
  } catch {
    return doctorResult(spec, "broken", "could not read ~/.codex/config.toml", []);
  }

  let hooksJson: Record<string, any> = {};
  if (existsSync(CODEX_HOOKS_PATH)) {
    try {
      hooksJson = JSON.parse(readFileSync(CODEX_HOOKS_PATH, "utf-8"));
    } catch {
      return doctorResult(spec, "broken", "could not parse ~/.codex/hooks.json", []);
    }
  }

  const installedEvents: string[] = [];
  if (/^codex_hooks\s*=\s*true\s*$/m.test(configText)) {
    const normalized = normalizeCodexHooksJson(hooksJson);
    const hookRoot = normalized.hookRoot;
    const expected = codexHookEntries();
    for (const event of Object.keys(expected)) {
      const existing = Array.isArray(hookRoot[event]) ? hookRoot[event] : [];
      if (expected[event].every((group) => existing.some((candidate: any) => matchesHookDef(candidate, group)))) {
        installedEvents.push(event);
      }
    }
  }

  if (!/^codex_hooks\s*=\s*true\s*$/m.test(configText) && installedEvents.length === 0) {
    return doctorResult(spec, "not-installed", "codex_hooks is not enabled", []);
  }

  const verdict = detailFromMissingEvents(spec.configuredEvents, installedEvents, "Codex hooks are incomplete");
  return doctorResult(spec, verdict.status, verdict.detail, installedEvents);
}

function doctorCopilot(spec: AgentIntegrationSpec): DoctorResult {
  const copilotDir = join(homedir(), ".copilot");
  if (!existsSync(copilotDir)) {
    return doctorResult(spec, "unavailable", "~/.copilot/ not found", []);
  }

  const target = join(copilotDir, "extensions", "agents-reporting", "extension.mjs");
  const source = join(EXTENSIONS_DIR, "copilot", "extension.mjs");
  if (!existsSync(target)) {
    return doctorResult(spec, "not-installed", `${target} not found`, []);
  }

  const version = installedFileVersion(target, source);
  if (version.status === "unreadable") {
    return doctorResult(spec, "broken", "could not read Copilot extension", []);
  }
  if (version.status === "outdated") {
    return doctorResult(spec, "partial", mergeDetail("extension is not current", version.detail), spec.configuredEvents);
  }
  if (version.status === "missing") {
    return doctorResult(spec, "not-installed", `${target} not found`, []);
  }
  return doctorResult(spec, "installed", version.detail, spec.configuredEvents);
}

function doctorPi(spec: AgentIntegrationSpec): DoctorResult {
  const piDir = join(homedir(), ".pi", "agent");
  if (!existsSync(piDir)) {
    return doctorResult(spec, "unavailable", "~/.pi/agent/ not found", []);
  }

  const target = join(piDir, "extensions", "agents-reporting.ts");
  const source = join(EXTENSIONS_DIR, "pi", "dustbot-reporting.ts");
  if (!existsSync(target)) {
    return doctorResult(spec, "not-installed", `${target} not found`, []);
  }

  const version = installedFileVersion(target, source);
  if (version.status === "unreadable") {
    return doctorResult(spec, "broken", "could not read Pi extension", []);
  }
  if (version.status === "outdated") {
    return doctorResult(spec, "partial", mergeDetail("extension is not current", version.detail), spec.configuredEvents);
  }
  if (version.status === "missing") {
    return doctorResult(spec, "not-installed", `${target} not found`, []);
  }
  const dustbotSandbox = join(piDir, "extensions", "dustbot-sandbox.js");
  const supplemental = existsSync(dustbotSandbox) ? ["dustbot-sandbox approval bridge"] : [];
  return doctorResult(
    spec,
    "installed",
    mergeDetail(version.detail, supplemental.length ? "approval via dustbot-sandbox" : undefined),
    spec.configuredEvents,
    supplemental.length ? { approval: true } : undefined,
    supplemental,
  );
}

function doctorOpencode(spec: AgentIntegrationSpec): DoctorResult {
  const configDir = join(homedir(), ".config", "opencode");
  if (!existsSync(configDir)) {
    return doctorResult(spec, "unavailable", "~/.config/opencode/ not found", []);
  }

  const target = join(configDir, "node_modules", OPENCODE_PLUGIN_NAME, "index.mjs");
  const packageTarget = join(configDir, "node_modules", OPENCODE_PLUGIN_NAME, "package.json");
  const configPath = join(configDir, "config.json");
  const source = join(EXTENSIONS_DIR, "opencode", "index.mjs");
  const packageSource = join(EXTENSIONS_DIR, "opencode", "package.json");
  const installedEvents: string[] = [];
  let linked = false;
  let configured = false;
  let versionDetail: string | undefined;

  if (existsSync(target)) {
    const indexVersion = installedFileVersion(target, source);
    if (indexVersion.status === "unreadable") {
      return doctorResult(spec, "broken", "could not read OpenCode plugin", []);
    }
    if (indexVersion.status !== "missing") {
      linked = indexVersion.status === "current";
      versionDetail = indexVersion.detail;
    }
    if (indexVersion.status === "outdated") {
      return doctorResult(spec, "partial", mergeDetail("plugin index is not current", indexVersion.detail), []);
    }
  }

  if (existsSync(packageTarget)) {
    const packageVersion = installedFileVersion(packageTarget, packageSource);
    if (packageVersion.status === "unreadable") {
      return doctorResult(spec, "broken", "could not read OpenCode plugin package.json", []);
    }
    if (packageVersion.status === "outdated") {
      return doctorResult(spec, "partial", mergeDetail("plugin package.json is not current", packageVersion.detail), []);
    }
    versionDetail = mergeDetail(versionDetail, packageVersion.detail);
  }

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      configured = Array.isArray(config.plugin) && config.plugin.includes(OPENCODE_PLUGIN_NAME);
    } catch {
      return doctorResult(spec, "broken", "could not parse ~/.config/opencode/config.json", []);
    }
  }

  if (linked && configured) {
    installedEvents.push(...spec.configuredEvents);
    return doctorResult(spec, "installed", versionDetail, installedEvents);
  }
  if (!linked && !configured) {
    return doctorResult(spec, "not-installed", "plugin package and config entry are missing", []);
  }

  return doctorResult(
    spec,
    "partial",
    linked ? "plugin linked but config.json is missing the plugin entry" : "config.json references the plugin but the package is missing",
    [],
  );
}

function doctorResult(
  spec: AgentIntegrationSpec,
  status: DoctorResult["status"],
  detail: string | undefined,
  installedEvents: string[],
  capabilityOverrides?: Partial<AgentIntegrationSpec["capabilities"]>,
  supplemental?: string[],
): DoctorResult {
  const { missingLifecycle, missingMetadata } = applyCapabilityOverrides(spec, capabilityOverrides);
  return {
    agent: spec.agent,
    installMethod: spec.installMethod,
    status,
    ...(detail ? { detail } : {}),
    expectedEvents: spec.configuredEvents,
    installedEvents,
    missingLifecycle,
    missingMetadata,
    ...(supplemental && supplemental.length ? { supplemental } : {}),
    ...(spec.notes ? { notes: spec.notes } : {}),
  };
}

export function doctor(): DoctorResult[] {
  return INTEGRATION_SPECS.map((spec) => {
    switch (spec.agent) {
      case "claude":
        return doctorClaude(spec);
      case "codex":
        return doctorCodex(spec);
      case "copilot":
        return doctorCopilot(spec);
      case "pi":
        return doctorPi(spec);
      case "opencode":
        return doctorOpencode(spec);
    }
  });
}

// ── Auto-setup on CLI start ─────────────────────────────────────────

const HASH_FILE = getSetupHashPath();

/** Compute a hash of all setup-relevant config (hook defs + extension files). */
function computeSetupHash(): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(CLAUDE_HOOKS));
  h.update(JSON.stringify(codexHooksConfig()));
  for (const ext of ["codex/report-state.sh", "codex/stop-hook.sh", "copilot/extension.mjs", "pi/dustbot-reporting.ts", "opencode/index.mjs"]) {
    const p = join(EXTENSIONS_DIR, ext);
    try { h.update(readFileSync(p)); } catch {}
  }
  return h.digest("hex").slice(0, 16);
}

/** Check if setup needs to run and spawn it in the background if so.
 *  Returns immediately — zero impact on CLI startup time. */
export function autoSetupIfNeeded(): void {
  try {
    const current = computeSetupHash();
    let stored = "";
    try { stored = readFileSync(HASH_FILE, "utf-8").trim(); } catch {}
    if (current === stored) return;

    // Spawn detached so it doesn't block the CLI
    const child = spawn(process.execPath, [process.argv[1], "setup", "--quiet"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {}
}

/** Write the current setup hash to disk (called after successful setup). */
function saveSetupHash(): void {
  try {
    mkdirSync(getAgentsHome(), { recursive: true });
    writeFileSync(HASH_FILE, computeSetupHash());
  } catch {}
}
