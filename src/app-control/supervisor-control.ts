// @ts-nocheck
// Starting a program's supervisor, and agent statuses and reports.

import { appControlArgv, appControlVersion } from "./self.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { agentSessionFile, agentsCLI, readAgentStateForPane } from "./agent-state.js";
import { writeStatusFile, writeTaskReport } from "./briefs.js";
import { fail, usage } from "./output.js";
import { TMUX_TIMEOUT_MS, localPaneRef, setPaneOption } from "./panes.js";

import { notifyApp, readJSON, taskPaths } from "./program.js";
import { markUnresolved, recordTaskSession } from "./threads.js";
import { processIdentity } from "./watch.js";

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// This CLI's code, so a supervisor started by an older one (the app updated while its workers
// stayed open) gives way to the current code.
export function cliVersion() {
  return appControlVersion();
}

// A supervisor writes this every tick: a stale one is stuck, a missing one is older code.
export function supervisorBeatFile(program) {
  return path.join(program, ".run", "supervisor.json");
}

export const SUPERVISOR_STUCK_MS = 60000;

// The program's supervisor, when the pid in its file is one: a pid left behind by a supervisor that
// died (a restart, a logout) may by now belong to any other process.
export function runningSupervisor(program) {
  const pid = Number(readFileOr(path.join(program, ".run", "supervisor.pid"), "").trim());
  if (!pid || pid === process.pid) return undefined;
  const identity = processIdentity(pid);
  if (!identity || !identity.command.includes("agent supervise") || !identity.command.includes(program)) return undefined;
  const beat = readJSON(supervisorBeatFile(program), {});
  return beat.pid === pid ? { pid, version: beat.version, beatAt: beat.beatAt || 0 } : { pid };
}

