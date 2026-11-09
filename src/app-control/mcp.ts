// @ts-nocheck
// The agents MCP server: the coordination commands as MCP tools.

import { appControlArgv } from "./self.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { agentStateDirectory } from "./agent-state.js";
import { ASK_TIMEOUT_STATUS } from "./ask.js";
import { usage } from "./output.js";
import { localPaneRef, runTMux, runsUnderDetachedCodex } from "./panes.js";
import { processTable } from "./processes.js";
import { readJSON } from "./program.js";
import { cliVersion } from "./supervisor-control.js";
import { processIdentity } from "./watch.js";

// The MCP server: the coordination commands of an agent as tools, for harnesses whose shell
// cannot run them (Codex's sandbox denies tmux and ~/.agents) and agents that prefer tools. Each
// call runs this same CLI, as the agent the server belongs to, and answers with its JSON line.
//
// The server is a child of its harness, so its process tree names the agent's pane, as it does
// for the CLI, with one exception: a Codex TUI on the shared app-server daemon (`codex app-server
// --managed-daemon`) gets its MCP servers from that daemon, which is a child of the Codex that
// started it, in another pane. There the tree names the wrong agent. The thread id Codex sends
// with every call (`_meta.threadId`) is then looked up in the agents hooks' state files, which
// keep each pane's Codex session; without a match the call is refused, and `as` names the agent.
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export function isSharedCodexDaemon(entry) {
  return /(^|[\s/])codex\s+app-server\b/.test(entry.args) && /\s--managed-daemon\b/.test(entry.args);
}

// A Codex TUI that uses the shared daemon: no --no-daemon or --remote, and no subcommand that runs
// without a TUI (as pewallin/agents's codex-shared-app-server.ts tells them).
export const CODEX_NON_TUI = new Set(["app-server", "exec", "e", "review", "mcp", "mcp-server", "exec-server", "login", "logout", "apply", "a", "cloud", "sandbox", "debug", "features", "completion", "doctor", "update"]);

export function isSharedCodexClient(entry) {
  const tokens = String(entry.args || "").trim().split(/\s+/);
  let rest;
  if (path.basename(tokens[0] || "") === "codex") rest = tokens.slice(1);
  else if (["node", "bun", "env"].includes(path.basename(tokens[0] || "")) && path.basename(tokens[1] || "") === "codex") rest = tokens.slice(2);
  if (!rest) return false;
  if (rest[0] && CODEX_NON_TUI.has(rest[0])) return false;
  return !rest.some(token => token === "--no-daemon" || token === "--remote" || token.startsWith("--remote="));
}

// Which pane an MCP server serves: { paneID, via }, { refused } or {} (the tree names no pane;
// the CLI's own fallbacks decide). `panes` maps a pane's process id to its pane; `threadPane`
// looks up a Codex thread id.
export function identifyMCPCaller({ table, pid, panes, threadId, threadPane }) {
  const chain = [];
  let paneID;
  const seen = new Set();
  for (let current = table.byPid.get(pid); current && !seen.has(current.pid); current = table.byPid.get(current.ppid)) {
    if (panes.has(current.pid)) {
      paneID = panes.get(current.pid);
      break;
    }
    seen.add(current.pid);
    chain.push(current);
  }
  const shared = chain.some(isSharedCodexDaemon);
  if (shared || (!paneID && runsUnderDetachedCodex(chain))) {
    const found = threadId ? threadPane(threadId) : undefined;
    if (found) return { paneID: found, via: "codex thread" };
    return {
      refused: `This MCP server runs under Codex's shared app-server daemon, which serves the Codex of every pane that uses it${paneID ? ` (its process tree leads to pane ${paneID}, the Codex that started the daemon)` : ""}, and ${threadId ? `no pane is known to run Codex thread ${threadId}` : "Codex sent no thread id"}. Nothing was done. Pass "as" with your task name (or coordinator-<id>), or start Codex with --no-daemon.`,
    };
  }
  return paneID ? { paneID, via: "process tree" } : {};
}

