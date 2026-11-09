// @ts-nocheck
// Agent hook state and session transcripts of a pane, and the agents CLI.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { paneIDFromRef } from "./panes.js";

// Where the agents CLI keeps each pane's state, as it resolves it (src/paths.ts in pewallin/agents).
export function agentStateDirectory() {
  if (process.env.AGENTS_STATE_DIR) return process.env.AGENTS_STATE_DIR;
  if (process.env.AGENTS_HOME) return path.join(process.env.AGENTS_HOME, "state");
  const shared = process.env.AGENTS_SHARED_HOME || path.join(os.homedir(), ".agents");
  return path.join(shared, process.env.AGENTS_PRODUCT_DIRNAME || "agents-app", "state");
}

export function readAgentStateForPane(pane) {
  const paneID = paneIDFromRef(pane);
  if (!paneID) return undefined;
  const stateDir = agentStateDirectory();
  let entries;
  try {
    entries = fs.readdirSync(stateDir)
      .filter(name => name.endsWith(`-${paneID}.json`))
      .map(name => {
        const file = path.join(stateDir, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    try {
      return JSON.parse(fs.readFileSync(entry.file, "utf8"));
    } catch {
      continue;
    }
  }
  return undefined;
}

// The transcript an agent's harness keeps of its session, by the session id the agents hooks
// recorded for its pane: Claude Code's projects/<dir>/<id>.jsonl, Codex's rollout-…-<id>.jsonl,
// Pi's sessions/<dir>/<time>_<id>.jsonl, Kiro 3's sessions/<dir>/<id>/messages.jsonl (Kiro 2's
// sessions/cli/<id>.jsonl), as `agents session-file` finds it. { agent, sessionId, file }, or nothing where the hooks name no session
// or the file is not there. `since`: a file last written before then belongs to an earlier agent
// of that pane number.
export function agentSessionFile(paneID, since = 0) {
  const state = readAgentStateForPane(paneID);
  const id = String(state?.externalSessionId || "");
  if (!/^[A-Za-z0-9._-]{4,128}$/.test(id)) return undefined;
  const agent = String(state.agent || "");
  const file = findSessionFile(agent, id);
  if (!file) return undefined;
  try {
    if (fs.statSync(file).mtimeMs < since) return undefined;
  } catch {
    return undefined;
  }
  return { agent, sessionId: id, file };
}

// The agents CLI knows where each harness keeps its transcripts (`agents session-file`).
export function findSessionFile(agent, id) {
  const result = spawnSync(agentsCLI(), ["session-file", "--agent", agent, "--session", id, "--json"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return undefined;
  try {
    const file = JSON.parse(result.stdout || "{}").file;
    return typeof file === "string" && file ? file : undefined;
  } catch {
    return undefined;
  }
}

// The agents CLI: AGENTS_APP_AGENTS_BIN when it is set, else the one the app installs
// (~/.local/bin/agents links to it), else the first on PATH.
export function agentsCLI() {
  if (process.env.AGENTS_APP_AGENTS_BIN) return process.env.AGENTS_APP_AGENTS_BIN;
  const installed = path.join(os.homedir(), ".local", "bin", "agents");
  return fs.existsSync(installed) ? installed : "agents";
}