export function ensureSupervisor(program) {
  const runDir = path.join(program, ".run");
  fs.mkdirSync(runDir, { recursive: true });
  const running = runningSupervisor(program);
  if (running) {
    const stuck = running.beatAt && Date.now() - running.beatAt > SUPERVISOR_STUCK_MS;
    if (!stuck && running.version === cliVersion()) return;
    // Older code ends at its next tick once the pid file names another supervisor; a stuck one
    // never gets there.
    if (stuck) {
      try {
        process.kill(running.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  fs.rmSync(path.join(runDir, "supervisor.pid"), { force: true });
  const log = fs.openSync(path.join(runDir, "supervisor.log"), "a");
  const [command, ...commandArgs] = appControlArgv();
  const child = spawn(
    command,
    [...commandArgs, "agent", "supervise", "--program", program],
    // The program's supervisor, not the agent whose command started it.
    { detached: true, stdio: ["ignore", log, log], env: supervisorEnvironment() }
  );
  child.unref();
}

export function supervisorEnvironment() {
  const env = { ...process.env };
  delete env.AGENTS_APP_AGENT_UUID;
  delete env.AGENTS_APP_TMUX_PANE_ID;
  return env;
}

export function readFileOr(file, fallback) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

// Per pane: the agent's state (working, idle, ...) and the beginning of its latest reply.
export function agentStatuses(paneIDs) {
  const statuses = new Map();
  if (paneIDs.length === 0) return statuses;
  // The agents CLI finds tmux through $TMUX; AGENTS_APP_TMUX_SOCKET names another server.
  const socket = process.env.AGENTS_APP_TMUX_SOCKET;
  const result = spawnSync(
    agentsCLI(),
    ["runtime", "--json", ...paneIDs.flatMap(paneID => ["--pane", paneID])],
    { encoding: "utf8", timeout: TMUX_TIMEOUT_MS, env: socket ? { ...process.env, TMUX: `${socket},0,0` } : process.env }
  );
  // The runtime binds a pane's state to the agent that runs there now. A status without a
  // stateSource is its guess for an agent that never reported (Copilot without its extension,
  // or with reports it could not verify, reads "idle" while it works): the screen decides then.
  let answered = false;
  if (result.status === 0) {
    try {
      for (const entry of JSON.parse(result.stdout)) {
        if (entry.session) {
          // The share of its context window the agent's last turn filled, where it is reported.
          const context = Number(entry.contextTokens) > 0 && Number(entry.contextMax) > 0
            ? Math.min(100, Math.round((Number(entry.contextTokens) / Number(entry.contextMax)) * 100))
            : undefined;
          statuses.set(entry.session, {
            status: entry.stateSource ? entry.status : undefined,
            responsePreview: entry.responsePreview,
            // What a permission or a question in the pane asks, where its agent or host says so.
            detail: typeof entry.detail === "string" ? entry.detail : undefined,
            contextUsed: context,
            // The agent and the session it runs now: a thread records every session (threads.ts).
            agent: typeof entry.agent === "string" ? entry.agent : undefined,
            sessionId: typeof entry.externalSessionId === "string" ? entry.externalSessionId : undefined,
          });
        }
      }
      answered = true;
    } catch {
      // Fall through to the state files.
    }
  }
  for (const paneID of paneIDs) {
    const known = statuses.get(paneID);
    if (known?.status && known.responsePreview) continue;
    // The newest state file of any agent in the pane: maybe one that ran there before. Only
    // without an answer from the runtime does its state count.
    const state = readAgentStateForPane(paneID);
    statuses.set(paneID, {
      status: answered ? known?.status : known?.status || state?.state,
      responsePreview: known?.responsePreview || state?.responsePreview,
      contextUsed: known?.contextUsed,
      detail: known?.detail,
      agent: known?.agent,
      sessionId: known?.sessionId,
    });
  }
  return statuses;
}

export function reportStateFromParams(params) {
  const chosen = ["done", "blocked"].filter(flag => params[flag]);
  if (params.ask) {
    if (!["coordinator", "user"].includes(params.ask)) {
      fail(64, "usage", "agent report --ask must be 'coordinator' or 'user'.");
    }
    chosen.push(params.ask === "coordinator" ? "ask-coordinator" : "ask-user");
  }
  if (chosen.length > 1) fail(64, "usage", "agent report takes one of --done, --blocked or --ask.");
  return chosen[0] || "progress";
}

// Writes the worker's own report: report.json and its rendering, STATUS.md and the pane options
// the app shows. `outputs` adds to the earlier ones; `details` replaces them when given.
export function writeOwnReport(record, state, line, { outputs = [], details } = {}) {
  const files = taskPaths(record.program, record.task);
  const previous = readJSON(files.reportJSON, {});
  const updatedAt = new Date().toISOString();
  // Where the worker's own transcript is, for a worker that takes the task over from it.
  const session = agentSessionFile(record.paneID, Date.now() - 6 * 60 * 60 * 1000);
  // A worker that lives shorter than a supervisor tick is still in its thread's session list.
  if (session) recordTaskSession(record.program, record.task, { agent: session.agent, session: session.sessionId, uuid: record.uuid });
  const report = {
    task: record.task,
    state,
    line,
    updatedAt,
    outputs: [...new Set([...(previous.outputs || []), ...outputs])],
    details: details === undefined ? previous.details : details,
    pane: record.paneID,
    session: session || previous.session,
    history: [...(previous.history || []), { at: updatedAt, state, line }].slice(-50),
  };
  const rendered = writeTaskReport(files, report);
  writeStatusFile(record.program);
  // A worker that reports is at work on its thread again.
  markUnresolved(record.program, record.task);
  const pane = localPaneRef(record.paneID);
  setPaneOption(pane, "@agents_report", line);
  setPaneOption(pane, "@agents_report_state", state);
  setPaneOption(pane, "@agents_report_at", String(Math.floor(Date.now() / 1000)));
  notifyApp(record.sessionName);
  return { files, previous, rendered };
}
