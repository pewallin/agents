// @ts-nocheck
// Quiet threads (P8): an open thread with no activity for two days gets its coordinator woken
// once, to propose closing it, as done or as dropped with a reason (`agent resolve <task> --propose
// "<why>" [--as dropped]`). The proposal shows as a close card in the thread and the user closes
// it, or keeps it open; nothing closes by itself.

import { enqueueMessage } from "./messages.js";
import { shellQuote } from "./launch.js";
import { oneLine } from "./processes.js";
import { coordinatorLeads } from "./program.js";
import { sharedCLIPath } from "./briefs.js";
import { readSessionLines, sessionsFile, threadRows, threadTitleOf } from "./threads.js";

export const QUIET_THREAD_DAYS = 2;

// How long a thread is quiet before its coordinator proposes closing it (AGENTS_APP_QUIET_THREAD_MS
// in tests).
export function quietThreadMs() {
  const ms = Number(process.env.AGENTS_APP_QUIET_THREAD_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : QUIET_THREAD_DAYS * 24 * 60 * 60 * 1000;
}

// When anything last happened in a thread: it started, its worker reported or was reported on,
// a line reached it, it started a session, it was reopened. `deliveredAt` is when lines last
// reached its worker (supervisor.ts), `live` its pane's record, if it has one.
export function threadActivityAt(program, row, { live, deliveredAt = () => 0 } = {}) {
  const times = [
    row.meta.createdAt,
    row.meta.reopenedAt,
    row.report?.updatedAt,
    ...(row.report?.history || []).slice(-1).map(entry => entry.at),
    ...readSessionLines(sessionsFile(program, row.task)).slice(-1).map(entry => entry.at),
  ].map(at => Date.parse(at || "") || 0);
  if (live) {
    times.push((live.reportAt || 0) * 1000, deliveredAt(program, live.uuid));
  }
  return Math.max(0, ...times);
}

// The line that wakes the coordinator about one quiet thread.
export function quietThreadLine(program, task, title, days, line) {
  const cli = shellQuote(sharedCLIPath());
  const last = line ? ` Its last report: "${oneLine(line, 200)}".` : "";
  return `Thread ${task} ("${title}") has had no activity for ${days} days.${last} If its goal is done, propose closing it: ${cli} agent resolve ${task} --propose "<why, in the user's language>". If it is no longer wanted, propose dropping it: add --as dropped. The user sees a close card in the thread and closes it, or keeps it open. If it should stay open, end your turn without a reply.`;
}

/**
 * Wakes the program's coordinator once for each open thread that has been quiet for two days and
 * has no proposal to close it yet. `notified` (the supervisor's notified.json) keeps which quiet
 * spell it was told of: a thread that comes alive and goes quiet again is told of again. Returns
 * the tasks it told of; nothing when no coordinator leads the program (it is told once one does).
 */
export function wakeForQuietThreads(program, records, { now = Date.now(), notified = {}, statusOf = () => undefined, deliveredAt = () => 0, isWorker = () => false, leads = coordinatorLeads } = {}) {
  const coordinator = records.find(record => record.program === program && record.uuid && leads(record));
  if (!coordinator) return [];
  const told = [];
  for (const row of threadRows(program)) {
    if (row.meta.resolved || row.meta.proposedClose) continue;
    const live = records.find(record => record.program === program && record.task === row.task && isWorker(record));
    // A worker at work is no quiet thread, whatever its files say.
    if (live && statusOf(live.paneID) === "working") continue;
    const at = threadActivityAt(program, row, { live, deliveredAt });
    if (!at || now - at < quietThreadMs()) continue;
    const key = `${row.task}#quiet`;
    if (notified[key] === at) continue;
    const days = Math.max(QUIET_THREAD_DAYS, Math.floor((now - at) / (24 * 60 * 60 * 1000)));
    enqueueMessage(program, coordinator.uuid, quietThreadLine(program, row.task, threadTitleOf(program, row), days, row.report?.line), `Thread ${row.task} has been quiet for ${days} days`, undefined, { event: { kind: "wake", thread: row.task } });
    notified[key] = at;
    told.push(row.task);
  }
  return told;
}
