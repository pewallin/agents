// @ts-nocheck
// Parsing a command line into the command to run.

import os from "node:os";
import path from "node:path";
import { MESSAGE_ID_PATTERN } from "./delivery.js";
import { fail, usage } from "./output.js";

// Flags that never take a value, wherever they stand: `--approved "<brief>"` keeps its brief.
export const VALUELESS_OPTIONS = new Set(["approved"]);

export function parseOptions(tokens, booleanOptions = new Set(), repeatableOptions = new Set()) {
  const positional = [];
  const params = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--json") {
      continue;
    }
    if (token === "--help" || token === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const name = token.slice(2);
    if (!name) {
      fail(64, "usage", usage());
    }
    const next = tokens[index + 1];
    if (booleanOptions.has(name) && (next === undefined || next.startsWith("--") || VALUELESS_OPTIONS.has(name))) {
      params[name] = true;
      continue;
    }
    if (next === undefined || next.startsWith("--")) {
      fail(64, "usage", `Missing value for --${name}.`);
    }
    params[name] = repeatableOptions.has(name) ? [...(params[name] || []), next] : next;
    index += 1;
  }
  return { positional, params };
}

export function rejectExtraArguments(commandName, tokens) {
  const { positional, params } = parseOptions(tokens);
  if (positional.length > 0 || Object.keys(params).length > 0) {
    fail(64, "usage", `${commandName} does not accept additional arguments.`);
  }
}

