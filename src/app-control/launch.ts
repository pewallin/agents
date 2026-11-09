// @ts-nocheck
// The command line an agent is started with.

import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentsCLI } from "./agent-state.js";
import { fail } from "./output.js";
import { readJSON } from "./program.js";

export function splitShellWords(input) {
  const words = [];
  let current = "";
  let quote = null;
  let hadContent = false;

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
        hadContent = true;
      }
      continue;
    }
    if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
      } else if (ch === "\\" && index + 1 < input.length) {
        index += 1;
        current += input[index];
        hadContent = true;
      } else {
        current += ch;
        hadContent = true;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (hadContent) {
        words.push(current);
        current = "";
        hadContent = false;
      }
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      hadContent = true;
      continue;
    }
    if (ch === "\\" && index + 1 < input.length) {
      index += 1;
      current += input[index];
      hadContent = true;
      continue;
    }
    current += ch;
    hadContent = true;
  }

  if (quote) {
    throw new Error("launch command contains an unterminated quote");
  }
  if (hadContent) words.push(current);
  return words;
}

export function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,%+@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(argv) {
  return argv.map(shellQuote).join(" ");
}

export function hasOption(argv, shortName, longName) {
  return argv.some(arg => arg === shortName || arg === longName || arg.startsWith(`${longName}=`));
}

export function preserveCodexResumeOption(args, index, output) {
  const token = args[index];
  const valueOptions = new Set([
    "-c", "--config",
    "-m", "--model",
    "-p", "--profile",
    "-s", "--sandbox",
    "-a", "--ask-for-approval",
    "-C", "--cd",
    "--add-dir",
    "--remote",
    "--remote-auth-token-env",
    "--enable",
    "--disable",
  ]);
  if (valueOptions.has(token)) {
    if (index + 1 < args.length) {
      output.push(token, args[index + 1]);
      return index + 2;
    }
    output.push(token);
    return index + 1;
  }
  if (/^--(config|model|profile|sandbox|ask-for-approval|cd|add-dir|remote|remote-auth-token-env|enable|disable)=/.test(token)) {
    output.push(token);
  } else if (token.startsWith("-") && token !== "--last") {
    output.push(token);
  }
  return index + 1;
}

export function normalizeAgentName(agent) {
  const normalized = path.basename(agent || "").toLowerCase();
  if (normalized === "kiro-cli" || normalized === "kiro-cli-chat") return "kiro";
  return normalized;
}

export function findAgentArgvIndex(argv) {
  const known = new Set(["codex", "claude", "copilot", "pi", "opencode", "kiro", "kiro-cli", "kiro-cli-chat", "hermes"]);
  return argv.findIndex(arg => known.has(path.basename(arg)));
}

export function agentNameFromLaunchCommand(launchCommand) {
  const argv = splitShellWords(launchCommand);
  const agentIndex = findAgentArgvIndex(argv);
  if (agentIndex < 0) {
    throw new Error("could not identify the agent executable in @agents_command_launch");
  }
  return normalizeAgentName(argv[agentIndex]);
}

export function stripFlagAndValue(argv, flags) {
  const output = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (flags.has(token)) {
      index += 1;
      continue;
    }
    if ([...flags].some(flag => token.startsWith(`${flag}=`))) {
      continue;
    }
    output.push(token);
  }
  return output;
}

// A new agent starts a new session: the options that continue one go, with their values.
export function stripSessionOptions(argv, { flags = [], withValue = [], optionalValue = [] }) {
  const output = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const name = token.split("=")[0];
    if (flags.includes(token)) continue;
    if (withValue.includes(name) || optionalValue.includes(name)) {
      const next = argv[index + 1];
      if (!token.includes("=") && next !== undefined && (withValue.includes(name) || !next.startsWith("-"))) index += 1;
      continue;
    }
    output.push(token);
  }
  return output;
}

export function promptArgsForAgent(agentName, prompt) {
  switch (normalizeAgentName(agentName)) {
  case "copilot":
    return ["-i", prompt];
  case "opencode":
    return ["--prompt", prompt];
  case "claude":
  case "codex":
  case "kiro":
  case "pi":
  case "hermes":
  default:
    return [prompt];
  }
}

