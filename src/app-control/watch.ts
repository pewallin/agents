// @ts-nocheck
// agent remind and agent watch.

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { requestID } from "./app-socket.js";
import { shellQuote } from "./launch.js";
import { enqueueMessage } from "./messages.js";
import { fail, usage } from "./output.js";
import { runTMux } from "./panes.js";
import { oneLine } from "./processes.js";
import { coordinatorProgram, ensurePaneUUID, ownCoordinationRecord, readJSON, writeFileAtomic } from "./program.js";
import { supervisorLog } from "./supervisor.js";
import { ensureSupervisor, readFileOr } from "./supervisor-control.js";

export function parseDuration(text, flag) {
  const value = String(text || "").trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || !value) fail(64, "usage", `${flag} takes a duration like 90s, 20m, 2h or 1h30m.`);
  return ((Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 60 + Number(match[3] || 0)) * 1000;
}

export function parseClockTime(text) {
  const value = String(text || "").trim();
  const clock = value.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const due = new Date();
    due.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (due.getTime() <= Date.now()) due.setDate(due.getDate() + 1);
    return due.getTime();
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(64, "usage", "--at takes a time like 14:30 or an ISO date.");
  return parsed;
}

export function watchesDirectory(program) {
  return path.join(program, ".watches");
}

export function readWatches(program) {
  const dir = watchesDirectory(program);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.map(name => readJSON(path.join(dir, name), undefined)).filter(Boolean);
}

export function saveWatch(program, watch) {
  writeFileAtomic(path.join(watchesDirectory(program), `${watch.id}.json`), `${JSON.stringify(watch, null, 2)}\n`);
}

export function removeWatch(program, id) {
  for (const suffix of [".json", ".out", ".exit"]) {
    fs.rmSync(path.join(watchesDirectory(program), `${id}${suffix}`), { force: true });
  }
}