// The live pane whose Codex runs the thread, by the agents hooks' state files (codex-<pane>.json
// keeps the session id, which is the thread id): one pane only, which runs a Codex on the
// shared daemon now, and whose record is no older than that Codex.
export function codexPaneOfThread(threadId, panes, table) {
  const stateDir = agentStateDirectory();
  let names = [];
  try {
    names = fs.readdirSync(stateDir).filter(name => /^codex-%\d+\.json$/.test(name));
  } catch {
    return undefined;
  }
  const byPane = new Map([...panes].map(([pid, paneID]) => [paneID, pid]));
  const matches = [];
  for (const name of names) {
    const state = readJSON(path.join(stateDir, name), undefined);
    if (state?.externalSessionId !== threadId) continue;
    const paneID = name.slice("codex-".length, -".json".length);
    const panePid = byPane.get(paneID);
    if (!panePid) continue;
    const clients = [];
    const walk = (pid, depth) => {
      const entry = table.byPid.get(pid);
      if (entry && isSharedCodexClient(entry)) clients.push(entry);
      if (depth < 6) for (const child of table.children.get(pid) || []) walk(child, depth + 1);
    };
    walk(panePid, 0);
    const started = clients.map(client => Date.parse(processIdentity(client.pid)?.lstart || "") || 0);
    const recordedAt = (Number(state.ts) || 0) * 1000;
    if (clients.length > 0 && started.some(at => at <= recordedAt + 1000)) matches.push(paneID);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function mcpPanes() {
  const output = runTMux(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]);
  if (!output) return new Map();
  return new Map(output.split(/\r?\n/).map(line => line.split("\t")).filter(([paneID]) => paneID).map(([paneID, pid]) => [Number(pid), paneID]));
}

export const MCP_AS = { type: "string", description: "Only when a call is refused for not knowing who you are: your task name, or coordinator-<id> as your instructions name it." };

export const MCP_TOOLS = [
  {
    name: "report",
    description: "Report your status as a worker to your coordinator: one short line that stands on its own. done, blocked and a question for the user change your row in the app; done and blocked wake your coordinator. Progress (no state) wakes nobody.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "One short line, e.g. \"Fixed the token refresh; MR !123 is open\"." },
        state: { type: "string", enum: ["progress", "done", "blocked", "ask-user"], description: "progress (the default), done, blocked, or ask-user for a question to the person you work for." },
        outputs: { type: "array", items: { type: "string" }, description: "URLs or files you produced." },
        details: { type: "string", description: "A longer write-up that goes into your report." },
        as: MCP_AS,
      },
      required: ["status"],
    },
  },
  {
    name: "ask",
    description: "Ask your coordinator a question and wait for its answer, so you go on in the same turn. When no answer comes in time (answered: false), the question stays open and the answer arrives in your prompt later as a line that starts with ⟢ agents.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        timeout_seconds: { type: "number", description: "How long to wait, 1-600 seconds; 50 by default." },
        as: MCP_AS,
      },
      required: ["question"],
    },
  },
  {
    name: "send",
    description: "Send a message to another agent: to your coordinator (to: \"parent\") or, as a coordinator, to a worker by its task name. It waits for the agent's prompt unless mode is steer. reply_to answers a worker's question (a worker with one open question for you is answered by itself); no_wake is information that rides along with the next message instead of waking the agent; supersedes replaces your earlier message.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        to: { type: "string", description: "parent, a task name, a pane (%12) or an agent uuid." },
        mode: { type: "string", enum: ["queue", "steer"], description: "queue (the default) or steer, into the agent's current turn." },
        reply_to: { type: "string", description: "The id of the question this answers." },
        no_wake: { type: "boolean" },
        supersedes: { type: "string", description: "The id of your earlier message this replaces." },
        id: { type: "string", description: "A message id of your own, which makes the send safe to repeat." },
        as: MCP_AS,
      },
      required: ["text", "to"],
    },
  },
  {
    name: "status",
    description: "List your workers (all: every task of the program) with their status, report line, latest question and queued messages.",
    inputSchema: { type: "object", properties: { all: { type: "boolean" }, as: MCP_AS } },
  },
  {
    name: "delivery",
    description: "Where a message stands, by the messageId a send returned; cancel takes it back while it has not reached the agent.",
    inputSchema: { type: "object", properties: { message_id: { type: "string" }, cancel: { type: "boolean" }, as: MCP_AS }, required: ["message_id"] },
  },
];