export function buildNewAgentArgv(launchCommand, prompt, metadata) {
  const originalArgv = splitShellWords(launchCommand);
  const agentIndex = findAgentArgvIndex(originalArgv);
  if (agentIndex < 0) {
    throw new Error("could not identify the agent executable in @agents_command_launch");
  }

  const prefixArgv = originalArgv.slice(0, agentIndex);
  const agentArgv = originalArgv.slice(agentIndex);
  const agentName = path.basename(agentArgv[0]);
  const normalizedAgentName = normalizeAgentName(agentName);
  let nextAgentArgv;

  if (normalizedAgentName === "codex") {
    const resumeIndex = agentArgv.indexOf("resume");
    const baseArgv = resumeIndex >= 0 ? agentArgv.slice(0, resumeIndex) : agentArgv.slice();
    const preserved = [];
    if (resumeIndex >= 0) {
      const resumeArgs = agentArgv.slice(resumeIndex + 1);
      for (let index = 0; index < resumeArgs.length;) {
        const token = resumeArgs[index];
        if (!token.startsWith("-")) {
          index += 1;
          continue;
        }
        index = preserveCodexResumeOption(resumeArgs, index, preserved);
      }
    }
    nextAgentArgv = withOwnCodexAppServer([...baseArgv, ...preserved]);
    if (metadata.model && !hasOption(nextAgentArgv, "-m", "--model")) {
      nextAgentArgv.push("-m", metadata.model);
    }
  } else if (normalizedAgentName === "claude") {
    nextAgentArgv = stripSessionOptions(agentArgv, { flags: ["--continue", "-c"], optionalValue: ["--resume", "-r"] });
  } else if (normalizedAgentName === "copilot") {
    nextAgentArgv = stripFlagAndValue(
      agentArgv.filter(arg => arg !== "--continue" && !arg.startsWith("--resume=")),
      new Set(["--resume"])
    );
  } else if (normalizedAgentName === "pi") {
    // Pi's --resume picks a session in a menu, and takes no value.
    nextAgentArgv = stripSessionOptions(agentArgv, { flags: ["--continue", "-c", "--resume", "-r"], withValue: ["--session"] });
  } else if (normalizedAgentName === "opencode") {
    nextAgentArgv = stripSessionOptions(agentArgv, { flags: ["--continue", "-c", "--fork"], withValue: ["--session", "-s"] });
  } else if (normalizedAgentName === "kiro") {
    nextAgentArgv = stripFlagAndValue(
      agentArgv.filter(arg => arg !== "--resume" && !arg.startsWith("--resume-id=")),
      new Set(["--resume-id"])
    );
  } else {
    nextAgentArgv = agentArgv.slice();
  }
  // Codex takes the source pane's model above; the others take only one asked for.
  if (metadata.explicitModel && normalizedAgentName !== "codex" && !hasOption(nextAgentArgv, "-m", "--model")) {
    nextAgentArgv.push("--model", metadata.explicitModel);
  }

  return {
    agent: normalizedAgentName,
    argv: [...prefixArgv, ...nextAgentArgv, ...promptArgsForAgent(normalizedAgentName, prompt)],
  };
}

// Codex's TUI otherwise runs on the shared app-server daemon that the first Codex started, which
// runs every Codex's hooks with that first Codex's environment: a worker's status and replies then
// land on that Codex's pane. So a new Codex gets its own app-server, never another pane's --remote.
export function withOwnCodexAppServer(agentArgv) {
  const argv = stripFlagAndValue(
    agentArgv.filter(arg => arg !== "--no-daemon"),
    new Set(["--remote", "--remote-auth-token-env"])
  );
  return codexSupportsNoDaemon(argv[0]) ? [argv[0], "--no-daemon", ...argv.slice(1)] : argv;
}

// A Codex from before the shared daemon has no --no-daemon and would refuse it.
export const noDaemonSupport = new Map();
export function codexSupportsNoDaemon(executable) {
  if (!noDaemonSupport.has(executable)) {
    const help = spawnSync(executable, ["--help"], { encoding: "utf8", timeout: 5000 });
    noDaemonSupport.set(executable, help.status === 0 && /--no-daemon\b/.test(help.stdout || ""));
  }
  return noDaemonSupport.get(executable);
}

