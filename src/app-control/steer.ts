// @ts-nocheck
// Steering a message into a working agent (Codex app-server, inboxes).

import { appControlCommandText } from "./self.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { typeQueuedLines } from "./ask.js";
import { HOOK_STATES, paneContent, readMessageRecord, screenState, writeMessageRecord } from "./delivery.js";
import { shellQuote } from "./launch.js";
import { coordinatorReminder, enqueueMessage } from "./messages.js";
import { runTMux } from "./panes.js";
import { sleep } from "./placement.js";
import { AT_PROMPT_STATES, SHELL_COMMANDS, paneRunsAgent, processTable } from "./processes.js";
import { coordinationPaneRecords, readJSON, writeFileAtomic } from "./program.js";
import { appInputState, supervisorLog, userIsWriting } from "./supervisor.js";
import { agentStatuses, processAlive } from "./supervisor-control.js";

// Steering: a message into the turn an agent is working on, through its harness's own API, never
// keys typed into a busy terminal. Codex is the one harness here with such an API: its app-server's
// `turn/steer` adds input to the active turn, checked against the turn's id, and keeps the client's
// message id on the input item. Claude Code, Kiro, Pi and the rest have no API a pane exposes.
//
// A Codex worker runs through `agents codex-session`, which gives the pane an app-server of its own
// and writes its loopback endpoint to <agents tmp>/codex-app-server/pane-<n>.json along with the
// pid of that codex-session. The endpoint counts only when that pid runs inside the target pane
// now: a pane number may belong to another tmux server, or to an earlier pane.
export function codexEndpointDirectory() {
  const home = process.env.AGENTS_HOME || path.join(os.homedir(), ".agents", "agents-app");
  return path.join(process.env.AGENTS_TMP_DIR || path.join(home, "runtime", "tmp"), "codex-app-server");
}

export function processDescendsFrom(table, pid, ancestor) {
  const seen = new Set();
  for (let current = table.byPid.get(pid); current && !seen.has(current.pid); current = table.byPid.get(current.ppid)) {
    if (current.pid === ancestor) return true;
    seen.add(current.pid);
  }
  return false;
}

export function codexEndpointForPane(record) {
  const file = path.join(codexEndpointDirectory(), `${record.paneID.replace(/^%/, "pane-")}.json`);
  const metadata = readJSON(file, undefined);
  if (!metadata || typeof metadata.url !== "string") return { missing: true, reason: `no Codex app-server is recorded for pane ${record.paneID} (its agent was not started through agents codex-session, or is not Codex)` };
  let url;
  try {
    url = new URL(metadata.url);
  } catch {
    return { reason: `the app-server endpoint recorded for pane ${record.paneID} is not a URL` };
  }
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") return { reason: `the app-server endpoint recorded for pane ${record.paneID} is not a loopback WebSocket` };
  const pid = Number(metadata.processId);
  if (!pid || !record.panePid || !processDescendsFrom(processTable(), pid, record.panePid)) {
    return { reason: `the app-server recorded for pane ${record.paneID} does not belong to the agent in that pane now` };
  }
  return { url: url.href };
}

