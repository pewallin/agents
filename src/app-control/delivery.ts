// @ts-nocheck
// Screen state, delivery state and message records.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { RIDER_SUFFIX, pruneMessages, queueNames } from "./messages.js";
import { runTMux } from "./panes.js";
import { AT_PROMPT_STATES, oneLine, paneRunsAgent } from "./processes.js";
import { readJSON, writeFileAtomic } from "./program.js";
import { deliveredAt, supervisorLog } from "./supervisor.js";

export function paneContent(paneID) {
  const text = runTMux(["capture-pane", "-p", "-t", paneID, "-S", "-15"]);
  return text === undefined
    ? {}
    : { text, hash: crypto.createHash("sha1").update(text).digest("hex") };
}

// What an agent's screen shows, for an agent whose hooks say nothing (Codex with hooks it was
// not allowed to run, an agent without hooks): a choice it waits on (a permission or a question
// with numbered options), work in progress, or its input prompt. Claude Code, Codex and Kiro
// draw these much alike.
export const SCREEN_CHOICE = /^\s*[❯›>]\s*\d+[.)]\s+\S/;
// A spinner line ("✻ Architecting…", "• Working (12s • esc to interrupt)", Copilot's
// "◎ Working · 86 B esc esc interrupt" and "◎ Working esc esc edit prompt", or its older
// "(Esc to cancel)"), not a reply's bullet.
export const SCREEN_WORKING = /esc to interrupt|\besc esc\b|\(esc to cancel\b|\(\d+m? ?\d*s [·•]|^\s*[^\w\s⏺•]\s+[A-Z][a-z]+…/i;
export const SCREEN_PROMPT = /^\s*[❯›>](\s|$)/;

export function screenState(text) {
  const lines = String(text || "").split(/\r?\n/).filter(line => line.trim());
  const bottom = count => lines.slice(-count);
  if (bottom(14).some(line => SCREEN_CHOICE.test(line))) return "choice";
  if (bottom(8).some(line => SCREEN_WORKING.test(line))) return "working";
  if (bottom(6).some(line => SCREEN_PROMPT.test(line))) return "prompt";
  return undefined;
}

// The lines of the choice a worker waits on, for its coordinator to pass on.
export function screenChoiceText(text) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[─╌━-]+$/.test(line));
  const bottom = lines.slice(-14);
  const first = bottom.findIndex(line => SCREEN_CHOICE.test(line));
  return oneLine(bottom.slice(Math.max(0, first - 3)).join(" "), 400);
}

// What a permission waiting in an agent's screen asks for, in a few words: the command a Codex
// prompt shows ("$ git push origin main"), else the first two lines of the prompt's block, from a
// rule or a box's edge down to its question (Claude Code's "Bash command" and the command), else
// the question itself.
export function permissionSummary(text) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.replace(/[│┃╭╮╰╯┌┐└┘]/g, "").trim());
  const bottom = lines.slice(-24);
  const choice = bottom.findIndex(line => SCREEN_CHOICE.test(line));
  if (choice < 0) return undefined;
  let start = choice;
  while (start > 0 && choice - start < 8 && !/^[─━╌═-]{3,}$/.test(bottom[start - 1])) start--;
  const block = bottom.slice(start, choice).filter(Boolean);
  const command = block.find(line => line.startsWith("$ "));
  if (command) return oneLine(command.slice(2), 120);
  const question = block.findLastIndex(line => line.endsWith("?"));
  const head = (question < 0 ? block : block.slice(0, question)).slice(0, 2);
  if (head.length) return oneLine(head.join(": "), 120);
  return question >= 0 ? oneLine(block[question], 120) : undefined;
}

// The states a hook reports; anything else (nothing, or "unknown") leaves it to the screen.
export const HOOK_STATES = new Set(["working", "idle", "question", "attention", "compacting"]);

// The agent's state: its hooks first, else its screen. A prompt counts as idle once the screen
// has stood still for two polls, so a turn that only paused is not taken for its end.
export function effectiveStatus(hookStatus, pane) {
  if (HOOK_STATES.has(hookStatus)) return hookStatus;
  switch (screenState(pane?.text)) {
  case "choice": return "attention";
  case "working": return "working";
  case "prompt": return pane.stableTicks >= 2 ? "idle" : undefined;
  default: return undefined;
  }
}

