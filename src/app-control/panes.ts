// @ts-nocheck
// Pane refs and finding an agent's tmux pane.

import { spawnSync } from "node:child_process";
import { isSharedCodexDaemon } from "./mcp.js";
import { fail } from "./output.js";
import { processTable } from "./processes.js";
import { coordinationPaneRecords } from "./program.js";

export function paneRefString(paneRef) {
  if (!paneRef) return undefined;
  if (typeof paneRef === "string") return paneRef;
  if (paneRef.hostID && paneRef.paneID) return `${paneRef.hostID}:${paneRef.paneID}`;
  return undefined;
}

export function paneIDFromRef(paneRef) {
  if (!paneRef) return undefined;
  const value = paneRefString(paneRef);
  if (!value) return undefined;
  const colon = value.lastIndexOf(":");
  return colon >= 0 ? value.slice(colon + 1) : value;
}

export function hostIDFromRef(paneRef) {
  if (!paneRef) return undefined;
  const value = paneRefString(paneRef);
  if (!value) return undefined;
  const colon = value.lastIndexOf(":");
  return colon >= 0 ? value.slice(0, colon) : undefined;
}

export function localPaneRef(paneRef) {
  const value = paneRefString(paneRef);
  if (!value) return undefined;
  return value.includes(":") ? value : `local:${value}`;
}

// AGENTS_APP_TMUX_SOCKET names the tmux server (the per-agent scripts of earlier versions set it):
// some harnesses run an agent's commands with another environment than its pane's. `-u`: without a UTF-8 locale in that
// environment tmux prints the tabs between format fields as `_`.
export function tmuxArgs(args) {
  const socket = process.env.AGENTS_APP_TMUX_SOCKET ? ["-S", process.env.AGENTS_APP_TMUX_SOCKET] : [];
  return ["-u", ...socket, ...args];
}

// A tmux server that stops answering must not hold a command, or the supervisor, forever.
export const TMUX_TIMEOUT_MS = 20000;

export function runTMux(args) {
  const result = spawnSync("tmux", tmuxArgs(args), { encoding: "utf8", timeout: TMUX_TIMEOUT_MS });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

export function runTMuxRequired(args, action) {
  const result = spawnSync("tmux", tmuxArgs(args), { encoding: "utf8", timeout: TMUX_TIMEOUT_MS });
  if (result.status === 0) return result.stdout.trim();
  const detail = (result.stderr || result.stdout || "unknown error").trim();
  fail(1, "tmuxFailed", `${action} failed: ${detail}`);
}

// Inside a sandbox (Codex's, for one) tmux's socket refuses the connection, and every lookup in
// tmux comes back empty: say so, rather than that the agent's pane or name does not exist.
export function failIfTMuxUnreachable(commandName) {
  const result = spawnSync("tmux", tmuxArgs(["list-sessions", "-F", "#{session_name}"]), { encoding: "utf8", timeout: TMUX_TIMEOUT_MS });
  if (result.status === 0) return;
  const detail = (result.stderr || result.error?.message || "no answer").trim();
  const sandboxed = /not permitted|EPERM/i.test(detail);
  fail(2, "tmuxUnavailable", `'${commandName}' could not reach tmux: ${detail}. Nothing was done.${sandboxed ? " A sandbox blocks tmux's socket: run the command again outside the sandbox (with escalated permissions)." : ""}`);
}

export function currentTMuxPaneID() {
  return runTMux(["display-message", "-p", "#{pane_id}"]) || undefined;
}

// The pane that carries an agent's @agents_uuid now. An agent is named by that identity (or its
// task), not by pane number: tmux numbers panes anew after a restart or restore, and the old
// number may by then belong to another agent.
export function paneOfAgent(uuid, commandName) {
  const output = runTMux(["list-panes", "-a", "-F", "#{pane_id}\t#{@agents_uuid}"]);
  if (output === undefined) fail(2, "tmuxUnavailable", `'${commandName}' could not reach tmux to find the pane of agent ${uuid}.`);
  const panes = [...new Set(output.split(/\r?\n/).map(line => line.split("\t")).filter(([, id]) => id === uuid).map(([paneID]) => paneID))];
  if (panes.length === 1) return panes[0];
  if (panes.length === 0) {
    fail(2, "identityUnavailable", `No tmux pane carries this agent's identity (@agents_uuid ${uuid}): its pane closed, or was restored without it. Nothing was done. In the agent's pane, run 'agents-app-control agent protocol' (a coordinator) to write its CLI again, or pass --pane.`);
  }
  fail(2, "identityAmbiguous", `Panes ${panes.join(", ")} all carry @agents_uuid ${uuid}; nothing was done. Pass --pane to choose one.`);
}

// The pane whose process the CLI runs under: { paneID }, { paneID: undefined, ancestors } when
// none is, or { unknown: true } when tmux or ps cannot tell. Every agent the app starts runs its
// commands beneath its pane's process, so this names the agent without a script of its own.
export function paneOfProcessTree() {
  const output = runTMux(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]);
  if (!output) return { unknown: true };
  const panes = new Map(output.split(/\r?\n/).map(line => line.split("\t")).map(([paneID, pid]) => [Number(pid), paneID]));
  const table = processTable();
  if (!table.byPid.has(process.pid)) return { unknown: true };
  const ancestors = [];
  const seen = new Set();
  for (let current = table.byPid.get(process.pid); current && !seen.has(current.pid); current = table.byPid.get(current.ppid)) {
    // Through Codex's shared app-server daemon the pane is that of the Codex that started the
    // daemon, which may be another agent: no pane, and the caller names itself (--as).
    if (panes.has(current.pid)) return ancestors.some(isSharedCodexDaemon) ? { paneID: undefined, ancestors } : { paneID: panes.get(current.pid) };
    seen.add(current.pid);
    ancestors.push(current);
  }
  return { paneID: undefined, ancestors };
}