// The agent profiles the app's menu offers: config.json of the app's suite, plus the built-in
// agents it offers without one.
export function agentProfiles() {
  const suite = process.env.AGENTS_PRODUCT_DIRNAME || "agents-app";
  const file = process.env.AGENTS_APP_CONFIG_PATH || path.join(os.homedir(), ".agents", suite, "config.json");
  const configured = readJSON(file, {}).profiles || {};
  const profiles = { claude: { command: "claude" }, codex: { command: "codex" }, pi: { command: "pi" } };
  for (const [id, record] of Object.entries(configured)) {
    if (record && typeof record.command === "string" && record.command.trim()) profiles[id.toLowerCase()] = record;
  }
  return profiles;
}

export function agentProfile(id) {
  const profiles = agentProfiles();
  const record = profiles[String(id).toLowerCase()];
  if (!record) {
    fail(2, "profileUnavailable", `No agent profile '${id}'. Profiles: ${Object.keys(profiles).sort().join(", ")}.`);
  }
  return { id: String(id).toLowerCase(), command: record.command.trim() };
}

export function renderLaunchCommand(launch, cwd) {
  const command = `exec ${launch.shell}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}

// A Codex runs through `agents codex-session`, as the app runs the Codex panes it starts: the
// pane gets its own app-server, which its ACP view shares live. Without one, the worker's pane has
// no ACP view.
//
// codex-session alone picks how the TUI runs: with --remote on the pane's app-server, or with
// --no-daemon on its own when that server does not start. It gets the command without
// --no-daemon, which Codex refuses beside --remote: a worker started with both exited as it
// started (2026-10-28). Started directly, the Codex keeps --no-daemon.
export function agentLaunch(argv) {
  // Every other agent with an ACP view runs under `agents acp-session --tui`, as the app runs the
  // agents it starts: it hands its session to the pane's ACP view and back. Without it the
  // worker's pane has no ACP view. Which agents have one is the agents CLI's to say.
  const view = acpViewAgentOf(argv[0]);
  if (!view) return { argv, shell: shellCommand(argv) };
  if (!view.live) {
    return {
      argv,
      via: "acp-session",
      shell: shellCommand([agentsCLI(), "acp-session", "--agent", view.registryId, "--tui", shellCommand(argv)]),
    };
  }
  const agentArgv = argv.filter(arg => arg !== "--no-daemon");
  return {
    argv: agentArgv,
    via: "codex-session",
    shell: shellCommand([agentsCLI(), "codex-session", "--command", shellCommand(agentArgv)]),
  };
}

// The agents with an ACP view and how each gets it, as the agents CLI lists them (`agents
// acp-agents`): { agent, executable, registryId, live }. None when the CLI cannot say.
export let acpViewAgentsCache;
export function acpViewAgents() {
  if (acpViewAgentsCache !== undefined) return acpViewAgentsCache;
  acpViewAgentsCache = [];
  const result = spawnSync(agentsCLI(), ["acp-agents"], { encoding: "utf8", timeout: 5000 });
  if (result.status === 0) {
    try {
      const agents = JSON.parse(result.stdout || "{}").agents;
      if (Array.isArray(agents)) acpViewAgentsCache = agents;
    } catch {}
  }
  return acpViewAgentsCache;
}

export function acpViewAgentOf(executable) {
  const name = path.basename(String(executable || "")).toLowerCase();
  return acpViewAgents().find(entry => entry.executable === name || entry.agent === name);
}

export function controlHasArgument(descriptors, controlID, argumentName) {
  const descriptor = descriptors.find(control => control.id === controlID);
  return descriptor?.arguments?.some(argument => argument.name === argumentName) === true;
}

export function assertOK(response, action) {
  if (response.ok === false) {
    const error = response.error || {};
    fail(1, error.code || "appControlFailed", `${action} failed: ${error.message || "unknown error"}`);
  }
  return response.result;
}
