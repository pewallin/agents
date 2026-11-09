import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCodexMcpConfig, removeCodexMcpConfig } from "./mcp-setup.js";

// A fake HOME with real-shaped config files for every harness. Nothing here reads or writes the
// user's own configuration: HOME, the agents home, the setup hash and the `claude` CLI are all
// fakes under a temporary directory.
let home: string;

/** A stand-in for `claude mcp add/remove --scope user`, which edits ~/.claude.json the way Claude
 *  does: two-space JSON, the server as { type, command, args, env }. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, ".claude.json");
const args = process.argv.slice(2);
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
fs.appendFileSync(path.join(process.env.HOME, "claude-calls.log"), args.join(" ") + "\\n");
if (args[0] === "mcp" && args[1] === "add") {
  const rest = args.slice(args.indexOf("--") + 1);
  config.mcpServers = config.mcpServers || {};
  config.mcpServers[args[4]] = { type: "stdio", command: rest[0], args: rest.slice(1), env: {} };
} else if (args[0] === "mcp" && args[1] === "remove") {
  delete config.mcpServers[args[4]];
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\\n");
`;

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name !== "claude-calls.log") files[relative(root, path)] = readFileSync(path, "utf-8");
    }
  };
  walk(root);
  return files;
}

async function load() {
  vi.resetModules();
  return import("./setup.js");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agents-mcp-setup-"));
  const tools = join(home, "tools");
  mkdirSync(tools, { recursive: true });
  write(join(tools, "claude"), FAKE_CLAUDE);
  chmodSync(join(tools, "claude"), 0o755);
  const command = join(home, ".agents", "agents-app", "bin", "agents-app-control");
  write(command, "#!/bin/sh\nexit 0\n");
  chmodSync(command, 0o755);
  vi.stubEnv("HOME", home);
  vi.stubEnv("AGENTS_HOME", join(home, ".agents", "agents-app"));
  vi.stubEnv("AGENTS_SETUP_HASH_PATH", join(home, "setup-hash"));
  vi.stubEnv("AGENTS_NO_AUTO_SETUP", "1");
  vi.stubEnv("AGENTS_CLAUDE_BIN", join(tools, "claude"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("AGENTS_MCP_COMMAND", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function realShapedHome(): Promise<void> {
  write(join(home, ".claude", "settings.json"), `{
  "permissions": {
    "allow": [
      "Bash(git status)"
    ]
  },
  "hooks": {}
}
`);
  write(join(home, ".claude.json"), `{
  "numStartups": 12,
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "gh-mcp",
      "args": [],
      "env": {}
    }
  }
}
`);
  write(join(home, ".codex", "config.toml"), `model = "gpt-6.1-sol"
approval_policy = "on-request"

[projects."/Users/me/code"]
trust_level = "trusted"

[features]
hooks = true # added by agents setup

[mcp_servers.github]
command = "gh-mcp"
`);
  const { kiroReportingAgentConfig } = await load();
  write(join(home, ".kiro", "agents", "agents-reporting.json"), JSON.stringify(kiroReportingAgentConfig(), null, 2) + "\n");
  write(join(home, ".copilot", "mcp-config.json"), `{
    "mcpServers": {
        "playwright": {
            "type": "local",
            "command": "npx",
            "args": ["@playwright/mcp"],
            "tools": ["*"]
        }
    }
}
`);
  write(join(home, ".config", "opencode", "config.json"), `{
  "plugin": [
    "opencode-agents-reporting"
  ]
}
`);
  write(join(home, ".config", "opencode", "opencode.jsonc"), `{
  // the user's own file, comments and all
  "theme": "system",
}
`);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
}

describe("agents setup --mcp", () => {
  it("registers the server with every harness and takes it back out byte for byte", async () => {
    await realShapedHome();
    const before = snapshot(home);
    const { setupMcpServer, uninstallMcpServer, doctorMcpServer } = await load();
    const command = join(home, ".agents", "agents-app", "bin", "agents-app-control");

    const results = setupMcpServer();
    expect(Object.fromEntries(results.map((result) => [result.agent, result.action]))).toEqual({
      claude: "installed", codex: "installed", kiro: "installed", copilot: "installed", opencode: "installed", pi: "installed",
    });
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8")).mcpServers.agents).toEqual({ type: "stdio", command, args: ["mcp"], env: {} });
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).permissions.allow).toEqual(["Bash(git status)", "mcp__agents"]);
    const codex = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    expect(codex).toContain(`# added by agents setup\n[mcp_servers.agents]\ncommand = "${command}"\nargs = ["mcp"]\ntool_timeout_sec = 660\ndefault_tools_approval_mode = "approve"\n`);
    expect(JSON.parse(readFileSync(join(home, ".kiro", "settings", "mcp.json"), "utf-8")).mcpServers.agents.command).toBe(command);
    expect(JSON.parse(readFileSync(join(home, ".kiro", "agents", "agents-reporting.json"), "utf-8")).allowedTools).toEqual(["@agents"]);
    const copilot = readFileSync(join(home, ".copilot", "mcp-config.json"), "utf-8");
    expect(JSON.parse(copilot).mcpServers.agents).toEqual({ type: "local", command, args: ["mcp"], tools: ["*"] });
    expect(copilot).toContain('\n        "agents": {');
    expect(JSON.parse(readFileSync(join(home, ".config", "opencode", "config.json"), "utf-8")).mcp.agents).toEqual({ type: "local", command: [command, "mcp"], enabled: true, timeout: 660000 });
    expect(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf-8")).toBe(before[".config/opencode/opencode.jsonc"]);
    expect(JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp.json"), "utf-8")).mcpServers.agents).toMatchObject({ command, args: ["mcp"], exposure: "direct", timeout: 660 });
    expect(existsSync(join(home, "setup-hash")), "a hash would let auto-setup install hooks nobody agreed to").toBe(false);
    expect(doctorMcpServer().map((result) => [result.agent, result.registered, result.allowed, result.reachable])).toEqual([
      ["claude", "ours", true, true], ["codex", "ours", true, true], ["kiro", "ours", true, true],
      ["copilot", "ours", undefined, true], ["opencode", "ours", true, true], ["pi", "ours", true, true],
    ]);

    // Again: nothing changes, and Claude is not called again.
    const installed = snapshot(home);
    const calls = readFileSync(join(home, "claude-calls.log"), "utf-8");
    setupMcpServer();
    expect(snapshot(home)).toEqual(installed);
    expect(readFileSync(join(home, "claude-calls.log"), "utf-8")).toBe(calls);

    // Codex's own "Always allow" adds a table under ours; it goes with ours.
    writeFileSync(join(home, ".codex", "config.toml"), codex.replace('default_tools_approval_mode = "approve"\n', 'default_tools_approval_mode = "approve"\n\n[mcp_servers.agents.tools.report]\napproval_mode = "approve"\n'));

    const removed = uninstallMcpServer();
    expect(removed.every((result) => result.action === "uninstalled"), JSON.stringify(removed)).toBe(true);
    expect(snapshot(home)).toEqual(before);
    expect(readFileSync(join(home, "claude-calls.log"), "utf-8")).toContain("mcp remove --scope user agents");
    expect(uninstallMcpServer().every((result) => result.action === "not-installed")).toBe(true);
  });

  it("leaves a server named agents that is not ours, and a rule the user had, where they are", async () => {
    write(join(home, ".claude", "settings.json"), `{\n  "permissions": {\n    "allow": [\n      "mcp__agents"\n    ]\n  }\n}\n`);
    write(join(home, ".copilot", "mcp-config.json"), `{\n  "mcpServers": {\n    "agents": {\n      "command": "someone-elses-agents"\n    }\n  }\n}\n`);
    write(join(home, ".codex", "config.toml"), `[mcp_servers.agents]\ncommand = "theirs"\n`);
    write(join(home, ".pi", "agent", "mcp.json"), "{ not json");
    const before = snapshot(home);
    const { setupMcpServer, uninstallMcpServer } = await load();

    const results = Object.fromEntries(setupMcpServer().map((result) => [result.agent, result]));
    expect(results.copilot.action).toBe("skipped");
    expect(results.copilot.detail).toMatch(/kept the server named agents.*not ours/);
    expect(results.codex.detail).toMatch(/kept \[mcp_servers.agents\]/);
    expect(results.pi.detail).toMatch(/could not parse/);
    expect(results.kiro.action).toBe("skipped");
    expect(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf-8")).toBe(before[".copilot/mcp-config.json"]);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf-8")).toBe(before[".codex/config.toml"]);
    expect(readFileSync(join(home, ".pi", "agent", "mcp.json"), "utf-8")).toBe("{ not json");

    uninstallMcpServer();
    // The user's own allow rule stays: setup did not add it.
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).permissions.allow).toEqual(["mcp__agents"]);
    expect(readFileSync(join(home, ".copilot", "mcp-config.json"), "utf-8")).toBe(before[".copilot/mcp-config.json"]);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf-8")).toBe(before[".codex/config.toml"]);
  });

  it("creates Claude's permissions for the rule and takes them out again", async () => {
    write(join(home, ".claude", "settings.json"), `{\n  "model": "opus"\n}\n`);
    const before = snapshot(home);
    const { setupMcpServer, uninstallMcpServer } = await load();
    setupMcpServer();
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"))).toEqual({ model: "opus", permissions: { allow: ["mcp__agents"] } });
    uninstallMcpServer();
    // ~/.claude.json is Claude's own: `claude mcp add` made it.
    const { ".claude.json": _claudeOwn, ...after } = snapshot(home);
    expect(after).toEqual(before);
  });

  it("writes nothing while the app's launcher is missing", async () => {
    await realShapedHome();
    rmSync(join(home, ".agents", "agents-app", "bin"), { recursive: true });
    const before = snapshot(home);
    const { setupMcpServer } = await load();
    const results = setupMcpServer();
    expect(results.every((result) => result.action === "skipped" && /not found: Agents Next writes it/.test(result.detail ?? ""))).toBe(true);
    expect(snapshot(home)).toEqual(before);
  });
});

describe("Codex's config.toml", () => {
  const command = "/Users/me/.agents/agents-app/bin/agents-app-control";

  it("takes our table back out with the tables Codex added under it, also before other tables", () => {
    const original = `model = "x"\n\n[mcp_servers.github]\ncommand = "gh"\n`;
    const added = ensureCodexMcpConfig(original, command);
    expect(added.separator).toBe(true);
    const withApproval = `${added.text}\n[mcp_servers.agents.tools.ask]\napproval_mode = "approve"\n\n# the user's next table\n[tui]\ntheme = "dark"\n`;
    const removed = removeCodexMcpConfig(withApproval, true);
    expect(removed.text).toBe(`${original}\n# the user's next table\n[tui]\ntheme = "dark"\n`);
    expect(removeCodexMcpConfig(added.text, true).text).toBe(original);
  });

  it("brings an older table of ours up to date in place", () => {
    const old = `a = 1\n\n# added by agents setup\n[mcp_servers.agents]\ncommand = "/old/agents-app-control"\nargs = ["mcp"]\n\n[tui]\nx = 1\n`;
    const updated = ensureCodexMcpConfig(old, command);
    expect(updated.changed).toBe(true);
    expect(updated.text).toBe(`a = 1\n\n# added by agents setup\n[mcp_servers.agents]\ncommand = "${command}"\nargs = ["mcp"]\ntool_timeout_sec = 660\ndefault_tools_approval_mode = "approve"\n\n[tui]\nx = 1\n`);
    expect(ensureCodexMcpConfig(updated.text, command).changed).toBe(false);
  });
});