// The process a cmd watch started, as `ps` sees it: its group, its start time and its command
// line. A pid alone may by now belong to another process, the tmux server among them.
export function processIdentity(pid) {
  if (!pid) return undefined;
  const result = spawnSync("ps", ["-o", "pgid=,lstart=,command=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (result.status !== 0) return undefined;
  const fields = result.stdout.trim().split(/\s+/);
  if (fields.length < 7) return undefined;
  return { pgid: Number(fields[0]), lstart: fields.slice(1, 6).join(" "), command: fields.slice(6).join(" ") };
}

// True only while the watch's own shell still runs: same pid, group, start time and command, and
// not the tmux server. Anything else is left alone.
export function watchProcessIsOurs(watch) {
  if (!watch.pid || !watch.pgid || !watch.lstart) return false;
  const now = processIdentity(watch.pid);
  if (!now || now.pgid !== watch.pgid || now.lstart !== watch.lstart || !now.command.includes(watch.id)) return false;
  const serverPid = Number(runTMux(["display-message", "-p", "#{pid}"]));
  return watch.pid !== serverPid && watch.pgid !== serverPid && watch.pgid > 1 && watch.pgid !== process.pid;
}

export function stopWatchProcess(watch) {
  if (!watchProcessIsOurs(watch)) return false;
  try {
    process.kill(-watch.pgid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function ownProgramForWatch(params, commandName) {
  const own = ownCoordinationRecord(params, commandName);
  const uuid = ensurePaneUUID(own);
  return { own, uuid, program: params.program ? path.resolve(params.program) : coordinatorProgram(own) };
}

export function clockText(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export async function runAgentRemind(command) {
  const params = command.params;
  const dueAt = params.at ? parseClockTime(params.at) : Date.now() + parseDuration(params.in, "--in");
  const { uuid, program } = ownProgramForWatch(params, "agent remind");
  const id = `remind-${Date.now().toString(36)}`;
  saveWatch(program, { id, kind: "remind", target: uuid, text: oneLine(command.text, 600), createdAt: Date.now(), dueAt });
  ensureSupervisor(program);
  return { id: requestID("cli"), ok: true, result: { watch: id, dueAt: new Date(dueAt).toISOString() } };
}

export async function runAgentWatch(command) {
  const params = command.params;
  const { uuid, program } = ownProgramForWatch(params, "agent watch");
  if (params.list) {
    return { id: requestID("cli"), ok: true, result: { watches: readWatches(program).filter(watch => watch.target === uuid).map(watchSummary) } };
  }
  if (params.cancel) {
    const watch = readWatches(program).find(candidate => candidate.id === params.cancel);
    if (!watch) fail(2, "watchUnavailable", `No watch '${params.cancel}' in ${program}.`);
    stopWatchProcess(watch);
    removeWatch(program, watch.id);
    return { id: requestID("cli"), ok: true, result: { cancelled: watch.id } };
  }
  const until = params.until || "success";
  if (!["success", "change"].includes(until)) fail(64, "usage", "agent watch --until must be 'success' or 'change'.");
  const cmd = params.cmd || params.poll;
  const every = params.every ? parseDuration(params.every, "--every") : 60000;
  if (params.poll && every < 10000) fail(64, "usage", "agent watch --every must be at least 10s.");
  const watch = {
    id: `watch-${Date.now().toString(36)}`,
    kind: params.cmd ? "cmd" : "poll",
    target: uuid,
    label: oneLine(command.label || cmd, 120),
    cmd,
    cwd: process.cwd(),
    createdAt: Date.now(),
    deadline: Date.now() + (params.timeout ? parseDuration(params.timeout, "--timeout") : 24 * 3600 * 1000),
    ...(params.poll ? { every, until, nextAt: Date.now() } : {}),
  };
  saveWatch(program, watch);
  ensureSupervisor(program);
  return { id: requestID("cli"), ok: true, result: watchSummary(watch) };
}

export function watchSummary(watch) {
  return {
    watch: watch.id,
    kind: watch.kind,
    label: watch.label || watch.text,
    dueAt: watch.dueAt ? new Date(watch.dueAt).toISOString() : undefined,
    every: watch.every ? `${Math.round(watch.every / 1000)}s` : undefined,
    until: watch.until,
  };
}

export function outputTail(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  return oneLine(lines.slice(-5).join(" | "), 300);
}

export function elapsedText(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes < 1 ? `${Math.round(ms / 1000)}s` : minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

// One supervisor tick for the program's reminders and watches.
export function processWatches(program) {
  const now = Date.now();
  const watches = readWatches(program);
  for (const watch of watches) {
    const finish = (line, summary) => {
      enqueueMessage(program, watch.target, line, summary);
      removeWatch(program, watch.id);
      supervisorLog(`${watch.id} done`);
    };
    if (watch.kind === "remind") {
      if (now >= watch.dueAt) finish(`Reminder you set at ${clockText(watch.createdAt)}: ${watch.text}`, `Reminder: ${watch.text}`);
      continue;
    }
    if (watch.kind === "cmd") {
      const dir = watchesDirectory(program);
      const outFile = path.join(dir, `${watch.id}.out`);
      const exitFile = path.join(dir, `${watch.id}.exit`);
      if (!watch.pid) {
        // Detached, so the command outlives a supervisor restart; it leaves its exit status behind.
        const child = spawn(
          "/bin/sh",
          ["-c", `(${watch.cmd}) > ${shellQuote(outFile)} 2>&1; echo $? > ${shellQuote(exitFile)}`],
          { cwd: watch.cwd, detached: true, stdio: "ignore" }
        );
        child.unref();
        // Detached means a group of its own; what is recorded here is what may be signalled later.
        const identity = processIdentity(child.pid);
        saveWatch(program, { ...watch, pid: child.pid, pgid: identity?.pgid, lstart: identity?.lstart, startedAt: now });
        continue;
      }
      const exit = readFileOr(exitFile, "").trim();
      if (exit !== "") {
        const tail = outputTail(readFileOr(outFile, ""));
        finish(`Watch "${watch.label}" ended: \`${oneLine(watch.cmd, 200)}\` exited with ${exit} after ${elapsedText(now - watch.startedAt)}.${tail ? ` Last output: ${tail}` : ""}`, `Watch "${watch.label}" ended (exit ${exit})`);
      } else if (!watchProcessIsOurs(watch)) {
        // It may have ended between the two looks; then the next tick has its exit status.
        if (readFileOr(exitFile, "").trim() !== "") continue;
        finish(`Watch "${watch.label}" was lost: \`${oneLine(watch.cmd, 200)}\` stopped without an exit status.`, `Watch "${watch.label}" was lost`);
      } else if (now > watch.deadline) {
        stopWatchProcess(watch);
        finish(`Watch "${watch.label}" timed out after ${elapsedText(now - watch.startedAt)}; \`${oneLine(watch.cmd, 200)}\` was stopped.`, `Watch "${watch.label}" timed out`);
      }
      continue;
    }
    if (watch.kind === "poll" && now >= watch.nextAt) {
      const result = spawnSync("/bin/sh", ["-c", watch.cmd], { cwd: watch.cwd, encoding: "utf8", timeout: 60000 });
      const output = `${result.stdout || ""}${result.stderr || ""}`;
      const tail = outputTail(output);
      const polls = (watch.polls || 0) + 1;
      const met = watch.until === "change"
        ? watch.firstOutput !== undefined && output !== watch.firstOutput
        : result.status === 0;
      if (met) {
        finish(watch.until === "change"
          ? `Watch "${watch.label}": the output of \`${oneLine(watch.cmd, 200)}\` changed after ${elapsedText(now - watch.createdAt)}. Now: ${tail}`
          : `Watch "${watch.label}": \`${oneLine(watch.cmd, 200)}\` succeeded after ${polls} tries (${elapsedText(now - watch.createdAt)}).${tail ? ` Output: ${tail}` : ""}`,
        watch.until === "change" ? `Watch "${watch.label}" changed` : `Watch "${watch.label}" succeeded`);
      } else if (now > watch.deadline) {
        finish(`Watch "${watch.label}" gave up after ${polls} tries (${elapsedText(now - watch.createdAt)}): \`${oneLine(watch.cmd, 200)}\` last exited with ${result.status ?? "a timeout"}.${tail ? ` Output: ${tail}` : ""}`, `Watch "${watch.label}" gave up`);
      } else {
        saveWatch(program, { ...watch, polls, nextAt: now + watch.every, firstOutput: watch.firstOutput ?? output });
      }
    }
  }
  return readWatches(program).length;
}