export function parseCommand(argv) {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(command ? 0 : 64);
  }

  if (command === "identify") {
    rejectExtraArguments("identify", [subcommand, ...rest].filter(Boolean));
    return { kind: "socket", method: "app.identify", params: {} };
  }
  if (command === "capabilities") {
    rejectExtraArguments("capabilities", [subcommand, ...rest].filter(Boolean));
    return { kind: "socket", method: "app.capabilities", params: {} };
  }
  if (command === "context") {
    rejectExtraArguments("context", [subcommand, ...rest].filter(Boolean));
    return { kind: "socket", method: "app.context", params: {} };
  }

  if (command === "controls" && subcommand === "list") {
    const { positional, params } = parseOptions(rest);
    if (positional.length > 0) {
      fail(64, "usage", "controls list does not accept positional arguments.");
    }
    return { kind: "socket", method: "control.list", params };
  }

  if (command === "controls" && subcommand === "invoke") {
    // A flag on its own, as `surface send-text --submit` takes it.
    const { positional, params } = parseOptions(rest, new Set(["submit"]));
    const controlID = positional[0];
    if (!controlID) {
      fail(64, "usage", "controls invoke requires a control id.");
    }
    if (positional.length > 1) {
      fail(64, "usage", "controls invoke accepts exactly one control id.");
    }
    // Control arguments are strings.
    if (params.submit === true) params.submit = "true";
    return { kind: "socket", method: "control.invoke", params: { ...params, id: controlID } };
  }

  if (command === "surface" && subcommand === "send-text") {
    const { positional, params } = parseOptions(rest, new Set(["submit"]));
    const text = positional[0];
    if (text === undefined) {
      fail(64, "usage", "surface send-text requires text.");
    }
    if (positional.length > 1) {
      fail(64, "usage", "surface send-text accepts exactly one text argument.");
    }
    return { kind: "socket", method: "surface.send_text", params: { ...params, text } };
  }

  if (command === "surface" && subcommand === "send-key") {
    const { positional, params } = parseOptions(rest);
    const key = positional[0];
    if (!key) {
      fail(64, "usage", "surface send-key requires a key.");
    }
    if (positional.length > 1) {
      fail(64, "usage", "surface send-key accepts exactly one key.");
    }
    return { kind: "socket", method: "surface.send_key", params: { ...params, key } };
  }

  if (command === "surface" && subcommand === "read-text") {
    const { positional, params } = parseOptions(rest);
    if (positional.length > 0) {
      fail(64, "usage", "surface read-text does not accept positional arguments.");
    }
    return { kind: "socket", method: "surface.read_text", params };
  }

  if (command === "panel" && subcommand === "show") {
    const { positional, params } = parseOptions(rest, new Set(["activate"]));
    if (positional.length !== 1 || !["palette", "switcher", "open"].includes(positional[0])) {
      fail(64, "usage", "panel show takes palette, switcher or open (quick open), and optionally --query <text> and --activate.");
    }
    return {
      kind: "socket",
      method: "panel.show",
      params: { name: positional[0], query: params.query || "", activate: params.activate === true },
    };
  }

  if (command === "settings" && subcommand === "get") {
    const { positional, params } = parseOptions(rest);
    if (positional.length > 1 || Object.keys(params).length > 0) {
      fail(64, "usage", "settings get takes at most one setting key.");
    }
    return { kind: "socket", method: "settings.get", params: positional.length ? { key: positional[0] } : {} };
  }

  if (command === "settings" && subcommand === "set") {
    const { positional, params } = parseOptions(rest);
    if (positional.length !== 2 || Object.keys(params).length > 0) {
      fail(64, "usage", "settings set takes a setting key and a value, e.g. settings set terminal.theme light.");
    }
    // The app reads the value in the setting's own type ("true", "14", "light").
    return { kind: "socket", method: "settings.set", params: { key: positional[0], value: positional[1] } };
  }

  if (command === "window" && subcommand === "snapshot") {
    const { positional, params } = parseOptions(rest);
    if (positional.length > 0) {
      fail(64, "usage", "window snapshot does not accept positional arguments.");
    }
    // The app writes the file, so it needs a path that does not depend on this process's cwd.
    const snapshotPath = params.path
      ? path.resolve(params.path)
      : path.join(os.tmpdir(), `agents-next-window-${Date.now()}.png`);
    return { kind: "socket", method: "window.snapshot", params: { ...params, path: snapshotPath } };
  }

  if (command === "window" && subcommand === "resize") {
    const { positional, params } = parseOptions(rest);
    const width = Number(params.width);
    const height = Number(params.height);
    if (positional.length > 0 || !Number.isFinite(width) || !Number.isFinite(height)) {
      fail(64, "usage", "window resize requires --width and --height in points.");
    }
    return { kind: "socket", method: "window.resize", params: { width, height } };
  }

  if (command === "workspace" && subcommand === "tab") {
    const { positional, params } = parseOptions(rest, new Set(["dry-run"]));
    if (positional.length > 0) {
      fail(64, "usage", "workspace tab does not accept positional arguments.");
    }
    return { kind: "workspace-placement", placement: "tab", params };
  }

  if (command === "workspace" && subcommand === "split") {
    const { positional, params } = parseOptions(rest, new Set(["dry-run"]));
    if (positional.length > 0) {
      fail(64, "usage", "workspace split does not accept positional arguments.");
    }
    return { kind: "workspace-placement", placement: "split", params };
  }

  if (command === "agent" && subcommand === "spawn") {
    const { positional, params } = parseOptions(rest, new Set(["dry-run", "no-parent", "approved"]));
    if (positional.length === 0) {
      fail(64, "usage", "agent spawn requires a prompt.");
    }
    return { kind: "agent-spawn", prompt: positional.join(" "), params };
  }

  if (command === "agent" && subcommand === "respawn") {
    const { positional, params } = parseOptions(rest, new Set(["dry-run", "replace"]));
    if (positional.length !== 1) {
      fail(64, "usage", "agent respawn requires exactly one task name.");
    }
    return { kind: "agent-respawn", task: positional[0], params };
  }

  if (command === "agent" && subcommand === "report") {
    const { positional, params } = parseOptions(rest, new Set(["done", "blocked"]), new Set(["output"]));
    return { kind: "agent-report", text: positional.join(" "), params };
  }

  if (command === "agent" && subcommand === "ask") {
    const { positional, params } = parseOptions(rest);
    if (positional.length === 0) fail(64, "usage", "agent ask requires the question.");
    if (params.to !== undefined && params.to !== "parent") {
      fail(64, "usage", "agent ask --to takes parent: a worker asks its coordinator.");
    }
    return { kind: "agent-ask", text: positional.join(" "), params };
  }

  if (command === "agent" && subcommand === "status") {
    const { positional, params } = parseOptions(rest, new Set(["all"]));
    if (positional.length > 0) {
      fail(64, "usage", "agent status does not accept positional arguments.");
    }
    return { kind: "agent-status", params };
  }

  if (command === "agent" && subcommand === "wait") {
    const { positional, params } = parseOptions(rest);
    return { kind: "agent-wait", tasks: positional, params };
  }

  if (command === "agent" && subcommand === "close") {
    const { positional, params } = parseOptions(rest, new Set(["done"]));
    if (positional.length === 0 && !params.done) {
      fail(64, "usage", "agent close requires task names or --done.");
    }
    return { kind: "agent-close", tasks: positional, params };
  }

  if (command === "agent" && subcommand === "send") {
    const { positional, params } = parseOptions(rest, new Set(["no-wake"]));
    if (params.mode !== undefined && !["queue", "steer"].includes(params.mode)) {
      fail(64, "usage", "agent send --mode is queue (the default: for when the agent waits at its prompt) or steer (into its current turn).");
    }
    if (params.id !== undefined && !MESSAGE_ID_PATTERN.test(params.id)) {
      fail(64, "usage", "agent send --id takes 1-64 letters, digits, '.', '_' or '-'.");
    }
    for (const flag of ["reply-to", "supersedes"]) {
      if (params[flag] !== undefined && !MESSAGE_ID_PATTERN.test(params[flag])) {
        fail(64, "usage", `agent send --${flag} takes a message id.`);
      }
    }
    if (params["no-wake"] && params.mode === "steer") {
      fail(64, "usage", "agent send --no-wake waits for the next line to the agent; it cannot steer.");
    }
    if (params["no-wake"] && params["reply-to"]) {
      fail(64, "usage", "An answer always wakes the agent: drop --no-wake to send it with --reply-to.");
    }
    return { kind: "agent-send", text: positional.join(" "), params };
  }

  if (command === "agent" && subcommand === "delivery") {
    const { positional, params } = parseOptions(rest, new Set(["cancel"]));
    if (positional.length !== 1 || !MESSAGE_ID_PATTERN.test(positional[0])) {
      fail(64, "usage", "agent delivery requires one message id.");
    }
    return { kind: "agent-delivery", id: positional[0], params };
  }

  if (command === "agent" && subcommand === "promote") {
    const { positional, params } = parseOptions(rest, new Set(["tell"]));
    if (positional.length > 0) {
      fail(64, "usage", "agent promote does not accept positional arguments.");
    }
    return { kind: "agent-promote", params };
  }

  if (command === "agent" && subcommand === "protocol") {
    const { positional, params } = parseOptions(rest);
    if (positional.length > 0) fail(64, "usage", "agent protocol does not accept positional arguments.");
    return { kind: "agent-protocol", params };
  }

  if (command === "agent" && subcommand === "adopt") {
    const { positional, params } = parseOptions(rest, new Set(["approved"]));
    if (positional.length < 2) {
      fail(64, "usage", "agent adopt requires a pane and what the agent is to do.");
    }
    return { kind: "agent-adopt", pane: positional[0], text: positional.slice(1).join(" "), params };
  }

  if (command === "agent" && subcommand === "remind") {
    const { positional, params } = parseOptions(rest);
    if (positional.length === 0 || (!params.in && !params.at)) {
      fail(64, "usage", "agent remind requires the text and --in <duration> or --at <time>.");
    }
    return { kind: "agent-remind", text: positional.join(" "), params };
  }

  if (command === "agent" && subcommand === "watch") {
    const { positional, params } = parseOptions(rest, new Set(["list"]));
    const modes = ["cmd", "poll", "list", "cancel"].filter(name => params[name]);
    if (modes.length !== 1) {
      fail(64, "usage", "agent watch takes one of --cmd <command>, --poll <command>, --list or --cancel <id>.");
    }
    return { kind: "agent-watch", label: positional.join(" "), params };
  }

  if (command === "mcp") {
    const { positional, params } = parseOptions([subcommand, ...rest].filter(token => token !== undefined), new Set(["install-wrapper"]));
    if (positional.length > 0) fail(64, "usage", "mcp takes only --as <name>, or --install-wrapper.");
    return { kind: params["install-wrapper"] ? "mcp-wrapper" : "mcp", params };
  }

  if (command === "agent" && subcommand === "supervise") {
    const { params } = parseOptions(rest);
    return { kind: "agent-supervise", params };
  }

  fail(64, "usage", usage());
}
