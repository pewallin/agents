// @ts-nocheck
// agent send and agent delivery.

import { appControlCommandText } from "./self.js";
import fs from "node:fs";
import path from "node:path";
import { requestID } from "./app-socket.js";
import { cancelMessage, deliveryView } from "./ask.js";
import { programDirectories } from "./coordinator.js";
import { deliveryState, messageRecordFile, newMessageID, pruneMessageRecords, readMessageRecord, writeMessageRecord } from "./delivery.js";
import { shellQuote } from "./launch.js";
import { enqueueMessage, enqueueRider } from "./messages.js";
import { fail, usage } from "./output.js";
import { localPaneRef, paneIDFromRef } from "./panes.js";
import { oneLine, paneRunsAgent } from "./processes.js";
import { coordinationPaneRecords, ensurePaneUUID, ownCoordinationRecord, slug, taskPaths, writeFileAtomic } from "./program.js";
import { answerQuestion, claimWaitingAsk, openQuestionsFor, questionView, readQuestion, writeQuestion } from "./questions.js";
import { hostsSession, promptHosted } from "./spawn-support.js";
import { confirmSteer, findSteered, followOffer, settleOffer, steerCodex, steerThroughInbox } from "./steer.js";
import { agentStatuses, ensureSupervisor, readFileOr } from "./supervisor-control.js";

// Longer than this, a message waits in a file and the line typed into the prompt points at it.
export const INLINE_MESSAGE_LIMIT = 600;

export function isPaneRefText(value) {
  return /^(local:)?%\d+$/.test(String(value || ""));
}