// A Codex on the shared app-server daemon runs commands outside every pane, with the environment
// of the Codex that started the daemon: its TMUX_PANE names another agent's pane.
export function runsUnderDetachedCodex(ancestors) {
  return (ancestors || []).some(entry => entry.comm === "codex" || /(^|\/)codex(\s|$)/.test(entry.args));
}

// `--as <name>`: the agent's task, `coordinator-<first 8 of its uuid>`, or its uuid. For an agent
// whose commands run outside its pane; one that runs inside it cannot name another agent.
export function paneOfNamedAgent(name, commandName) {
  const wanted = String(name).trim().toLowerCase();
  const prefix = wanted.replace(/^coordinator-/, "");
  const records = coordinationPaneRecords();
  const named = records.filter(record => !record.dead && (
    (record.task && record.task.toLowerCase() === wanted)
    || (record.uuid && (record.uuid === wanted || (prefix.length >= 8 && /^[0-9a-f-]+$/.test(prefix) && record.uuid.startsWith(prefix))))
  ));
  const tree = paneOfProcessTree();
  if (tree.paneID && !named.some(record => record.paneID === tree.paneID)) {
    fail(2, "identityMismatch", `'${commandName}' runs in pane ${tree.paneID}, which is not '${name}'. Leave out --as: the CLI finds your own pane.`);
  }
  if (tree.paneID) return tree.paneID;
  if (named.length === 1) return named[0].paneID;
  if (named.length === 0) failIfTMuxUnreachable(commandName);
  if (named.length === 0) fail(2, "identityUnavailable", `No agent named '${name}' in local tmux (--as takes your task name, or coordinator-<first 8 characters of your @agents_uuid>).`);
  fail(2, "identityAmbiguous", `Panes ${named.map(record => record.paneID).join(", ")} are all '${name}'; nothing was done. Pass --pane to choose one.`);
}

export function resolveLocalSourcePane(params, commandName) {
  if (!params.pane && params.as) {
    return localPaneRef(paneOfNamedAgent(params.as, commandName));
  }
  // Set by the per-agent scripts of earlier versions, which still work.
  if (!params.pane && process.env.AGENTS_APP_AGENT_UUID) {
    return localPaneRef(paneOfAgent(process.env.AGENTS_APP_AGENT_UUID, commandName));
  }
  if (!params.pane && !process.env.AGENTS_APP_TMUX_PANE_ID) {
    const tree = paneOfProcessTree();
    if (tree.paneID) return localPaneRef(tree.paneID);
    if (!tree.unknown && runsUnderDetachedCodex(tree.ancestors)) {
      fail(2, "identityUnavailable", `'${commandName}' runs outside your tmux pane (Codex on its shared app-server daemon runs commands there), so it cannot tell which agent you are. Nothing was done. Run it again with --as <your task name>, or --as coordinator-<id> as your coordinator instructions name it.`);
    }
  }
  const sourcePaneHint = params.pane
    || process.env.AGENTS_APP_TMUX_PANE_ID
    || process.env.TMUX_PANE
    || currentTMuxPaneID();
  if (!sourcePaneHint) {
    fail(2, "paneUnavailable", `Could not identify this process's pane. Set AGENTS_APP_TMUX_PANE_ID, TMUX_PANE, or pass --pane to '${commandName}'.`);
  }
  const sourceHost = hostIDFromRef(sourcePaneHint);
  if (sourceHost && sourceHost !== "local") {
    fail(2, "unsupportedTarget", `'${commandName}' can only target local tmux panes, got '${sourcePaneHint}'.`);
  }
  return localPaneRef(sourcePaneHint);
}

export function tmuxPaneOption(pane, option) {
  const paneID = paneIDFromRef(pane);
  if (!paneID) return undefined;
  return runTMux(["show-options", "-p", "-q", "-t", paneID, "-v", option]) || undefined;
}

export function tmuxPaneRecords() {
  const output = runTMux([
    "list-panes",
    "-a",
    "-F",
    [
      "#{pane_id}",
      "#{session_name}",
      "#{window_id}",
      "#{window_index}",
      "#{pane_index}",
      "#{pane_current_path}",
    ].join("\t"),
  ]);
  if (!output) return [];
  return output.split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [paneID, sessionName, windowID, windowIndex, paneIndex, cwd] = line.split("\t");
      return { paneID, sessionName, windowID, windowIndex, paneIndex, cwd };
    })
    .filter(record => record.paneID);
}

export function canonicalSourcePaneRecord(sourcePane) {
  const paneID = paneIDFromRef(sourcePane);
  if (!paneID) return undefined;
  const records = tmuxPaneRecords().filter(record => record.paneID === paneID);
  return records.find(record => !record.sessionName.startsWith("_agents_next_")) || records[0];
}

export function setPaneOption(pane, option, value) {
  if (value === undefined || value === null || value === "") return;
  runTMuxRequired(["set-option", "-p", "-q", "-t", paneIDFromRef(pane), option, String(value)], `tmux set-option ${option}`);
}

export function unsetPaneOption(pane, option) {
  runTMux(["set-option", "-p", "-q", "-u", "-t", paneIDFromRef(pane), option]);
}
