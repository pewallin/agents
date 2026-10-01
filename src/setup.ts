/**
 * Setup and uninstall logic for agents hook integrations.
 *
 * Supports:
 *   - Claude Code: patches ~/.claude/settings.json with hooks
 *   - Codex CLI: patches ~/.codex/config.toml and ~/.codex/hooks.json
 *   - Copilot CLI: symlinks extension to ~/.copilot/extensions/agents-reporting/
 *   - Pi: symlinks extension to ~/.pi/agent/extensions/agents-reporting/
 *   - OpenCode: symlinks plugin to ~/.config/opencode/node_modules/ and patches config.json
 *   - Kiro CLI: writes ~/.kiro/agents/agents-reporting.json with hook commands
 *   - Hermes: patches ~/.hermes/config.yaml shell hooks and allowlists our hook command
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readdirSync, rmdirSync, realpathSync, statSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync, execSync, spawn } from "child_process";
import { getAgentsHome, getLogsDir, getSetupHashPath } from "./paths.js";
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

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
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

export function ensureCodexHooksEnabled(configText: string): { text: string; changed: boolean } {
  let text = configText.replace(/^codex_hooks\s*=\s*(?:true|false)\s*$/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  const removedDeprecatedFlag = text !== configText;

  if (/^hooks\s*=\s*true\s*$/m.test(text)) {
    return { text, changed: removedDeprecatedFlag };
  }

  if (/^hooks\s*=\s*false\s*$/m.test(text)) {
    return { text: text.replace(/^hooks\s*=\s*false\s*$/m, "hooks = true"), changed: true };
  }

  if (/^\[features\]\s*$/m.test(text)) {
    return {
      text: text.replace(/^\[features\]\s*$/m, `[features]\nhooks = true`),
      changed: true,
    };
  }

  const suffix = text.endsWith("\n") || text.length === 0 ? "" : "\n";
  return { text: `${text}${suffix}\n[features]\nhooks = true\n`, changed: true };
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

// ── Kiro CLI ────────────────────────────────────────────────────────

const KIRO_AGENT_NAME = "agents-reporting";
const KIRO_AGENT_PATH = join(homedir(), ".kiro", "agents", `${KIRO_AGENT_NAME}.json`);
const KIRO_V3_HOOK_PATH = join(homedir(), ".kiro", "hooks", `${KIRO_AGENT_NAME}.json`);
const KIRO_SETTINGS_PATH = join(homedir(), ".kiro", "settings", "cli.json");
const KIRO_REPORT_SCRIPT = join(EXTENSIONS_DIR, "kiro", "report-state.sh");
const KIRO_V3_HOOK_SPECS = [
  { event: "agentSpawn", name: "agents-reporting-session-start", trigger: "SessionStart" },
  { event: "userPromptSubmit", name: "agents-reporting-user-prompt", trigger: "UserPromptSubmit" },
  { event: "preToolUse", name: "agents-reporting-pre-tool", trigger: "PreToolUse", matcher: "*" },
  { event: "postToolUse", name: "agents-reporting-post-tool", trigger: "PostToolUse", matcher: "*" },
  { event: "stop", name: "agents-reporting-stop", trigger: "Stop" },
] as const;

function kiroHookEntries(): Record<string, any[]> {
  const base = {
    command: `AGENTS_KIRO_V2_HOOK=1 ${KIRO_REPORT_SCRIPT}`,
    timeout_ms: 10000,
    max_output_size: 1024,
  };
  return {
    agentSpawn: [base],
    userPromptSubmit: [base],
    preToolUse: [{ ...base, matcher: "*" }],
    postToolUse: [{ ...base, matcher: "*" }],
    stop: [base],
  };
}

function kiroAgentConfig(): Record<string, any> {
  return {
    name: KIRO_AGENT_NAME,
    description: "Reports Kiro CLI lifecycle state to the agents dashboard.",
    tools: ["*"],
    hooks: kiroHookEntries(),
    includeMcpJson: true,
  };
}

function kiroV3HookConfig(): Record<string, any> {
  return {
    version: "v1",
    hooks: KIRO_V3_HOOK_SPECS.map((spec) => ({
      name: spec.name,
      trigger: spec.trigger,
      ...("matcher" in spec ? { matcher: spec.matcher } : {}),
      action: { type: "command", command: KIRO_REPORT_SCRIPT },
      timeout: 10,
    })),
  };
}

function isOurKiroAgentConfig(config: any): boolean {
  const text = JSON.stringify(config);
  return config?.name === KIRO_AGENT_NAME && (
    text.includes(KIRO_REPORT_SCRIPT)
    || text.includes("extensions/kiro/")
    || text.includes("--agent kiro")
  );
}

function isOurKiroV3HookConfig(config: any): boolean {
  const text = JSON.stringify(config);
  return config?.version === "v1" && Array.isArray(config?.hooks) && (
    text.includes(KIRO_REPORT_SCRIPT)
    || text.includes("extensions/kiro/report-state.sh")
    || text.includes("--agent kiro")
  );
}

function installedKiroV3HookEvents(config: any): string[] {
  const hooks = Array.isArray(config?.hooks) ? config.hooks : [];
  const expected = kiroV3HookConfig().hooks;
  return KIRO_V3_HOOK_SPECS
    .filter((_spec, index) => hooks.some((candidate: any) => matchesHookDef(candidate, expected[index])))
    .map((spec) => spec.event);
}

function readKiroSettings(): { settings: Record<string, any>; error?: string } {
  if (!existsSync(KIRO_SETTINGS_PATH)) {
    return { settings: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(KIRO_SETTINGS_PATH, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { settings: {}, error: "could not parse ~/.kiro/settings/cli.json" };
    }
    return { settings: parsed };
  } catch {
    return { settings: {}, error: "could not parse ~/.kiro/settings/cli.json" };
  }
}

function kiroDefaultAgentStatus(): { active: boolean; detail?: string; current?: string } {
  const { settings, error } = readKiroSettings();
  if (error) {
    return { active: false, detail: `${error}; launch Kiro with --agent ${KIRO_AGENT_NAME}` };
  }

  const current = settings["chat.defaultAgent"];
  if (current === KIRO_AGENT_NAME) {
    return { active: true, current, detail: `default agent ${KIRO_AGENT_NAME}` };
  }
  if (typeof current === "string" && current.length > 0) {
    return { active: false, current, detail: `default agent is ${current}; launch Kiro with --agent ${KIRO_AGENT_NAME}` };
  }
  return { active: false, detail: `default agent not set; launch Kiro with --agent ${KIRO_AGENT_NAME}` };
}

function ensureKiroDefaultAgent(): string | undefined {
  const { settings, error } = readKiroSettings();
  if (error) {
    return `${error}; launch Kiro with --agent ${KIRO_AGENT_NAME}`;
  }

  const current = settings["chat.defaultAgent"];
  if (current === KIRO_AGENT_NAME) {
    return `default agent ${KIRO_AGENT_NAME}`;
  }
  if (typeof current === "string" && current.length > 0) {
    return `default agent is ${current}; launch Kiro with --agent ${KIRO_AGENT_NAME}`;
  }

  mkdirSync(dirname(KIRO_SETTINGS_PATH), { recursive: true });
  settings["chat.defaultAgent"] = KIRO_AGENT_NAME;
  writeFileSync(KIRO_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  return `set default agent to ${KIRO_AGENT_NAME}`;
}

function setupKiro(): SetupResult {
  const kiroDir = join(homedir(), ".kiro");
  if (!existsSync(kiroDir) && !commandExists("kiro-cli")) {
    return { agent: "kiro", action: "skipped", detail: "~/.kiro/ not found and kiro-cli is not on PATH" };
  }
  if (!existsSync(KIRO_REPORT_SCRIPT)) {
    return { agent: "kiro", action: "skipped", detail: "extension source not found in repo" };
  }

  let existingAgent: any;
  if (existsSync(KIRO_AGENT_PATH)) {
    try {
      existingAgent = JSON.parse(readFileSync(KIRO_AGENT_PATH, "utf-8"));
    } catch {
      return { agent: "kiro", action: "skipped", detail: "could not parse ~/.kiro/agents/agents-reporting.json" };
    }
    if (!isOurKiroAgentConfig(existingAgent)) {
      return { agent: "kiro", action: "skipped", detail: "~/.kiro/agents/agents-reporting.json exists and is not managed by agents" };
    }
  }

  let existingV3Hooks: any;
  if (existsSync(KIRO_V3_HOOK_PATH)) {
    try {
      existingV3Hooks = JSON.parse(readFileSync(KIRO_V3_HOOK_PATH, "utf-8"));
    } catch {
      return { agent: "kiro", action: "skipped", detail: "could not parse ~/.kiro/hooks/agents-reporting.json" };
    }
    if (!isOurKiroV3HookConfig(existingV3Hooks)) {
      return { agent: "kiro", action: "skipped", detail: "~/.kiro/hooks/agents-reporting.json exists and is not managed by agents" };
    }
  }

  const nextAgent = kiroAgentConfig();
  const nextV3Hooks = kiroV3HookConfig();
  const agentChanged = JSON.stringify(existingAgent) !== JSON.stringify(nextAgent);
  const v3HooksChanged = JSON.stringify(existingV3Hooks) !== JSON.stringify(nextV3Hooks);
  if (agentChanged) {
    mkdirSync(dirname(KIRO_AGENT_PATH), { recursive: true });
    writeFileSync(KIRO_AGENT_PATH, JSON.stringify(nextAgent, null, 2) + "\n");
  }
  if (v3HooksChanged) {
    mkdirSync(dirname(KIRO_V3_HOOK_PATH), { recursive: true });
    writeFileSync(KIRO_V3_HOOK_PATH, JSON.stringify(nextV3Hooks, null, 2) + "\n");
  }

  const configDetail = agentChanged || v3HooksChanged
    ? "wrote Kiro v2 agent and v3 global hooks"
    : "Kiro v2 agent and v3 global hooks present";
  return { agent: "kiro", action: "installed", detail: mergeDetail(configDetail, ensureKiroDefaultAgent()) };
}

function uninstallKiro(): SetupResult {
  const hasAgent = existsSync(KIRO_AGENT_PATH);
  const hasV3Hooks = existsSync(KIRO_V3_HOOK_PATH);
  if (!hasAgent && !hasV3Hooks) {
    return { agent: "kiro", action: "not-installed" };
  }

  if (hasAgent) {
    let existing: any;
    try {
      existing = JSON.parse(readFileSync(KIRO_AGENT_PATH, "utf-8"));
    } catch {
      return { agent: "kiro", action: "skipped", detail: "could not parse ~/.kiro/agents/agents-reporting.json" };
    }
    if (!isOurKiroAgentConfig(existing)) {
      return { agent: "kiro", action: "skipped", detail: "agent config doesn't look like ours" };
    }
  }

  if (hasV3Hooks) {
    let existing: any;
    try {
      existing = JSON.parse(readFileSync(KIRO_V3_HOOK_PATH, "utf-8"));
    } catch {
      return { agent: "kiro", action: "skipped", detail: "could not parse ~/.kiro/hooks/agents-reporting.json" };
    }
    if (!isOurKiroV3HookConfig(existing)) {
      return { agent: "kiro", action: "skipped", detail: "v3 hook config doesn't look like ours" };
    }
  }

  const removed: string[] = [];
  if (hasAgent) {
    unlinkSync(KIRO_AGENT_PATH);
    removed.push("Kiro v2 agent");
  }
  if (hasV3Hooks) {
    unlinkSync(KIRO_V3_HOOK_PATH);
    removed.push("Kiro v3 global hooks");
  }

  let detail = `removed ${removed.join(" and ")}`;
  const { settings } = readKiroSettings();
  if (settings["chat.defaultAgent"] === KIRO_AGENT_NAME) {
    delete settings["chat.defaultAgent"];
    mkdirSync(dirname(KIRO_SETTINGS_PATH), { recursive: true });
    writeFileSync(KIRO_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
    detail = mergeDetail(detail, `cleared default agent ${KIRO_AGENT_NAME}`) || detail;
  }
  return { agent: "kiro", action: "uninstalled", detail };
}

// ── Hermes ───────────────────────────────────────────────────────────────

const HERMES_CONFIG_PATH = join(homedir(), ".hermes", "config.yaml");
const HERMES_ALLOWLIST_PATH = join(homedir(), ".hermes", "shell-hooks-allowlist.json");
const HERMES_REPORT_SCRIPT = join(EXTENSIONS_DIR, "hermes", "report-state.sh");
const HERMES_HOOK_TIMEOUT_SECONDS = 10;
const HERMES_HOOK_EVENTS = [
  "on_session_start",
  "pre_llm_call",
  "pre_api_request",
  "post_api_request",
  "pre_tool_call",
  "post_tool_call",
  "pre_approval_request",
  "post_approval_response",
  "post_llm_call",
  "on_session_end",
  "on_session_finalize",
  "on_session_reset",
];

function yamlDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function hermesHookItemLines(command: string = HERMES_REPORT_SCRIPT): string[] {
  return [
    `    - command: ${yamlDoubleQuoted(command)}`,
    `      timeout: ${HERMES_HOOK_TIMEOUT_SECONDS}`,
  ];
}

function hermesHooksBlock(command: string = HERMES_REPORT_SCRIPT): string[] {
  return [
    "hooks:",
    ...HERMES_HOOK_EVENTS.flatMap((event) => [
      `  ${event}:`,
      ...hermesHookItemLines(command),
    ]),
  ];
}

function isTopLevelYamlKey(line: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line);
}

function isHermesEventHeader(line: string): RegExpMatchArray | null {
  return line.match(/^  ([A-Za-z_][A-Za-z0-9_]*):\s*$/);
}

function isHermesHookText(text: string): boolean {
  return text.includes(HERMES_REPORT_SCRIPT)
    || text.includes("extensions/hermes/report-state.sh")
    || text.includes("--agent hermes");
}

function removeOurHermesItems(lines: string[]): string[] {
  const result: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (!current.length) return;
    if (!isHermesHookText(current.join("\n"))) {
      result.push(...current);
    }
    current = [];
  };

  for (const line of lines) {
    if (/^    - /.test(line)) {
      flush();
      current = [line];
    } else if (current.length) {
      current.push(line);
    } else {
      result.push(line);
    }
  }
  flush();

  return result;
}

function hasHermesListItem(lines: string[]): boolean {
  return lines.some((line) => /^    - /.test(line));
}

function findHermesHooksBlock(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /^hooks\s*:/.test(line));
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isTopLevelYamlKey(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function rewriteHermesHooksBlock(blockLines: string[], mode: "install" | "remove"): string[] {
  const installed = new Set<string>();
  const output: string[] = ["hooks:"];
  let i = 1;

  while (i < blockLines.length) {
    const header = isHermesEventHeader(blockLines[i]);
    if (!header) {
      output.push(blockLines[i]);
      i += 1;
      continue;
    }

    const event = header[1];
    const section = [blockLines[i]];
    i += 1;
    while (i < blockLines.length && !isHermesEventHeader(blockLines[i])) {
      section.push(blockLines[i]);
      i += 1;
    }

    if (!HERMES_HOOK_EVENTS.includes(event)) {
      output.push(...section);
      continue;
    }

    const retained = removeOurHermesItems(section.slice(1));
    if (mode === "remove") {
      if (hasHermesListItem(retained)) {
        output.push(`  ${event}:`, ...retained);
      }
      continue;
    }

    output.push(`  ${event}:`, ...retained, ...hermesHookItemLines());
    installed.add(event);
  }

  if (mode === "install") {
    for (const event of HERMES_HOOK_EVENTS) {
      if (installed.has(event)) continue;
      output.push(`  ${event}:`, ...hermesHookItemLines());
    }
  }

  if (mode === "remove" && output.length === 1) return ["hooks: {}"];
  return output;
}

export function ensureHermesHooksConfig(configText: string): { text: string; changed: boolean } {
  const lines = configText.split("\n");
  const block = findHermesHooksBlock(lines);
  const nextBlock = hermesHooksBlock();

  if (!block) {
    const prefix = configText.endsWith("\n") || configText.length === 0 ? "" : "\n";
    return { text: `${configText}${prefix}${nextBlock.join("\n")}\n`, changed: true };
  }

  const currentBlock = lines.slice(block.start, block.end);
  const rewritten = rewriteHermesHooksBlock(currentBlock, "install");
  const nextLines = [...lines.slice(0, block.start), ...rewritten, ...lines.slice(block.end)];
  const nextText = nextLines.join("\n");
  return { text: nextText, changed: nextText !== configText };
}

export function removeHermesHooksConfig(configText: string): { text: string; changed: boolean } {
  const lines = configText.split("\n");
  const block = findHermesHooksBlock(lines);
  if (!block) return { text: configText, changed: false };

  const currentBlock = lines.slice(block.start, block.end);
  const rewritten = rewriteHermesHooksBlock(currentBlock, "remove");
  const nextLines = [...lines.slice(0, block.start), ...rewritten, ...lines.slice(block.end)];
  const nextText = nextLines.join("\n");
  return { text: nextText, changed: nextText !== configText };
}

function installedHermesHookEvents(configText: string): string[] {
  const lines = configText.split("\n");
  const block = findHermesHooksBlock(lines);
  if (!block) return [];

  const blockLines = lines.slice(block.start, block.end);
  const installed: string[] = [];
  let i = 1;
  while (i < blockLines.length) {
    const header = isHermesEventHeader(blockLines[i]);
    if (!header) {
      i += 1;
      continue;
    }
    const event = header[1];
    const section = [blockLines[i]];
    i += 1;
    while (i < blockLines.length && !isHermesEventHeader(blockLines[i])) {
      section.push(blockLines[i]);
      i += 1;
    }
    if (HERMES_HOOK_EVENTS.includes(event) && isHermesHookText(section.join("\n"))) {
      installed.push(event);
    }
  }
  return installed;
}

function hermesScriptMtimeIso(): string | undefined {
  try {
    return statSync(HERMES_REPORT_SCRIPT).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function readHermesAllowlist(): { allowlist: any; error?: string } {
  if (!existsSync(HERMES_ALLOWLIST_PATH)) return { allowlist: { approvals: [] } };
  try {
    const parsed = JSON.parse(readFileSync(HERMES_ALLOWLIST_PATH, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { allowlist: { approvals: [] }, error: "could not parse ~/.hermes/shell-hooks-allowlist.json" };
    }
    if (!Array.isArray(parsed.approvals)) parsed.approvals = [];
    return { allowlist: parsed };
  } catch {
    return { allowlist: { approvals: [] }, error: "could not parse ~/.hermes/shell-hooks-allowlist.json" };
  }
}

function approvedHermesHookEvents(): string[] {
  const { allowlist, error } = readHermesAllowlist();
  if (error) return [];
  return HERMES_HOOK_EVENTS.filter((event) =>
    allowlist.approvals.some((entry: any) =>
      entry?.event === event && entry?.command === HERMES_REPORT_SCRIPT,
    ),
  );
}

function ensureHermesAllowlist(): { changed: boolean; error?: string } {
  const { allowlist, error } = readHermesAllowlist();
  if (error) return { changed: false, error };

  const approvedAt = new Date().toISOString();
  const scriptMtime = hermesScriptMtimeIso();
  const existing = Array.isArray(allowlist.approvals) ? allowlist.approvals : [];
  const filtered = existing.filter((entry: any) =>
    !(HERMES_HOOK_EVENTS.includes(entry?.event) && entry?.command === HERMES_REPORT_SCRIPT),
  );
  const additions = HERMES_HOOK_EVENTS.map((event) => ({
    event,
    command: HERMES_REPORT_SCRIPT,
    approved_at: approvedAt,
    ...(scriptMtime ? { script_mtime_at_approval: scriptMtime } : {}),
  }));
  const next = { ...allowlist, approvals: [...filtered, ...additions] };

  if (JSON.stringify(next) === JSON.stringify(allowlist)) return { changed: false };

  mkdirSync(dirname(HERMES_ALLOWLIST_PATH), { recursive: true });
  writeFileSync(HERMES_ALLOWLIST_PATH, JSON.stringify(next, null, 2) + "\n");
  return { changed: true };
}

function removeHermesAllowlist(): boolean {
  const { allowlist, error } = readHermesAllowlist();
  if (error) return false;
  const existing = Array.isArray(allowlist.approvals) ? allowlist.approvals : [];
  const filtered = existing.filter((entry: any) =>
    !(HERMES_HOOK_EVENTS.includes(entry?.event) && entry?.command === HERMES_REPORT_SCRIPT),
  );
  if (filtered.length === existing.length) return false;

  mkdirSync(dirname(HERMES_ALLOWLIST_PATH), { recursive: true });
  writeFileSync(HERMES_ALLOWLIST_PATH, JSON.stringify({ ...allowlist, approvals: filtered }, null, 2) + "\n");
  return true;
}

function setupHermes(): SetupResult {
  const hermesDir = join(homedir(), ".hermes");
  if (!existsSync(hermesDir) && !commandExists("hermes")) {
    return { agent: "hermes", action: "skipped", detail: "~/.hermes/ not found and hermes is not on PATH" };
  }
  if (!existsSync(HERMES_REPORT_SCRIPT)) {
    return { agent: "hermes", action: "skipped", detail: "extension source not found in repo" };
  }
  if (!existsSync(HERMES_CONFIG_PATH)) {
    return { agent: "hermes", action: "skipped", detail: "~/.hermes/config.yaml not found" };
  }

  let configText = "";
  try {
    configText = readFileSync(HERMES_CONFIG_PATH, "utf-8");
  } catch {
    return { agent: "hermes", action: "skipped", detail: "could not read ~/.hermes/config.yaml" };
  }

  const configUpdate = ensureHermesHooksConfig(configText);
  const allowlistUpdate = ensureHermesAllowlist();
  if (allowlistUpdate.error) {
    return { agent: "hermes", action: "skipped", detail: allowlistUpdate.error };
  }

  if (configUpdate.changed) writeFileSync(HERMES_CONFIG_PATH, configUpdate.text);

  if (!configUpdate.changed && !allowlistUpdate.changed) {
    return { agent: "hermes", action: "installed", detail: "hooks configured and allowlisted" };
  }

  return { agent: "hermes", action: "installed", detail: "patched ~/.hermes/config.yaml and shell hook allowlist" };
}

function uninstallHermes(): SetupResult {
  let removedConfig = false;
  if (existsSync(HERMES_CONFIG_PATH)) {
    try {
      const current = readFileSync(HERMES_CONFIG_PATH, "utf-8");
      const next = removeHermesHooksConfig(current);
      if (next.changed) {
        writeFileSync(HERMES_CONFIG_PATH, next.text);
        removedConfig = true;
      }
    } catch {
      return { agent: "hermes", action: "skipped", detail: "could not update ~/.hermes/config.yaml" };
    }
  }

  const removedAllowlist = removeHermesAllowlist();
  return {
    agent: "hermes",
    action: removedConfig || removedAllowlist ? "uninstalled" : "not-installed",
    ...(removedConfig || removedAllowlist ? { detail: "removed Hermes hooks and allowlist entries" } : {}),
  };
}

// ── Public API ──────────────────────────────────────────────────────

export function setup(quiet: boolean = false): SetupResult[] {
  // Verify agents CLI is available
  try {
    execSync("which agents", { encoding: "utf-8", timeout: 3000 });
  } catch {
    if (!quiet) console.error("Warning: 'agents' command not found on PATH. Hooks will fail until it is installed.");
  }

  writeHookRuntime();
  const results = [setupClaude(), setupCodex(), setupCopilot(), setupPi(), setupOpencode(), setupKiro(), setupHermes()];
  saveSetupHash();
  return results;
}

// ── Hook runtime ────────────────────────────────────────────────────

const HOOK_LIB = join(EXTENSIONS_DIR, "lib", "agents-hook.sh");

export function hookRuntimePath(): string {
  return join(getAgentsHome(), "hook-runtime.env");
}

/** Records the node this CLI runs with and its cli.js for the hook scripts. The node is only
 *  their first choice (extensions/lib/agents-hook.sh): a removed or broken one falls back. */