// An agent's @agents_uuid, which outlasts its pane number.
export function isAgentUUIDText(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export async function runAgentSend(command) {
  const params = command.params;
  let raw = command.text;
  if (params.file) {
    if (raw) fail(64, "usage", "agent send takes the text or --file, not both.");
    raw = readFileOr(path.resolve(params.file), undefined);
    if (raw === undefined) fail(2, "fileUnavailable", `Could not read ${params.file}.`);
  }
  if (!params.to) fail(64, "usage", "agent send requires --to parent, --to <task> or --to <pane>.");
  const own = ownCoordinationRecord(params, "agent send");
  const records = coordinationPaneRecords();
  let target;
  let resolvedTo;
  if (params.to === "parent") {
    target = own.parent ? records.find(record => record.uuid === own.parent) : undefined;
    if (!target) fail(2, "paneUnavailable", own.parent ? "Your coordinator's pane is gone; nothing was sent. Report with agent report instead: it reaches whoever takes over." : "This pane has no coordinator (no @agents_parent); nothing was sent. Send to a task, pane or agent uuid instead.");
  } else if (isPaneRefText(params.to)) {
    target = records.find(record => record.paneID === paneIDFromRef(params.to));
    if (!target) fail(2, "paneUnavailable", `Could not find pane '${params.to}' in local tmux.`);
  } else if (isAgentUUIDText(params.to)) {
    target = records.find(record => record.uuid === params.to.toLowerCase());
    if (!target) fail(2, "identityUnavailable", `No tmux pane carries @agents_uuid ${params.to}; nothing was sent.`);
  } else {
    ({ target, resolvedTo } = taskTarget(records, own.program, params.to));
  }
  const program = own.program || target.program;
  if (!program) fail(2, "noProgram", "Neither this pane nor the target belongs to a program.");
  const mode = params.mode || "queue";
  const wake = !params["no-wake"];
  const targetUUID = ensurePaneUUID(target);
  pruneMessageRecords(program);

  // What the message answers: the question --reply-to names, or the worker's one open question
  // for this sender. An answer to a question that is answered or closed already is a late reply.
  let question;
  let late;
  let repliesTo;
  let unthreaded;
  if (params["reply-to"]) {
    const asked = readQuestion(program, params["reply-to"]);
    if (asked) {
      if (asked.from !== targetUUID) {
        fail(2, "replyMismatch", `Message ${asked.id} is a question from another agent, not from ${target.task || target.paneID}; nothing was sent.`, { messageId: asked.id });
      }
      if (asked.state === "open") question = asked;
      else late = asked;
    } else if (readMessageRecord(program, params["reply-to"])) {
      repliesTo = params["reply-to"];
    } else {
      fail(2, "messageUnavailable", `No message has id ${params["reply-to"]}; nothing was sent.`);
    }
  } else if (wake) {
    const open = openQuestionsFor(program, target, own);
    if (open.length === 1) question = open[0];
    if (open.length > 1) unthreaded = open.map(item => questionView(item));
  }

  // A send repeated with the same --id (a retry) never delivers twice: a message that is queued,
  // typed or steered is only reported. One that was not sent (a steer that was not possible) may be
  // sent again, without its text: the record keeps it.
  const id = params.id || newMessageID();
  const lock = messageRecordFile(program, id).replace(/\.json$/, ".lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let lockFD;
  try {
    lockFD = fs.openSync(lock, "wx");
  } catch {
    fail(2, "messageBusy", `Another agent send of message ${id} is running.`, { messageId: id });
  }
  // fail() exits without running finally blocks.
  process.once("exit", () => fs.rmSync(lock, { force: true }));
  try {
    let existing = readMessageRecord(program, id);
    if (existing && existing.target !== targetUUID) {
      fail(2, "messageIdTaken", `Message ${id} went to another agent; use a new id.`, { messageId: id });
    }
    // A steer that died before it knew how it went: the harness knows. Steering again asks it
    // first; queueing instead asks it here, so the message is not queued after all it reached the turn.
    if (existing?.state === "steering" && mode === "queue") {
      const landed = await findSteered(target, id);
      if (landed.turnId) existing = writeMessageRecord(program, existing, "acknowledged", `Codex lists it as input of turn ${landed.turnId}`, { turnId: landed.turnId });
      else if (landed.unknown) fail(2, "steerUnknown", `Cannot tell whether the earlier steer of ${id} reached the agent (${landed.unknown}); nothing was queued.`, { messageId: id });
      else existing = writeMessageRecord(program, existing, "notSent", "the earlier steer did not reach the agent");
    }
    const settled = existing && !["notSent", "steering"].includes(existing.state);
    if (settled) {
      return { id: requestID("cli"), ok: true, result: { ...deliveryView(existing), repeated: true } };
    }
    // The message it replaces goes, while it is still queued or offered; one that reached the
    // agent stays, and the new line says it replaces it.
    let superseded;
    if (params.supersedes) {
      const old = readMessageRecord(program, params.supersedes);
      if (!old) fail(2, "messageUnavailable", `No message has id ${params.supersedes}; nothing was sent.`);
      if (old.id === id) fail(64, "usage", "agent send --supersedes names an earlier message, not this one.");
      if (old.from !== own.uuid || old.target !== targetUUID) {
        fail(2, "supersedeMismatch", `Message ${old.id} is not one of yours to ${target.task || target.paneID}; --supersedes takes your own earlier message to the same agent. Nothing was sent.`, { messageId: old.id });
      }
      superseded = cancelMessage(program, old, `superseded by ${id}`);
    }
    const leads = [];
    if (question) leads.push(`answering your question "${oneLine(question.text, 80)}"`);
    if (late) leads.push(`a late reply to your question "${oneLine(late.text, 80)}" (${late.state === "answered" ? "already answered" : late.closedReason || "closed"})`);
    if (repliesTo) leads.push(`replying to message ${repliesTo}`);
    if (superseded && !superseded.cancelled) leads.push(`replacing its earlier message ${superseded.messageId}`);
    let line = existing?.line;
    let file = existing?.file;
    if (String(raw || "").trim()) {
      ({ line, file } = messageLine(program, own, target, raw, leads));
    } else if (!line) {
      fail(64, "usage", "agent send requires text or --file.");
    }
    const base = existing || { id, program, target: targetUUID, task: target.task, pane: localPaneRef(target.paneID), from: own.uuid, createdAt: new Date().toISOString() };
    const threading = {
      replyTo: (question || late)?.id || repliesTo,
      late: late ? true : undefined,
      supersedes: superseded?.messageId,
      wake: wake ? undefined : false,
    };
    const record = { ...base, ...threading, mode, line, file, pane: localPaneRef(target.paneID) };
    // What the result says of the threading.
    const threaded = result => ({
      ...result,
      resolvedTo,
      answers: question?.id,
      lateReplyTo: late?.id,
      superseded,
      openQuestions: unthreaded,
      hint: unthreaded ? `${target.task || target.paneID} has ${unthreaded.length} open questions for you; this message answers none of them. Answer one with --reply-to <id>.` : result.hint,
    });
    const answered = via => {
      if (question) answerQuestion(program, question, target, { messageId: id, via, from: senderName(own) });
    };

    // A blocking `agent ask` that still waits takes the answer itself: the worker goes on in the
    // same turn, and nothing is typed into its prompt.
    if (question?.blocking && claimWaitingAsk(program, question.id)) {
      const handed = writeMessageRecord(program, { ...record, mode: "ask" }, "answered", `handed to the waiting agent ask in pane ${target.paneID}`, { reason: undefined });
      writeQuestion(program, {
        ...question,
        state: "answered",
        answer: { messageId: id, via: "ask", from: senderName(own), text: String(raw || "").trim() || line, file, at: new Date().toISOString() },
      });
      supervisorLogTo(program, `handed answer ${id} to the waiting agent ask of ${target.paneID}`);
      return { id: requestID("cli"), ok: true, result: threaded({ ...deliveryView(handed), task: target.task, file, delivered: true }) };
    }

    if (mode === "steer") {
      const steering = writeMessageRecord(program, record, "steering", `into the turn of pane ${target.paneID}`);
      // An agent whose pane's host holds its session: a prompt into the session, which the agent
      // takes with its turn.
      if (hostsSession(target.paneID)) {
        const hostedSteer = promptHosted(target.paneID, line, true);
        if (!hostedSteer) {
          const done = writeMessageRecord(program, steering, "notSent", "the pane's ACP host did not take it", { reason: "the pane's ACP host did not take it" });
          fail(3, "steerUnavailable", "Not steered: the pane's ACP host did not take it.", { messageId: id, sent: false, task: target.task, delivery: deliveryView(done) });
        }
        // The host steers the agent's turn where it can; else the line is the agent's next prompt.
        const how = {
          steered: ["steered", `steered into the turn through the ACP host of pane ${target.paneID}`],
          acknowledged: ["acknowledged", `steered into the turn through the ACP host of pane ${target.paneID}`],
          offered: ["steered", `offered to the agent's next step through the ACP host of pane ${target.paneID}; queued for its next prompt if the turn ends first`],
          prompted: ["steered", `prompted through the ACP host of pane ${target.paneID} (no turn was running)`],
          queued: ["steered", `queued through the ACP host of pane ${target.paneID}: the agent takes no steering, so it is the agent's next prompt`],
        }[hostedSteer.state] || ["steered", `prompted through the ACP host of pane ${target.paneID}`];
        const done = writeMessageRecord(program, steering, how[0], how[1], { harness: "acp", reason: undefined });
        supervisorLogTo(program, `steered message ${id} into ${target.paneID} through its ACP host (${hostedSteer.state})`);
        answered("steer");
        return { id: requestID("cli"), ok: true, result: threaded({ ...deliveryView(done), task: target.task, file, delivered: true }) };
      }
      // Codex through its app-server; any other agent through the pane's steer inbox, which its
      // own hook or extension takes from at a safe point of the turn.
      let outcome = await steerCodex(target, id, line);
      if (!outcome.ok && outcome.missing) outcome = await steerThroughInbox(program, target, id, line);
      if (!outcome.ok) {
        const reason = outcome.reason;
        const done = writeMessageRecord(program, steering, "notSent", reason, { reason });
        const fallback = `${appControlCommandText()} agent send --to ${shellQuote(params.to)} --id ${id} --mode queue --json`;
        fail(3, "steerUnavailable", `Not steered, and not queued: ${reason}. To deliver it at the agent's next prompt instead, run: ${fallback}`, {
          messageId: id, sent: false, why: outcome.code, task: target.task, fallback, delivery: deliveryView(done),
        });
      }
      if (outcome.inbox) {
        const done = writeMessageRecord(program, steering, outcome.state, outcome.detail, { harness: outcome.harness, inbox: outcome.inbox, reason: undefined });
        if (outcome.state === "offered" || (outcome.state === "steered" && outcome.harness !== "claude")) {
          followOffer(program, id);
          ensureSupervisor(program);
        }
        supervisorLogTo(program, `offered message ${id} to the ${outcome.harness} in ${target.paneID} (${outcome.state})`);
        answered("steer");
        return {
          id: requestID("cli"),
          ok: true,
          result: threaded({
            ...deliveryView(done),
            task: target.task,
            file,
            delivered: outcome.state !== "offered",
            next: outcome.state === "offered"
              ? `${outcome.harness === "claude" ? "Claude Code takes it after its next tool call" : "The agent takes it at its next safe point"}. If its turn ends first, it is withdrawn and you are told; check with agent delivery ${id}.`
              : undefined,
          }),
        };
      }
      const done = writeMessageRecord(program, steering, outcome.state, outcome.state === "acknowledged"
        ? `Codex lists it as input of turn ${outcome.turnId}`
        : `Codex accepted it into turn ${outcome.turnId}`, { turnId: outcome.turnId, threadId: outcome.threadId, harness: "codex", reason: undefined });
      supervisorLogTo(program, `steered message ${id} into ${target.paneID} (turn ${outcome.turnId}, ${outcome.state})`);
      answered("steer");
      return { id: requestID("cli"), ok: true, result: threaded({ ...deliveryView(done), task: target.task, file, delivered: true, repeated: outcome.repeated || undefined }) };
    }

    // Information only: it waits for the next line that goes to the agent and rides along.
    if (!wake) {
      enqueueRider(program, targetUUID, line, `Note from ${senderName(own)}`, id);
      const riding = writeMessageRecord(program, record, "queued", `rides along with the next line to pane ${target.paneID}`, { reason: undefined });
      return {
        id: requestID("cli"),
        ok: true,
        result: threaded({ ...deliveryView(riding), queuedFor: localPaneRef(target.paneID), task: target.task, file, delivered: false, wakes: false }),
      };
    }

    const summary = question ? `Answer from ${senderName(own)}` : late ? `Late reply from ${senderName(own)}` : `Message from ${senderName(own)}`;
    enqueueMessage(program, targetUUID, line, summary, id);
    const queuedRecord = writeMessageRecord(program, record, "queued", `for the prompt of pane ${target.paneID}`, { reason: undefined });
    answered("prompt");
    ensureSupervisor(program);
    // Queued, not delivered: the supervisor types it in once the agent waits at its prompt.
    // `agent delivery <id>` and `agent status` show where it stands and why it waits.
    const front = paneRunsAgent(target);
    const status = agentStatuses([target.paneID]).get(target.paneID)?.status;
    const busy = status === "working" || status === "compacting";
    return {
      id: requestID("cli"),
      ok: true,
      result: threaded({
        ...deliveryView(queuedRecord),
        queuedFor: localPaneRef(target.paneID),
        task: target.task,
        file,
        delivered: false,
        queued: deliveryState(program, targetUUID).queued,
        waiting: front.ok ? (busy ? `the agent in pane ${target.paneID} is ${status}; the line waits for its turn to end` : undefined) : front.reason,
        hint: busy ? `It reaches the agent only after its current turn. A correction that cannot wait: send it with --mode steer.` : undefined,
      }),
    };
  } finally {
    fs.closeSync(lockFD);
    fs.rmSync(lock, { force: true });
  }
}

// The live worker a task name names: the task itself, else the one task it is a prefix of (the
// result then says which). A name that fits none suggests the closest.
export function taskTarget(records, program, name) {
  const live = records.filter(record => record.task && !record.dead && (!program || record.program === program));
  const exact = live.filter(record => record.task === name);
  if (exact.length === 1) return { target: exact[0] };
  if (exact.length > 1) {
    fail(2, "taskAmbiguous", `More than one live worker has task '${name}' (panes ${exact.map(record => record.paneID).join(", ")}); nothing was sent. Send to one of those panes with --to <pane>.`);
  }
  const wanted = String(name).toLowerCase();
  const prefixed = live.filter(record => record.task.toLowerCase().startsWith(wanted));
  if (prefixed.length === 1) return { target: prefixed[0], resolvedTo: { given: name, task: prefixed[0].task } };
  const names = [...new Set(live.map(record => record.task))].sort();
  if (prefixed.length > 1) {
    fail(2, "taskAmbiguous", `'${name}' begins more than one task: ${prefixed.map(record => record.task).join(", ")}; nothing was sent. Give more of the name.`, { matches: prefixed.map(record => record.task) });
  }
  const closest = names
    .map(task => ({ task, distance: editDistance(wanted, task.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance)[0];
  const suggestion = closest && closest.distance <= Math.max(2, Math.floor(closest.task.length / 3)) ? closest.task : undefined;
  const known = names.length ? ` Live workers: ${names.join(", ")}.` : " There are no live workers; agent status --all lists the tasks, and agent respawn <task> starts one again.";
  fail(2, "taskUnavailable", `No live worker has task '${name}'; nothing was sent.${suggestion ? ` Did you mean '${suggestion}'?` : ""}${known}`, suggestion ? { suggestion } : undefined);
}

export function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

export function senderName(own) {
  return own.task || (own.role === "coordinator" ? "coordinator" : `pane ${own.paneID}`);
}

// The line a message makes: inline, or for a long one a pointer to a file that keeps it word for word.
// `leads` say what it answers or replaces: "From coordinator, answering your question "…": …".
export function messageLine(program, own, target, raw, leads = []) {
  const from = senderName(own);
  const head = [`From ${from}`, ...leads].join(", ");
  const text = oneLine(raw, Number.MAX_SAFE_INTEGER);
  if (text.length <= INLINE_MESSAGE_LIMIT) return { line: `${head}: ${text}` };
  // Kept as written, line breaks too: the user's words reach the worker unchanged.
  const inbox = target.task && target.program === program
    ? path.join(taskPaths(program, target.task).dir, "inbox")
    : path.join(program, "inbox");
  const file = path.join(inbox, `${new Date().toISOString().replace(/[:.]/g, "-")}-from-${slug(from) || "agent"}.md`);
  writeFileAtomic(file, `${String(raw).trim()}\n`);
  return { line: `${head}: a message of ${text.length} characters is in ${file}. Read it all; it is meant word for word.`, file };
}

export function supervisorLogTo(program, message) {
  try {
    fs.mkdirSync(path.join(program, ".run"), { recursive: true });
    fs.appendFileSync(path.join(program, ".run", "supervisor.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Only a log line.
  }
}

// Where a message stands, by the id `agent send` gave it.
export async function runAgentDelivery(command) {
  const hint = command.params.pane || process.env.AGENTS_APP_TMUX_PANE_ID || process.env.TMUX_PANE;
  const own = hint ? coordinationPaneRecords().find(candidate => candidate.paneID === paneIDFromRef(hint)) : undefined;
  const programs = [...new Set([own?.program, ...programDirectories()].filter(Boolean))];
  for (const program of programs) {
    let record = readMessageRecord(program, command.id);
    if (record?.state === "steered" && !record.inbox) record = await confirmSteer(program, record);
    if (record?.inbox && ["offered", "steered"].includes(record.state)) record = settleOffer(program, record, false).record;
    if (record && command.params.cancel) {
      const outcome = cancelMessage(program, record, "cancelled by its sender");
      record = readMessageRecord(program, command.id) || record;
      return { id: requestID("cli"), ok: true, result: { ...deliveryView(record), ...outcome, history: record.history } };
    }
    if (record) return { id: requestID("cli"), ok: true, result: { ...deliveryView(record), history: record.history } };
  }
  fail(2, "messageUnavailable", `No message has id ${command.id}.`);
}

// Coordinators. Any agent can become one (`agent promote`), take over another's workers
// (`--take-over`), and take on an agent that already runs as its worker (`agent adopt`).