// One JSON-RPC connection to an app-server. Notifications are ignored; every call times out.
export async function codexRPC(url) {
  if (typeof WebSocket !== "function") throw Object.assign(new Error(`this Node (${process.version}) has no WebSocket client`), { unsupported: true });
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`could not connect to the Codex app-server at ${url}`)), { once: true });
    setTimeout(() => reject(new Error(`timed out connecting to the Codex app-server at ${url}`)), 5000);
  });
  let next = 1;
  const pending = new Map();
  socket.addEventListener("message", event => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.method || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(Object.assign(new Error(message.error.message || "error"), { rpc: message.error }));
    else resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(new Error("the Codex app-server closed the connection"));
    pending.clear();
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`the Codex app-server did not answer ${method}`));
    }, 8000);
  });
  await call("initialize", { clientInfo: { name: "agents-app-control", version: "1" }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
  return { call, close: () => socket.close() };
}

export function turnHasMessage(turn, id) {
  return (turn?.items || []).some(item => item.type === "userMessage" && item.clientId === id);
}

// The agent's own thread on the pane's app-server and the turn it works on: { threadId, turn } or
// { reason, code }. A sub-agent's thread (one with a parent) is never the one steered.
export async function codexActiveTurn(rpc) {
  const loaded = await rpc.call("thread/loaded/list", {});
  const threads = [];
  for (const threadId of loaded?.data || []) {
    const read = await rpc.call("thread/read", { threadId, includeTurns: false });
    if (read?.thread && !read.thread.parentThreadId) threads.push(read.thread);
  }
  const active = threads.filter(thread => thread.status?.type === "active");
  if (active.length === 0) return { code: "notWorking", reason: "the agent is not in a turn; queue the message for its prompt" };
  if (active.length > 1) return { code: "ambiguous", reason: `the app-server runs ${active.length} turns at once and none is known to be the agent's` };
  const thread = active[0];
  const flags = thread.status.activeFlags || [];
  if (flags.length > 0) return { code: "waitsOnUser", reason: `the agent's turn waits on ${flags.includes("waitingOnApproval") ? "an approval" : "the user's answer"} in its pane` };
  const turns = await rpc.call("thread/turns/list", { threadId: thread.id, limit: 3, itemsView: "full" });
  const turn = (turns?.data || []).find(candidate => candidate.status === "inProgress");
  if (!turn) return { code: "notWorking", reason: "the agent's turn just ended; queue the message for its prompt" };
  return { threadId: thread.id, turn, recent: turns.data };
}

// Steers one message into the agent's current turn. Safe to repeat with the same id: a message the
// thread already holds is not sent again. { ok, state, turnId } or { ok: false, code, reason }.
export async function steerCodex(record, id, text) {
  const endpoint = codexEndpointForPane(record);
  if (!endpoint.url) return { ok: false, code: "unsupported", reason: endpoint.reason, missing: endpoint.missing };
  let rpc;
  try {
    rpc = await codexRPC(endpoint.url);
    const active = await codexActiveTurn(rpc);
    if (!active.threadId) return { ok: false, ...active };
    const earlier = active.recent.find(turn => turnHasMessage(turn, id));
    if (earlier) return { ok: true, state: "acknowledged", turnId: earlier.id, threadId: active.threadId, repeated: true };
    let steered;
    try {
      steered = await rpc.call("turn/steer", {
        threadId: active.threadId,
        expectedTurnId: active.turn.id,
        clientUserMessageId: id,
        input: [{ type: "text", text, text_elements: [] }],
      });
    } catch (error) {
      if (error.rpc?.code === -32601) return { ok: false, code: "unsupported", reason: "this Codex has no turn/steer" };
      // The turn ended, or another took its place, between the look and the steer: nothing was added.
      if (error.rpc) return { ok: false, code: "notWorking", reason: `Codex refused the steer: ${error.rpc.message}` };
      throw error;
    }
    // The evidence: the thread lists the message, by its id, as input of the turn.
    const after = await rpc.call("thread/turns/list", { threadId: active.threadId, limit: 3, itemsView: "full" }).catch(() => undefined);
    const holding = (after?.data || []).find(turn => turnHasMessage(turn, id));
    return { ok: true, state: holding ? "acknowledged" : "steered", turnId: holding?.id || steered?.turnId || active.turn.id, threadId: active.threadId };
  } catch (error) {
    return { ok: false, code: error.unsupported ? "unsupported" : "unreachable", reason: error.message };
  } finally {
    rpc?.close();
  }
}

// A steered message Codex had not yet written into its turn when the steer returned (it takes
// steered input in at the turn's next step): asks again, and records the acknowledgement.
export async function confirmSteer(program, record) {
  const target = coordinationPaneRecords().find(candidate => candidate.uuid === record.target);
  const endpoint = target && codexEndpointForPane(target);
  if (!endpoint?.url || !record.threadId) return record;
  let rpc;
  try {
    rpc = await codexRPC(endpoint.url);
    const turns = await rpc.call("thread/turns/list", { threadId: record.threadId, limit: 5, itemsView: "full" });
    const holding = (turns?.data || []).find(turn => turnHasMessage(turn, record.id));
    return holding ? writeMessageRecord(program, record, "acknowledged", `Codex lists it as input of turn ${holding.id}`, { turnId: holding.id }) : record;
  } catch {
    return record;
  } finally {
    rpc?.close();
  }
}

// Whether a message steered by an earlier, interrupted send is in one of the agent's recent turns:
// { turnId }, {} when it is not, or { unknown } when Codex cannot be asked.
export async function findSteered(target, id) {
  const endpoint = codexEndpointForPane(target);
  if (!endpoint.url) return {};
  let rpc;
  try {
    rpc = await codexRPC(endpoint.url);
    const loaded = await rpc.call("thread/loaded/list", {});
    for (const threadId of loaded?.data || []) {
      const turns = await rpc.call("thread/turns/list", { threadId, limit: 5, itemsView: "full" }).catch(() => undefined);
      const holding = (turns?.data || []).find(turn => turnHasMessage(turn, id));
      if (holding) return { turnId: holding.id };
    }
    return {};
  } catch (error) {
    return { unknown: error.message };
  } finally {
    rpc?.close();
  }
}

// The steer inbox (pewallin/agents docs/steer-inbox.md): a directory per pane of a tmux server,
// <agents tmp>/steer/<server pid>-pane-<n>. An agent's own hook or extension says it takes
// steered messages there (harness.json: harness and pid), takes <id>.msg by renaming it to
// <id>.taken at a safe point of its turn, and writes <id>.ack.json (steered, then acknowledged
// where it can tell). Withdrawing is the same rename to <id>.withdrawn: one of the two wins.
export function agentsTmpDirectory() {
  const home = process.env.AGENTS_HOME || path.join(process.env.AGENTS_SHARED_HOME || path.join(os.homedir(), ".agents"), process.env.AGENTS_PRODUCT_DIRNAME || "agents-app");
  return process.env.AGENTS_TMP_DIR || path.join(home, "runtime", "tmp");
}

export function steerInboxDirectory(paneID) {
  const server = runTMux(["display-message", "-p", "#{pid}"]);
  return server ? path.join(agentsTmpDirectory(), "steer", `${server.trim()}-pane-${paneID.replace(/^%/, "")}`) : undefined;
}

export const HARNESS_NAMES = { claude: "Claude Code", pi: "Pi" };
// How long `agent send` waits for the agent to take a message before it answers `offered`.
export const OFFER_WAIT_MS = 3000;

export async function steerThroughInbox(program, target, id, line) {
  const agent = paneAgentName(target) || "the agent";
  const none = `${agent} in pane ${target.paneID} takes no steered messages: Codex does through its app-server, Claude Code through the agents PostToolUse hook and Pi through the agents extension (each once it has run in that pane); Copilot, OpenCode and Kiro have no way in yet`;
  const dir = steerInboxDirectory(target.paneID);
  const harness = dir && readJSON(path.join(dir, "harness.json"), undefined);
  if (!harness?.harness || !harness.pid) return { ok: false, code: "unsupported", reason: none };
  if (!processAlive(harness.pid) || !processDescendsFrom(processTable(), harness.pid, target.panePid)) {
    return { ok: false, code: "unsupported", reason: `${none} (the agent that last took them there is gone)` };
  }
  const name = HARNESS_NAMES[harness.harness] || harness.harness;
  const status = agentStatuses([target.paneID]).get(target.paneID)?.status;
  if (status !== "working") {
    return { ok: false, code: status === "attention" || status === "question" || status === "approval" ? "waitsOnUser" : "notWorking", reason: `the ${name} in pane ${target.paneID} is ${status || "in an unknown state"}, not working on a turn` };
  }
  writeFileAtomic(path.join(dir, `${id}.msg`), `${JSON.stringify({ id, text: line, at: new Date().toISOString() })}\n`);
  const deadline = Date.now() + OFFER_WAIT_MS;
  let ack;
  while (!(ack = readJSON(path.join(dir, `${id}.ack.json`), undefined)) && Date.now() < deadline) await sleep(200);
  if (ack?.state === "rejected") return { ok: false, code: "unsupported", reason: `the ${name} refused it: ${ack.detail}` };
  if (ack?.state === "steered" || ack?.state === "acknowledged") return { ok: true, inbox: dir, harness: harness.harness, state: ack.state, detail: `${name}: ${ack.detail}` };
  return { ok: true, inbox: dir, harness: harness.harness, state: "offered", detail: `in the steer inbox of pane ${target.paneID} for the ${name} to take` };
}

// Offers and steers the supervisor follows: <program>/.run/offered/<id>.
export function followOffer(program, id) {
  const dir = path.join(program, ".run", "offered");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id), "");
}