export function writeHookRuntime(): void {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const text = [
    "# Written by `agents setup`; read by extensions/lib/agents-hook.sh.",
    `AGENTS_HOOK_NODE=${quote(process.execPath)}`,
    `AGENTS_HOOK_CLI=${quote(join(__dirname, "cli.js"))}`,
    "",
  ].join("\n");
  try {
    mkdirSync(getAgentsHome(), { recursive: true });
    writeFileSync(hookRuntimePath(), text);
  } catch {}
}

export interface HookRuntimeProbe {
  /** Lines from agents_hook_probe: "ok <node> <cli>" or "fail <node> <error>". */
  shellEnvironment: string[];
  /** The same with a bare PATH, as agents launched from a login shell or the app may have. */
  minimalEnvironment: string[];
  recentErrors: string[];
}

function probeHookRuntime(env: NodeJS.ProcessEnv): string[] {
  try {
    const result = execFileSync("/bin/bash", ["-c", '. "$1"; agents_hook_probe', "agents-hook", HOOK_LIB], {
      encoding: "utf-8",
      timeout: 15000,
      env,
    });
    return result.split("\n").filter(Boolean);
  } catch (error: any) {
    const output = String(error?.stdout ?? "").split("\n").filter(Boolean);
    return output.length ? output : [`fail - ${error?.message ?? error}`];
  }
}

