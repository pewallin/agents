// @ts-nocheck
// agent notify: in a project only the coordinator notifies the user, and only for a turn it marks
// (R7). A turn it does not mark is quiet; a wake it answers with nothing never notifies.
//
// The mark waits in <program>/.run/notify.json until the turn ends. A coordinator's ACP view host
// takes it with the turn (thread.jsonl `notify`) and sets the pane's @agents_notify, which the app
// notifies from. A coordinator without a host (a terminal) has the supervisor set it once its
// agent waits at its prompt again.

import fs from "node:fs";
import { requestID } from "./app-socket.js";
import { NOTIFY_OPTION, NOTIFY_REASONS, markTurnNotify, notifyOptionValue, pendingTurnNotify } from "./conversation.js";
import { fail } from "./output.js";
import { localPaneRef, setPaneOption } from "./panes.js";
import { notifyApp, ownCoordinationRecord, readJSON, recordedCoordinatorProgram } from "./program.js";
import { oneLine } from "./processes.js";
import { ensureSupervisor, processAlive } from "./supervisor-control.js";
import { acpHostMetadataPath, acpHostRuntimeTempDir } from "../acp-host-paths.js";

export async function runAgentNotify(command) {
  const params = command.params;
  const record = ownCoordinationRecord(params, "agent notify");
  if (record.role !== "coordinator") {
    fail(2, "notCoordinator", "Only the coordinator notifies the user. A thread stays quiet: its coordinator hears of it and decides whether to tell them.");
  }
  const program = recordedCoordinatorProgram(record);
  if (!program) fail(2, "noProgram", "This coordinator has no project yet.");
  const text = oneLine(command.text, 300);
  if (!text) fail(64, "usage", "agent notify needs the line the user reads, in their language: agent notify \"auth-fix is done and its PR is up\" --why done.");
  const why = params.why === undefined ? undefined : String(params.why).toLowerCase();
  if (why !== undefined && !NOTIFY_REASONS.includes(why)) {
    fail(64, "usage", `agent notify --why is ${NOTIFY_REASONS.join(", ")}.`);
  }
  const mark = markTurnNotify(program, { text, ...(why ? { why } : {}) });
  // The supervisor sets the mark for a coordinator that has no view host to take it.
  if (!hasLiveAcpHost(record.paneID)) ensureSupervisor(program);
  return {
    id: requestID("cli"),
    ok: true,
    result: {
      program,
      notify: mark,
      next: "This turn notifies the user when it ends, with this line and your answer. End the turn with the answer they should read; a turn you do not mark stays quiet.",
    },
  };
}

// Whether a pane's ACP view host runs, and so takes the mark when the coordinator's turn ends.
export function hasLiveAcpHost(paneID) {
  const metadata = readJSON(acpHostMetadataPath(acpHostRuntimeTempDir(), paneID), undefined);
  return typeof metadata?.processId === "number" && processAlive(metadata.processId);
}

// A marked turn of a coordinator without a view host, once the coordinator waits at its prompt
// again (the supervisor's tick): its pane's @agents_notify, without a turn of the conversation.
// A mark a host should take is left to it for a while, in case the host's turn is still ending.
export function settleTerminalNotify(program, record, atPrompt, now = Date.now()) {
  if (!atPrompt) return false;
  const pending = pendingTurnNotify(program);
  if (!pending) return false;
  const age = now - (Date.parse(pending.at) || now);
  if (age < 5000 || (hasLiveAcpHost(record.paneID) && age < 60000)) return false;
  fs.rmSync(`${program}/.run/notify.json`, { force: true });
  setPaneOption(localPaneRef(record.paneID), NOTIFY_OPTION, notifyOptionValue(undefined, pending.at, pending));
  notifyApp(record.sessionName);
  return true;
}

// A mark nobody took in two hours (its coordinator's pane went away mid-turn) goes, quietly.
export function dropStaleNotify(program, now = Date.now()) {
  const pending = pendingTurnNotify(program);
  if (!pending || now - (Date.parse(pending.at) || 0) < 2 * 60 * 60 * 1000) return false;
  fs.rmSync(`${program}/.run/notify.json`, { force: true });
  return true;
}
