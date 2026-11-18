// @ts-nocheck
// Agent feedback on Agents Next's own tools, for its development: what was clumsy or failed with
// the agents CLI, its MCP tools and the skills, one JSON line per entry in a local log.
//
// A development setting, off by default (Settings › Agents › Development writes the marker file
// `enabled` beside the log). Off, the MCP server does not list report_feedback and nothing is
// recorded. On, an agent is asked for feedback only after a call of its own failed: the failure
// is kept for half an hour, its answer ends with an invitation, and a feedback entry the agent
// writes carries its recent failures. An agent is told apart by its harness process (the nearest
// agent executable above the command), which a command run in its shell and one run by its MCP
// server share, whatever the harness.

import fs from "node:fs";
import path from "node:path";
import { getSharedAgentsHome } from "../paths.js";
import { agentExecutable, processTable } from "./processes.js";

export const FEEDBACK_FAILURE_WINDOW_MS = 30 * 60 * 1000;
const MAX_ATTACHED_FAILURES = 5;
const MAX_KEPT_FAILURES = 400;
const MAX_ARGUMENT_LENGTH = 300;

export function feedbackDirectory(env = process.env) {
  return path.join(getSharedAgentsHome(env), "feedback");
}

export function feedbackLogPath(env = process.env) {
  return path.join(feedbackDirectory(env), "feedback.jsonl");
}

function failuresPath(env) {
  return path.join(feedbackDirectory(env), "failures.jsonl");
}

export function feedbackEnabled(env = process.env) {
  return fs.existsSync(path.join(feedbackDirectory(env), "enabled"));
}

export const FEEDBACK_INVITATION = "Agents Next is collecting feedback on its own tools. If this failure, or what led to it, was clumsy (an unclear message, a missing option, instructions that misled you), say so once with the report_feedback tool or `agents feedback <what happened> --command <the command or tool>`; leave it if the failure was expected.";

// The agent whose command this is: the nearest agent executable above `pid`.
export function callingAgent(table, pid = process.pid) {
  const seen = new Set();
  for (let current = table.byPid.get(table.byPid.get(pid)?.ppid); current && !seen.has(current.pid); current = table.byPid.get(current.ppid)) {
    seen.add(current.pid);
    const agent = agentExecutable(current);
    if (agent) return { agent, agentPid: current.pid };
  }
  return undefined;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

// The command line as the agent typed it, without --json, each argument cut to a readable length.
export function commandLine(argv) {
  return argv
    .filter(token => token !== "--json")
    .map(token => (token.length > MAX_ARGUMENT_LENGTH ? `${token.slice(0, MAX_ARGUMENT_LENGTH)}…` : token))
    .join(" ");
}

// Keeps a failed call of an agent for its feedback and returns the invitation to give, or nothing
// when feedback is off, no agent made the call, or the call was itself feedback or help.
export function recordFailure(error, argv, { env = process.env, table, pid = process.pid, now = Date.now() } = {}) {
  if (!feedbackEnabled(env)) return undefined;
  if (["feedback", "help", "mcp", "report_feedback (MCP tool)"].includes(argv[0]) || argv.includes("--help")) return undefined;
  const caller = callingAgent(table || processTable(), pid);
  if (!caller) return undefined;
  const file = failuresPath(env);
  appendLine(file, {
    ts: new Date(now).toISOString(),
    ...caller,
    command: commandLine(argv),
    code: error?.code,
    message: String(error?.message ?? "").slice(0, 2000),
  });
  const kept = readLines(file);
  if (kept.length > MAX_KEPT_FAILURES) {
    fs.writeFileSync(file, kept.slice(-MAX_KEPT_FAILURES / 2).map(entry => JSON.stringify(entry)).join("\n") + "\n");
  }
  return FEEDBACK_INVITATION;
}

export function recentFailures(agentPid, { env = process.env, now = Date.now() } = {}) {
  return readLines(failuresPath(env))
    .filter(entry => entry.agentPid === agentPid && now - Date.parse(entry.ts) <= FEEDBACK_FAILURE_WINDOW_MS)
    .slice(-MAX_ATTACHED_FAILURES)
    .map(({ ts, command, code, message }) => ({ ts, command, code, message }));
}

// One entry: the command or tool and what happened are required, so an entry says what to fix.
export function writeFeedback({ happened, command, suggestion }, { env = process.env, table, pid = process.pid, now = Date.now(), cwd = process.cwd() } = {}) {
  if (!feedbackEnabled(env)) {
    return { error: { code: "feedbackOff", message: "Agent feedback is off; Agents Next turns it on in Settings › Agents › Development. Nothing was written." } };
  }
  const what = String(happened ?? "").trim();
  const which = String(command ?? "").trim();
  if (!which || !what) {
    return { error: { code: "usage", message: "Name the command or tool (--command, or command for report_feedback) and what happened." } };
  }
  const caller = callingAgent(table || processTable(), pid);
  const failures = caller ? recentFailures(caller.agentPid, { env, now }) : [];
  const entry = {
    ts: new Date(now).toISOString(),
    agent: caller?.agent,
    pane: env.AGENTS_APP_TMUX_PANE_ID || env.TMUX_PANE || undefined,
    cwd,
    command: which,
    happened: what,
    ...(String(suggestion ?? "").trim() ? { suggestion: String(suggestion).trim() } : {}),
    ...(failures.length > 0 ? { failures } : {}),
  };
  const file = feedbackLogPath(env);
  appendLine(file, entry);
  return { result: { path: file, attachedFailures: failures.length } };
}