// Why a queued line may not be typed into the pane yet, or nothing when it may.
export function deliveryHold(record, status, pane, now) {
  if (!AT_PROMPT_STATES.has(status)) return `the agent in pane ${record.paneID} is ${status || "in an unknown state"}, not waiting at its prompt`;
  if (record.inMode) return `pane ${record.paneID} is in copy mode`;
  const front = paneRunsAgent(record);
  if (!front.ok) return front.reason;
  if (!(pane.stableTicks >= 2)) return `the screen of pane ${record.paneID} is still changing`;
  if (now - (pane.deliveredAt || 0) <= 10000) return `a line was typed into pane ${record.paneID} moments ago`;
  return undefined;
}

// Per target pane, what its queue holds and why it waits, or when lines last reached it; `agent
// status` shows it, so a queued line is not taken for a delivered one.
export function deliveryFile(program, uuid) {
  return path.join(program, ".run", "delivery", `${uuid}.json`);
}

export function noteDelivery(program, uuid, paneID, update, now) {
  const file = deliveryFile(program, uuid);
  const previous = readJSON(file, {});
  const at = new Date(now).toISOString();
  const next = { pane: paneID, queued: update.queued, deliveredAt: previous.deliveredAt, delivered: previous.delivered || 0 };
  if (update.waiting) {
    next.waiting = update.waiting;
    next.waitingSince = previous.waiting === update.waiting ? previous.waitingSince : at;
    if (previous.waiting !== update.waiting) supervisorLog(`holding ${update.queued} message(s) for ${paneID}: ${update.waiting}`);
  }
  if (update.delivered) {
    next.deliveredAt = at;
    next.delivered += update.delivered;
    supervisorLog(`delivered ${update.delivered} message(s) to ${paneID}`);
  }
  if (JSON.stringify(next) !== JSON.stringify(previous)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  }
}

// The lines still queued for a pane: counted from the queue itself, which is the truth, with the
// supervisor's latest reason for holding them.
export function deliveryState(program, uuid) {
  if (!uuid) return {};
  let queued = 0;
  try {
    queued = fs.readdirSync(path.join(program, ".queue", uuid)).filter(name => name.endsWith(".txt")).length;
  } catch {
    queued = 0;
  }
  const noted = readJSON(deliveryFile(program, uuid), {});
  const riders = queueNames(program, uuid, RIDER_SUFFIX).length;
  return {
    queued: queued || undefined,
    // Lines sent with --no-wake, which go out with the next queued line.
    riding: riders || undefined,
    waiting: queued ? noted.waiting || "the supervisor has not looked at the pane yet" : undefined,
    waitingSince: queued ? noted.waitingSince : undefined,
    deliveredAt: noted.deliveredAt,
  };
}

// Delivery records. Each message has an id and a record of where it stands, which `agent send`
// returns and `agent delivery <id>` shows. The states say only what is known:
//   queued        waits in the queue for the agent's prompt
//   typing        claimed and being typed into the prompt
//   delivered     typed into the prompt and submitted with Enter (the harness took it as input)
//   uncertain     a typing that did not finish (the CLI died midway): it may have reached the
//                 prompt, so it is not typed again
//   steering      being handed to the harness's steering API
//   steered       the harness accepted it into the agent's current turn
//   acknowledged  the harness lists it as user input of that turn (Codex: an item with its id)
//   offered       in the pane's steer inbox, for the agent's own hook or extension to take at
//                 a safe point of its turn (Claude Code: after a tool call); withdrawn as notSent
//                 if the turn ends first
//   notSent       steering was not possible, or the turn ended before the agent took it;
//                 nothing reached the agent
//   undelivered   its agent's pane went away before the line could be typed
// No state says "read": nothing tells that the model took it in.
export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function newMessageID() {
  return `m-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function messageRecordFile(program, id) {
  return path.join(program, ".run", "messages", `${id}.json`);
}

export function readMessageRecord(program, id) {
  return readJSON(messageRecordFile(program, id), undefined);
}

export function writeMessageRecord(program, record, state, detail, extra = {}) {
  const at = new Date().toISOString();
  const next = { ...record, ...extra, state, updatedAt: at, history: [...(record.history || []), { at, state, ...(detail ? { detail } : {}) }].slice(-20) };
  writeFileAtomic(messageRecordFile(program, record.id), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// The record of a queued line, when it has one: lines queued by an older CLI, or by the supervisor
// before it kept records, have none.
export function updateMessageRecord(program, id, state, detail, extra) {
  if (!id) return undefined;
  const record = readMessageRecord(program, id) || { id };
  return writeMessageRecord(program, record, state, detail, extra);
}

// Records go with the messages they stand for.
export function pruneMessageRecords(program) {
  pruneMessages(path.join(program, ".run", "messages"));
}