// Brings an inbox record up to date from its ack; withdraws an offer the agent can no longer take
// (its turn ended, its pane is gone). The record, and true when there is nothing left to follow.
export function settleOffer(program, record, atPrompt) {
  const ack = readJSON(path.join(record.inbox, `${record.id}.ack.json`), undefined);
  const name = HARNESS_NAMES[record.harness] || record.harness;
  if (ack?.state === "rejected") return { record: writeMessageRecord(program, record, "notSent", `the ${name} refused it: ${ack.detail}`, { reason: ack.detail }), done: true, tell: true };
  if (ack && (ack.state === "steered" || ack.state === "acknowledged")) {
    const updated = record.state === ack.state ? record : writeMessageRecord(program, record, ack.state, `${name}: ${ack.detail}`);
    // Claude Code says no more than steered; Pi says acknowledged once it delivers it.
    const old = Date.now() - (Date.parse(record.createdAt) || 0) > 10 * 60 * 1000;
    return { record: updated, done: ack.state === "acknowledged" || record.harness === "claude" || old };
  }
  if (record.state !== "offered" || !atPrompt) return { record, done: false };
  try {
    fs.renameSync(path.join(record.inbox, `${record.id}.msg`), path.join(record.inbox, `${record.id}.withdrawn`));
  } catch {
    return { record, done: false }; // Taken just now: its ack follows.
  }
  const reason = `the agent's turn ended before the ${name} took it`;
  return { record: writeMessageRecord(program, record, "notSent", `withdrawn: ${reason}`, { reason }), done: true, tell: true };
}