/** Runs the hook scripts' own lookup, as hooks would, and reads their recent failures. */
export function probeHooks(): HookRuntimeProbe {
  const minimal: NodeJS.ProcessEnv = { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const key of ["AGENTS_HOME", "AGENTS_SHARED_HOME", "AGENTS_PRODUCT_DIRNAME", "AGENTS_LOG_DIR"]) {
    if (process.env[key]) minimal[key] = process.env[key];
  }
  let recentErrors: string[] = [];
  try {
    const dayAgo = Date.now() - 86_400_000;
    recentErrors = readFileSync(join(getLogsDir(), "hooks.log"), "utf-8").split("\n").filter(Boolean)
      .filter((line) => Date.parse(line.split(" ")[0] ?? "") >= dayAgo)
      .slice(-5);
  } catch {}
  return {
    shellEnvironment: probeHookRuntime(process.env),
    minimalEnvironment: probeHookRuntime(minimal),
    recentErrors,
  };
}

export function uninstall(): SetupResult[] {
  return [uninstallClaude(), uninstallCodex(), uninstallCopilot(), uninstallPi(), uninstallOpencode(), uninstallKiro(), uninstallHermes()];
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
  if (/^hooks\s*=\s*true\s*$/m.test(configText)) {
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

  if (!/^hooks\s*=\s*true\s*$/m.test(configText) && installedEvents.length === 0) {
    return doctorResult(spec, "not-installed", "hooks is not enabled", []);
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

function doctorKiro(spec: AgentIntegrationSpec): DoctorResult {
  const kiroDir = join(homedir(), ".kiro");
  if (!existsSync(kiroDir) && !commandExists("kiro-cli")) {
    return doctorResult(spec, "unavailable", "~/.kiro/ not found and kiro-cli is not on PATH", []);
  }
  const hasAgent = existsSync(KIRO_AGENT_PATH);
  const hasV3Hooks = existsSync(KIRO_V3_HOOK_PATH);
  if (!hasAgent && !hasV3Hooks) {
    return doctorResult(spec, "not-installed", "Kiro v2 agent and v3 global hooks not found", []);
  }
  if (!hasAgent) {
    return doctorResult(spec, "partial", "~/.kiro/agents/agents-reporting.json not found", []);
  }

  let config: any;
  try {
    config = JSON.parse(readFileSync(KIRO_AGENT_PATH, "utf-8"));
  } catch {
    return doctorResult(spec, "broken", "could not parse ~/.kiro/agents/agents-reporting.json", []);
  }
  if (!isOurKiroAgentConfig(config)) {
    return doctorResult(spec, "broken", "~/.kiro/agents/agents-reporting.json is not managed by agents", []);
  }

  const installedV2Events: string[] = [];
  const hooksRoot = config.hooks || {};
  const expected = kiroHookEntries();
  for (const event of Object.keys(expected)) {
    const existing = Array.isArray(hooksRoot[event]) ? hooksRoot[event] : [];
    if (expected[event].every((group) => existing.some((candidate: any) => matchesHookDef(candidate, group)))) {
      installedV2Events.push(event);
    }
  }

  const v2Verdict = detailFromMissingEvents(spec.configuredEvents, installedV2Events, "Kiro v2 hooks are incomplete");
  if (v2Verdict.status !== "installed") {
    return doctorResult(spec, v2Verdict.status, v2Verdict.detail, installedV2Events);
  }
  if (!hasV3Hooks) {
    return doctorResult(spec, "partial", "~/.kiro/hooks/agents-reporting.json not found", installedV2Events);
  }

  let v3Config: any;
  try {
    v3Config = JSON.parse(readFileSync(KIRO_V3_HOOK_PATH, "utf-8"));
  } catch {
    return doctorResult(spec, "broken", "could not parse ~/.kiro/hooks/agents-reporting.json", installedV2Events);
  }
  if (!isOurKiroV3HookConfig(v3Config)) {
    return doctorResult(spec, "broken", "~/.kiro/hooks/agents-reporting.json is not managed by agents", installedV2Events);
  }

  const installedV3Events = installedKiroV3HookEvents(v3Config);
  const v3Verdict = detailFromMissingEvents(spec.configuredEvents, installedV3Events, "Kiro v3 hooks are incomplete");
  const installedEvents = spec.configuredEvents.filter((event) => installedV2Events.includes(event) && installedV3Events.includes(event));
  if (v3Verdict.status !== "installed") {
    return doctorResult(spec, v3Verdict.status, v3Verdict.detail, installedEvents);
  }

  const defaultStatus = kiroDefaultAgentStatus();
  if (!defaultStatus.active) {
    return doctorResult(spec, "partial", defaultStatus.detail, installedEvents);
  }
  return doctorResult(spec, "installed", "Kiro v2 agent and v3 global hooks configured", installedEvents);
}

function doctorHermes(spec: AgentIntegrationSpec): DoctorResult {
  const hermesDir = join(homedir(), ".hermes");
  if (!existsSync(hermesDir) && !commandExists("hermes")) {
    return doctorResult(spec, "unavailable", "~/.hermes/ not found and hermes is not on PATH", []);
  }
  if (!existsSync(HERMES_REPORT_SCRIPT)) {
    return doctorResult(spec, "broken", "Hermes reporting script is missing from the repo", []);
  }
  if (!existsSync(HERMES_CONFIG_PATH)) {
    return doctorResult(spec, "not-installed", "~/.hermes/config.yaml not found", []);
  }

  let configText = "";
  try {
    configText = readFileSync(HERMES_CONFIG_PATH, "utf-8");
  } catch {
    return doctorResult(spec, "broken", "could not read ~/.hermes/config.yaml", []);
  }

  const installedEvents = installedHermesHookEvents(configText);
  const approvedEvents = approvedHermesHookEvents();
  const verdict = detailFromMissingEvents(spec.configuredEvents, installedEvents, "Hermes hooks are incomplete");
  if (verdict.status !== "installed") {
    return doctorResult(spec, verdict.status, verdict.detail, installedEvents);
  }

  const missingApprovals = spec.configuredEvents.filter((event) => !approvedEvents.includes(event));
  if (missingApprovals.length) {
    return doctorResult(spec, "partial", `hooks configured but not allowlisted for ${missingApprovals.join(", ")}`, installedEvents);
  }

  return doctorResult(spec, "installed", "hooks configured and allowlisted", installedEvents);
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
      case "kiro":
        return doctorKiro(spec);
      case "hermes":
        return doctorHermes(spec);
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
  h.update(JSON.stringify(kiroAgentConfig()));
  h.update(JSON.stringify(kiroV3HookConfig()));
  h.update(JSON.stringify(hermesHooksBlock()));
  h.update("kiro-default-agent-v1");
  for (const ext of ["lib/agents-hook.sh", "claude/state-hook.sh", "claude/stop-hook.sh", "claude/prompt-hook.sh", "codex/report-state.sh", "codex/stop-hook.sh", "copilot/extension.mjs", "pi/dustbot-reporting.ts", "opencode/index.mjs", "kiro/report-state.sh", "hermes/report-state.sh"]) {
    const p = join(EXTENSIONS_DIR, ext);
    try { h.update(readFileSync(p)); } catch {}
  }
  return h.digest("hex").slice(0, 16);
}

/** Check if setup needs to run and spawn it in the background if so.
 *  Returns immediately — zero impact on CLI startup time. */
export function autoSetupIfNeeded(): void {
  // Tests and private homes must not rewrite the user's agent configuration.
  if (process.env.AGENTS_NO_AUTO_SETUP === "1") return;
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