// The CLI arguments of a tool call, or a usage error.
export function mcpArguments(name, input) {
  const args = input || {};
  const text = value => (value === undefined || value === null ? undefined : String(value));
  switch (name) {
  case "report": {
    const argv = ["agent", "report", text(args.status) || ""];
    const state = args.state || "progress";
    if (state === "done") argv.push("--done");
    else if (state === "blocked") argv.push("--blocked");
    else if (state === "ask-user") argv.push("--ask", "user");
    else if (state !== "progress") return { error: "state is progress, done, blocked or ask-user; ask your coordinator with the ask tool." };
    for (const output of [].concat(args.outputs || [])) argv.push("--output", String(output));
    if (args.details !== undefined) argv.push("--details", String(args.details));
    return { argv };
  }
  case "ask": {
    const argv = ["agent", "ask", text(args.question) || "", "--to", "parent"];
    if (args.timeout_seconds !== undefined) {
      const seconds = Math.round(Number(args.timeout_seconds));
      if (!(seconds >= 1 && seconds <= 600)) return { error: "timeout_seconds is 1-600." };
      argv.push("--timeout", String(seconds));
    }
    return { argv };
  }
  case "send": {
    const argv = ["agent", "send", text(args.text) || "", "--to", text(args.to) || "parent"];
    for (const [key, flag] of [["mode", "--mode"], ["reply_to", "--reply-to"], ["supersedes", "--supersedes"], ["id", "--id"]]) {
      if (args[key] !== undefined) argv.push(flag, String(args[key]));
    }
    if (args.no_wake) argv.push("--no-wake");
    return { argv };
  }
  case "status":
    return { argv: ["agent", "status", ...(args.all ? ["--all"] : [])] };
  case "delivery":
    return { argv: ["agent", "delivery", text(args.message_id) || "", ...(args.cancel ? ["--cancel"] : [])] };
  default:
    return { error: `Unknown tool ${name}.` };
  }
}

export function runCLIChild(argv, env) {
  return new Promise(resolve => {
    const [command, ...commandArgs] = appControlArgv();
    const child = spawn(command, [...commandArgs, ...argv, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

export async function mcpToolCall(params, serverAs) {
  const name = params?.name;
  const input = params?.arguments || {};
  const { argv, error } = mcpArguments(name, input);
  const answer = (payload, isError) => ({ content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) });
  if (error) return answer({ ok: false, error: { code: "usage", message: error } }, true);
  const as = input.as || serverAs;
  const identity = [];
  if (as) {
    identity.push("--as", String(as));
  } else {
    const panes = mcpPanes();
    const table = processTable();
    const threadId = params?._meta?.threadId || params?._meta?.["x-codex-turn-metadata"]?.thread_id;
    const caller = identifyMCPCaller({ table, pid: process.pid, panes, threadId, threadPane: id => codexPaneOfThread(id, panes, table) });
    if (caller.refused) return answer({ ok: false, error: { code: "identityUnavailable", message: caller.refused } }, true);
    if (caller.paneID) identity.push("--pane", localPaneRef(caller.paneID));
  }
  // The pane named above, never one an inherited environment names: the shared daemon's is
  // another agent's.
  const env = { ...process.env };
  if (identity.length > 0) {
    delete env.AGENTS_APP_TMUX_PANE_ID;
    delete env.AGENTS_APP_AGENT_UUID;
  }
  const result = await runCLIChild([...argv, ...identity], env);
  const line = result.stdout.trim().split("\n").pop() || "";
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return answer({ ok: false, error: { code: "failed", message: (result.stderr || line || `agents-app-control exited with ${result.status}`).trim() } }, true);
  }
  // An ask whose answer did not come in time is no failure: the answer comes in the prompt.
  if (name === "ask" && result.status === ASK_TIMEOUT_STATUS) return answer({ ...parsed, ok: true, answered: false }, false);
  return answer(parsed, parsed.ok === false);
}

export async function runMCPServer(command) {
  const serverAs = command.params.as;
  const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  const handle = async message => {
    if (message.id === undefined || message.id === null) return; // A notification.
    switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "agents", version: cliVersion().slice(0, 12) || "dev" },
          instructions: "Agents Next coordination: report your status, ask your coordinator, send messages to other agents, and see your workers. The same commands as `agents-app-control agent ...`.",
        },
      });
    case "ping":
      return send({ jsonrpc: "2.0", id: message.id, result: {} });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: message.id, result: { tools: MCP_TOOLS } });
    case "tools/call":
      try {
        return send({ jsonrpc: "2.0", id: message.id, result: await mcpToolCall(message.params, serverAs) });
      } catch (error) {
        return send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "failed", message: error.message } }) }], isError: true } });
      }
    default:
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  };
  let buffer = "";
  const pending = new Set();
  await new Promise(resolve => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          continue;
        }
        const work = handle(message).finally(() => pending.delete(work));
        pending.add(work);
      }
    });
    process.stdin.on("end", resolve);
  });
  await Promise.all(pending);
  process.exit(0);
}