// One supervisor tick over the program's offers.
export function followOffers(program, records) {
  const dir = path.join(program, ".run", "offered");
  let ids = [];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const pending = ids.map(id => ({ id, record: readMessageRecord(program, id) }));
  const targets = new Map(records.map(record => [record.uuid, record]));
  const panes = pending.map(item => targets.get(item.record?.target)?.paneID).filter(Boolean);
  const statuses = agentStatuses([...new Set(panes)]);
  for (const { id, record } of pending) {
    if (!record?.inbox) {
      fs.rmSync(path.join(dir, id), { force: true });
      continue;
    }
    const target = targets.get(record.target);
    const status = target ? statuses.get(target.paneID)?.status : undefined;
    // An offer gets a moment before an idle state counts: the hook may report late.
    const settledFor = Date.now() - (Date.parse(record.updatedAt) || 0) > 4000;
    const atPrompt = !target || (AT_PROMPT_STATES.has(status) && settledFor);
    const { record: updated, done, tell } = settleOffer(program, record, atPrompt);
    if (tell && updated.from && targets.has(updated.from)) {
      const fallback = `${appControlCommandText()} agent send --to ${shellQuote(updated.task || updated.target)} --id ${updated.id} --mode queue --json`;
      enqueueMessage(program, updated.from, `Message ${updated.id} to ${updated.task || updated.pane} was not steered and reached nobody: ${updated.reason}. To deliver it at the agent's prompt instead, run: ${fallback}`, `Message ${updated.id} was not steered`);
      supervisorLog(`message ${updated.id} was not steered: ${updated.reason}`);
    }
    if (done) fs.rmSync(path.join(dir, id), { force: true });
  }
  return ids.length;
}

// What the agent in a pane is, by name, for a refusal that names it.
export function paneAgentName(record) {
  const front = paneRunsAgent(record);
  return front.agent || (SHELL_COMMANDS.has(record.currentCommand) ? undefined : record.currentCommand);
}

// Types the pane's queued lines in at once when its agent waits at its prompt and its screen
// stands still, as the supervisor would on its next ticks. Lines are claimed by renaming them,
// so a supervisor that runs meanwhile never types them twice. False leaves them queued.
export async function deliverQueuedNow(program, uuid, record) {
  if (record.inMode || !paneRunsAgent(record).ok) return false;
  // Its hooks say so, or its screen shows the prompt and stands still for a moment (a few
  // tries: a TUI may still settle after starting or answering).
  const hook = agentStatuses([record.paneID]).get(record.paneID)?.status;
  let status = HOOK_STATES.has(hook) ? hook : undefined;
  if (!status) {
    let previous = paneContent(record.paneID);
    for (let attempt = 0; attempt < 8 && !status; attempt += 1) {
      await sleep(400);
      const current = paneContent(record.paneID);
      const state = screenState(current.text);
      if (state !== "prompt") return false;
      if (current.hash && current.hash === previous.hash) status = "idle";
      previous = current;
    }
  }
  if (!AT_PROMPT_STATES.has(status)) return false;
  if (userIsWriting(await appInputState(record.paneID))) return false;
  let names = [];
  try {
    names = fs.readdirSync(path.join(program, ".queue", uuid)).filter(name => name.endsWith(".txt")).sort();
  } catch {
    return false;
  }
  const typed = typeQueuedLines(program, uuid, record, names, coordinatorReminder());
  if (typed) {
    try {
      fs.mkdirSync(path.join(program, ".run"), { recursive: true });
      fs.appendFileSync(path.join(program, ".run", "supervisor.log"), `${new Date().toISOString()} promote typed ${names.length} queued message(s) into ${record.paneID}\n`);
    } catch {
      // Only a log line.
    }
  }
  return typed;
}
