/**
 * Setup and uninstall logic for agents hook integrations.
 *
 * Supports:
 *   - Claude Code: patches ~/.claude/settings.json with hooks
 *   - Copilot CLI: symlinks extension to ~/.copilot/extensions/agents-reporting/
 *   - Pi: symlinks extension to ~/.pi/agent/extensions/agents-reporting/
 *   - OpenCode: symlinks plugin to ~/.config/opencode/node_modules/ and patches config.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readdirSync, rmdirSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
// extensions/ lives next to src/ in the repo root
const REPO_ROOT = join(__dirname, "..");
const EXTENSIONS_DIR = join(REPO_ROOT, "extensions");

interface SetupResult {
  agent: string;
  action: "installed" | "uninstalled" | "skipped" | "not-installed";
  detail?: string;
}

// ── Claude Code ─────────────────────────────────────────────────────

const STOP_HOOK_SCRIPT = join(EXTENSIONS_DIR, "claude", "stop-hook.sh");

const CLAUDE_HOOKS = {
  PreToolUse: [{ hooks: [{ type: "command", command: "agents report --agent claude --state working --session \"$TMUX_PANE\"" }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "agents report --agent claude --state working --session \"$TMUX_PANE\"" }] }],
  Stop: [{ hooks: [{ type: "command", command: STOP_HOOK_SCRIPT }] }],
  Notification: [
    { matcher: "idle_prompt", hooks: [{ type: "command", command: "agents report --agent claude --state idle --session \"$TMUX_PANE\"" }] },
    { matcher: "permission_prompt", hooks: [{ type: "command", command: "agents report --agent claude --state approval --session \"$TMUX_PANE\"" }] },
    { matcher: "elicitation_dialog", hooks: [{ type: "command", command: "agents report --agent claude --state question --session \"$TMUX_PANE\"" }] },
  ],
};

// Hook events from older versions that should be cleaned up on setup/uninstall
const LEGACY_EVENTS = ["PermissionRequest"];

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
    return s.includes("agents report --agent claude") || s.includes("extensions/claude/");
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
    return s.includes("agents report --agent claude") || s.includes("extensions/claude/");
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

  const results = [setupClaude(), setupCopilot(), setupPi(), setupOpencode()];
  saveSetupHash();
  return results;
}

export function uninstall(): SetupResult[] {
  return [uninstallClaude(), uninstallCopilot(), uninstallPi(), uninstallOpencode()];
}

// ── Auto-setup on CLI start ─────────────────────────────────────────

const HASH_FILE = join(homedir(), ".agents", ".setup-hash");

/** Compute a hash of all setup-relevant config (hook defs + extension files). */
function computeSetupHash(): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(CLAUDE_HOOKS));
  for (const ext of ["copilot/extension.mjs", "pi/dustbot-reporting.ts", "opencode/index.mjs"]) {
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
    mkdirSync(join(homedir(), ".agents"), { recursive: true });
    writeFileSync(HASH_FILE, computeSetupHash());
  } catch {}
}
