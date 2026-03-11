/**
 * Setup and uninstall logic for agents hook integrations.
 *
 * Supports:
 *   - Claude Code: patches ~/.claude/settings.json with hooks
 *   - Copilot CLI: symlinks extension to ~/.copilot/extensions/agents-reporting/
 *   - Pi: symlinks extension to ~/.pi/agent/extensions/agents-reporting/
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync, readdirSync, rmdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
// extensions/ lives next to src/ in the repo root
const REPO_ROOT = join(__dirname, "..");
const EXTENSIONS_DIR = join(REPO_ROOT, "extensions");

interface SetupResult {
  agent: string;
  action: "installed" | "uninstalled" | "skipped" | "already-installed" | "not-installed";
  detail?: string;
}

// ── Claude Code ─────────────────────────────────────────────────────

const CLAUDE_HOOKS = {
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "agents report --agent claude --state working --session \"$TMUX_PANE\"" }] }],
  Stop: [{ hooks: [{ type: "command", command: "agents report --agent claude --state idle --session \"$TMUX_PANE\"" }] }],
  PermissionRequest: [{ hooks: [{ type: "command", command: "agents report --agent claude --state approval --session \"$TMUX_PANE\"" }] }],
};

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

  // Check if already installed
  const existing = settings.hooks;
  if (existing?.UserPromptSubmit && existing?.Stop && existing?.PermissionRequest) {
    const hasOurs = JSON.stringify(existing.UserPromptSubmit).includes("agents report --agent claude");
    if (hasOurs) {
      return { agent: "claude", action: "already-installed" };
    }
  }

  // Merge hooks — preserve any existing hooks the user has
  settings.hooks = settings.hooks || {};
  for (const [event, hookDefs] of Object.entries(CLAUDE_HOOKS)) {
    const existingHooks: any[] = settings.hooks[event] || [];
    const alreadyHas = existingHooks.some((h: any) =>
      JSON.stringify(h).includes("agents report --agent claude")
    );
    if (!alreadyHas) {
      settings.hooks[event] = [...existingHooks, ...hookDefs];
    }
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

  let removed = false;
  for (const event of Object.keys(CLAUDE_HOOKS)) {
    const hooks: any[] = settings.hooks[event] || [];
    const filtered = hooks.filter(
      (h: any) => !JSON.stringify(h).includes("agents report --agent claude")
    );
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
        return { agent: "copilot", action: "already-installed" };
      }
    } catch {}
    // File exists but isn't our symlink — check content
    try {
      const content = readFileSync(target, "utf-8");
      if (content.includes("agents report")) {
        return { agent: "copilot", action: "already-installed" };
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

  return { agent: "copilot", action: "installed", detail: "symlinked extension to ~/.copilot/extensions/agents-reporting/" };
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
        return { agent: "pi", action: "already-installed" };
      }
    } catch {}
    try {
      const content = readFileSync(target, "utf-8");
      if (content.includes("agents report")) {
        return { agent: "pi", action: "already-installed" };
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

  return { agent: "pi", action: "installed", detail: "symlinked extension to ~/.pi/agent/extensions/" };
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

// ── Public API ──────────────────────────────────────────────────────

export function setup(): SetupResult[] {
  // Verify agents CLI is available
  try {
    execSync("which agents", { encoding: "utf-8", timeout: 3000 });
  } catch {
    console.error("Warning: 'agents' command not found on PATH. Hooks will fail until it is installed.");
  }

  return [setupClaude(), setupCopilot(), setupPi()];
}

export function uninstall(): SetupResult[] {
  return [uninstallClaude(), uninstallCopilot(), uninstallPi()];
}
