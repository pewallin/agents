// @ts-nocheck
// agent promote, protocol, adopt and respawn.

import { appControlSkillDirectory } from "./self.js";
import fs from "node:fs";
import path from "node:path";
import { agentSessionFile } from "./agent-state.js";
import { requestID } from "./app-socket.js";
import { LANGUAGE_OPTION, asHint, coordinatorCLIName, coordinatorLanguage, ensureSharedCLI, languageSentence, threadTitle, writeBrief, writeStatusFile, writeTaskMeta, writeTaskReport } from "./briefs.js";
import { coordinatorToTakeOver, giveCoordinatorBackground, goneCoordinators, inheritCoordinatorBackground, programNotes, protocolFile, protocolText, skillFile, starterContext, starterOverview, takeOver, userInstructions, userInstructionsPath, waitForSpawnedRecord } from "./coordinator.js";
import { shellQuote } from "./launch.js";
import { enqueueMessage } from "./messages.js";
import { fail, usage } from "./output.js";
import { localPaneRef, paneIDFromRef, runTMux, runTMuxRequired, setPaneOption, tmuxPaneOption } from "./panes.js";
import { paneRunsAgent } from "./processes.js";
import { coordinationPaneRecords, coordinatorProgram, ensurePaneUUID, folderCoordinator, notifyApp, ownCoordinationRecord, programMeta, programName, readJSON, recordedCoordinatorProgram, setProgramName, taskPaths, uniqueTaskName, writeFileAtomic } from "./program.js";
import { closeOpenQuestions } from "./questions.js";
import { closedReportState } from "./report.js";
import { runAgentSpawn } from "./spawn.js";
import { noteSubWorker, subWorkerLead } from "./spawn-support.js";
import { deliverQueuedNow } from "./steer.js";
import { agentStatuses, ensureSupervisor } from "./supervisor-control.js";
import { readSessionLines, recordCoordinatorSession, sessionsFile, threadRows, threadsEpoch, titleWarning, transcriptLookup } from "./threads.js";

export async function runAgentPromote(command) {
  const params = command.params;
  const record = params["spawn-id"]
    ? await waitForSpawnedRecord(params["spawn-id"])
    : ownCoordinationRecord(params, "agent promote");
  const pane = localPaneRef(record.paneID);
  // A pane that already coordinates runs a new agent when it is promoted again: the user switched
  // its agent (Switch Agent in the app replaces the process and keeps the pane's role).
  const wasCoordinator = record.role === "coordinator";
  // Checked first: a take-over that fails leaves every pane, queue and task as it was.
  const old = params["take-over"]
    ? coordinatorToTakeOver(params["take-over"], record, params.program ? path.resolve(params.program) : undefined)
    : undefined;
  const uuid = ensurePaneUUID(record);
  const records = coordinationPaneRecords();
  const program = coordinatorProgram(record, params.program || old?.program, records);
  const notes = programNotes(program);
  threadsEpoch(program);
  setPaneOption(pane, "@agents_role", "coordinator");
  // The session that leads the program from now on (coordinators.jsonl); one that starts as
  // coordinator has none yet, and the supervisor records it once it has.
  const own = agentStatuses([record.paneID]).get(record.paneID);
  if (own?.sessionId && own.agent) {
    recordCoordinatorSession(program, { via: "promote", agent: own.agent, session: own.sessionId, uuid, cwd: tmuxPaneOption(record.paneID, "@agents_command_cwd") || undefined });
  }
  const language = coordinatorLanguage(params, record);
  const contextFile = path.join(program, "CONTEXT.md");
  if (!fs.existsSync(contextFile)) writeFileAtomic(contextFile, starterContext(record));
  const overviewFile = path.join(program, "OVERVIEW.md");
  if (!fs.existsSync(overviewFile)) writeFileAtomic(overviewFile, starterOverview());
  const cli = ensureSharedCLI();
  // Another coordinator still leads this folder's earlier work, so this one got a program of its
  // own: if the user meant it to carry on that work, it takes the other over instead.
  const rival = old || notes.coordinatedBefore ? undefined : folderCoordinator(program, record, records);
  const elsewhere = rival
    ? ` The coordinator in pane ${rival.paneID} still leads earlier work in this folder (${rival.program}), so this is a new program of your own. If the user wants you to carry on that work, run \`${shellQuote(cli)} agent promote --take-over ${localPaneRef(rival.paneID)}\` and carry on from its notes; ask them when you cannot tell.`
    : "";
  const tookOver = old ? takeOver(old, record, program) : undefined;
  // The program's name in the user's words: given here, else the coordinator names it once.
  if (params.name !== undefined && params.name !== true && String(params.name).trim()) setProgramName(program, String(params.name).replace(/\s+/g, " ").trim().slice(0, 60));
  const unnamed = !programMeta(program)?.name;
  const naming0 = unnamed
    ? ` Name this program once, from the user's goal in 2-4 words (it shows as "${programName(program)}" until then): \`${shellQuote(cli)} agent name "<name>"\`.`
    : "";
  // Threads from before titles (or a coordinator that left them out): the new one names them once.
  const untitled = threadRows(program).filter(row => !row.meta.title && !row.meta.resolved).map(row => row.task);
  const naming = naming0 + (untitled.length
    ? ` These open threads have no title yet: ${untitled.join(", ")}. Name each once with \`${shellQuote(cli)} agent title <task> "<title>"\` (verb first, 3-6 words, in the user's words).`
    : "");
  // Workers whose coordinator's pane is gone report to this one from now on.
  const adopted = old ? [] : goneCoordinators(program, record, records)
    .flatMap(gone => takeOver({ uuid: gone, program, live: false }, record, program).workers);
  const background = await giveCoordinatorBackground(record.paneID, old?.live ? old.paneID : undefined);
  const protocol = protocolFile();
  if (!protocol) fail(1, "protocolUnavailable", `The agents-coordinator skill's coordinator.md is missing beside ${appControlSkillDirectory() || "the agents-app-control skill"}; reinstall the skills.`);
  // A coordinator before this one, on whatever agent, left its notes in the program: the new one
  // reads them before it acts, and its workers are the program's.
  const fresh = Boolean(params["spawn-id"]) || wasCoordinator;
  const carryOn = notes.coordinatedBefore && !tookOver?.memoryRequested
    ? ` This work was coordinated before you, by an agent that may have run on another harness; it is yours now. Read ${notes.files.join(", ")} and carry on from there, as that coordinator would: the user's goals, decisions and preferences there hold for you too.${adopted.length ? ` Its workers report to you now: ${adopted.join(", ")}.` : ""} \`${shellQuote(cli)} agent status --all --json\` lists the tasks. Do not rebuild that record: no searching earlier sessions, transcripts or git history, no reading every report or re-checking every link.`
    : "";
  if (params.tell) {
    const memory = tookOver?.memoryRequested
      ? ` The coordinator before you writes ${tookOver.memory} and tells you when it is there; wait for that, read it, and do not write it yourself until then.`
      : "";
    const instructions = userInstructions() ? ` The user's own instructions are in ${userInstructionsPath()}; follow them too.` : "";
    // An agent promoted mid-conversation keeps what it knows; one started as coordinator, or put
    // in a coordinator's pane in place of the agent before it, knows only what the program holds.
    const lead = fresh
      ? `You are the coordinator of this work. Read the coordinator protocol at ${protocol} and follow it; open ${overviewFile} beside you and keep it current.`
      : notes.coordinatedBefore
        ? `You are now also the coordinator of this work. Keep all you know and keep answering the user in the language you have been using. Read the coordinator protocol at ${protocol} and follow it from now on; open ${overviewFile} beside you, and add to ${path.join(program, "MEMORY.md")} and ${overviewFile} only what you know that they do not say yet.`
        : `You are now also the coordinator of this work. Keep all you know and keep answering the user in the language you have been using. Read the coordinator protocol at ${protocol} and follow it from now on; first write what you know so far to ${contextFile} and ${overviewFile}, and open ${overviewFile} beside you.`;
    const skill = skillFile() ? ` Everything else the CLI does in the app is in ${skillFile()}.` : "";
    const transcript = tookOver?.previousSession
      ? ` The coordinator before you ran as ${tookOver.previousSession.agent}; its transcript is ${tookOver.previousSession.file}. Read it only where MEMORY.md leaves a gap, and check what either says was done against the repository before you build on it.`
      : "";
    enqueueMessage(program, uuid, `${lead} Program directory: ${program}; run the CLI as ${shellQuote(cli)}. ${asHint(coordinatorCLIName(uuid))}${skill}${instructions}${carryOn}${naming}${elsewhere}${memory}${transcript}`, "You are the coordinator now");
  }
  // The user who made a running agent coordinator is about to talk to it: the line goes in now
  // if the agent waits at its prompt, not a supervisor tick or two later. An agent that has just
  // started, maybe in place of another, gets it from the supervisor once its screen settles.
  const deliveredNow = params.tell && !fresh ? await deliverQueuedNow(program, uuid, record) : undefined;
  if (params.tell || tookOver || adopted.length) ensureSupervisor(program);
  const next = tookOver?.memoryRequested
    ? `The coordinator before you writes ${tookOver.memory} now and tells you with a ⟢ agents line when it is there. Wait for that line and read the file before you act; do not write ${tookOver.memory} yourself until then.`
    : (carryOn + naming + elsewhere).trim() || undefined;
  const handover = tookOver?.previousSession
    ? `The coordinator before you ran as ${tookOver.previousSession.agent}; its transcript is ${tookOver.previousSession.file}. Read it only where MEMORY.md leaves a gap, and check what either says was done against the repository.`
    : undefined;
  notifyApp(record.sessionName);
  return {
    id: requestID("cli"),
    ok: true,
    result: {
      pane,
      role: "coordinator",
      program,
      name: programName(program),
      language,
      context: contextFile,
      overview: overviewFile,
      tookOver,
      adopted: adopted.length ? adopted : undefined,
      background,
      next: [next, handover].filter(Boolean).join(" ") || undefined,
      told: params.tell ? true : undefined,
      delivered: deliveredNow,
      // The agent that ran this reads the protocol here; one told through its prompt reads the file.
      protocol: params.tell ? undefined : protocolText(protocol, program, cli),
      protocolFile: protocol,
      cli,
    },
  };
}

// The protocol again, for a coordinator that lost it: a hook after a compaction prints it.
export async function runAgentProtocol(command) {
  const record = ownCoordinationRecord(command.params, "agent protocol");
  const protocol = protocolFile();
  if (!protocol) fail(1, "protocolUnavailable", `The agents-coordinator skill's coordinator.md is missing beside ${appControlSkillDirectory() || "the agents-app-control skill"}; reinstall the skills.`);
  if (record.role !== "coordinator") {
    return { id: requestID("cli"), ok: true, result: { pane: localPaneRef(record.paneID), role: record.role || null } };
  }
  const program = recordedCoordinatorProgram(record) || coordinatorProgram(record);
  const cli = ensureSharedCLI();
  const language = tmuxPaneOption(record.paneID, LANGUAGE_OPTION) || undefined;
  const notes = programNotes(program).files.filter(file => /\/(MEMORY|CONTEXT)\.md$/.test(file));
  const lead = `You are the coordinator of this work in tmux pane ${record.paneID}; your context was compacted, so here is your protocol again. Run the CLI as ${shellQuote(cli)}. ${asHint(coordinatorCLIName(ensurePaneUUID(record)))}${language ? ` Give your workers --language ${language}.` : ""}${notes.length ? ` What you or a coordinator before you kept is in ${notes.join(" and ")}; read it before you act.` : ""}`;
  return {
    id: requestID("cli"),
    ok: true,
    result: { pane: localPaneRef(record.paneID), role: "coordinator", program, protocolFile: protocol, text: `${lead}\n\n${protocolText(protocol, program, cli)}` },
  };
}

export async function runAgentAdopt(command) {
  const params = command.params;
  const own = ownCoordinationRecord(params, "agent adopt");
  const records = coordinationPaneRecords();
  const target = records.find(record => record.paneID === paneIDFromRef(command.pane));
  if (!target) fail(2, "paneUnavailable", `Could not find pane '${command.pane}' in local tmux.`);
  if (target.paneID === own.paneID) fail(64, "usage", "An agent cannot adopt itself.");
  if (!paneRunsAgent(target).ok) {
    fail(2, "notAnAgent", `Pane ${target.paneID} runs ${target.currentCommand}, not an agent. Start the agent there first, or use 'agent spawn --into ${localPaneRef(target.paneID)}'.`);
  }
  const uuid = ensurePaneUUID(own);
  if (target.parent === uuid) fail(2, "taskExists", `Pane ${target.paneID} is already your worker (task ${target.task}).`);
  // A worker of a coordinator that still runs stays its worker. One whose coordinator's pane is
  // gone, or whose agent has exited, has nobody: the coordinator that replaced it takes it on,
  // whichever program either of them leads.
  const lead = target.parent ? records.find(record => record.uuid === target.parent) : undefined;
  if (lead && !lead.dead && paneRunsAgent(lead).ok) {
    fail(2, "alreadyAWorker", `Pane ${target.paneID} is the worker of the coordinator in pane ${lead.paneID} (task ${target.task}), which still runs. Take that coordinator over with 'agent promote --take-over ${localPaneRef(lead.paneID)}', or ask it to close the task.`);
  }
  const previous = target.parent && target.program && target.task
    ? { program: target.program, task: target.task, coordinator: target.parent }
    : undefined;
  const sub = subWorkerLead(own, params, records, "take on");
  const program = coordinatorProgram(own, params.program);
  if (!own.role) setPaneOption(localPaneRef(own.paneID), "@agents_role", "coordinator");
  // Its task in this program goes on under the same name when the coordinator names it.
  const continues = previous && previous.program === program && params.task === previous.task;
  const task = continues ? previous.task : uniqueTaskName(command.text, records, program, params.task);
  if (previous && !continues) closeAdoptedTask(previous, target, own, program, task);
  const files = taskPaths(program, task);
  const language = coordinatorLanguage(params, own);
  writeBrief(program, task, command.text, own, language);
  writeTaskMeta(program, task, {
    launchCommand: tmuxPaneOption(target.paneID, "@agents_command_launch"),
    cwd: tmuxPaneOption(target.paneID, "@agents_command_cwd"),
    parentUUID: uuid,
    ...(sub ? { parentTask: sub.parentTask } : {}),
    adopted: true,
    ...(params.title !== undefined ? { title: threadTitle(params.title) } : {}),
  });
  const titleCheck = titleWarning(readJSON(files.meta, {}).title);
  const pane = localPaneRef(target.paneID);
  ensureSharedCLI();
  setPaneOption(pane, "@agents_parent", uuid);
  setPaneOption(pane, "@agents_role", "worker");
  setPaneOption(pane, "@agents_task", task);
  const shownTitle = readJSON(files.meta, {}).title;
  if (shownTitle) setPaneOption(pane, "@agents_title", shownTitle);
  else runTMux(["set-option", "-p", "-u", "-t", target.paneID, "@agents_title"]);
  setPaneOption(pane, "@agents_program", program);
  setPaneOption(pane, "@agents_report_state", "started");
  setPaneOption(pane, "@agents_report_at", String(Math.floor(Date.now() / 1000)));
  if (language) setPaneOption(pane, LANGUAGE_OPTION, language);
  noteSubWorker(program, sub, task, command.text);
  // Its pane stays where it is; the line reaches it once it is idle.
  enqueueMessage(program, ensurePaneUUID(target), `ROLE: worker. The coordinator in pane ${own.paneID} takes you on for task "${task}". Read your brief at ${files.brief} and do the task. ${languageSentence(language)} Report with: ${shellQuote(files.cli)} agent report "<one-line status>" --done (or --blocked, --ask user); ask your coordinator with ${shellQuote(files.cli)} agent ask "<question>".`, `You are a worker on task "${task}"`);
  const background = await inheritCoordinatorBackground(own.paneID, pane);
  ensureSupervisor(program);
  notifyApp(own.sessionName);
  if (target.sessionName !== own.sessionName) notifyApp(target.sessionName);
  const from = previous ? { program: previous.program, task: previous.task, coordinator: previous.coordinator } : undefined;
  return { id: requestID("cli"), ok: true, result: { task, pane, program, brief: files.brief, background, from, ...titleCheck } };
}

// The task a worker had under a coordinator that is gone ends where the next one adopts it: its
// report says where it went, so neither program's supervisor takes the move for a closed pane.
export function closeAdoptedTask(previous, target, own, program, task) {
  const files = taskPaths(previous.program, previous.task);
  if (!fs.existsSync(files.dir)) return;
  const report = readJSON(files.reportJSON, { task: previous.task, line: "Adopted without a report.", outputs: [], history: [] });
  if (report.state !== "done") report.state = closedReportState(report);
  report.updatedAt = new Date().toISOString();
  const where = program === previous.program ? `task ${task}` : `task ${task} of ${program}`;
  report.history = [...(report.history || []), { at: report.updatedAt, state: report.state, line: `Its coordinator was gone; the coordinator in pane ${own.paneID} adopted it as ${where}.`, by: "coordinator" }].slice(-50);
  writeTaskReport(files, report);
  if (target.uuid) closeOpenQuestions(previous.program, target.uuid, "its coordinator was gone");
  writeStatusFile(previous.program);
}

export async function runAgentRespawn(command, currentSocketPath) {
  const params = command.params;
  const own = ownCoordinationRecord(params, "agent respawn");
  const program = params.program || own.program;
  if (!program) fail(2, "noProgram", "This pane belongs to no program; pass --program.");
  const files = taskPaths(program, command.task);
  const meta = readJSON(files.meta, undefined);
  if (!meta || !fs.existsSync(files.brief)) fail(2, "taskUnavailable", `No brief for task '${command.task}' in ${program}.`);
  const records = coordinationPaneRecords();
  const running = records.find(record => record.task === command.task && record.program === program);
  // A worker whose agent never started is finished in its own pane with --into.
  if (running && running.paneID !== paneIDFromRef(params.into) && !params["dry-run"]) {
    if (!params.replace) {
      fail(2, "taskRunning", `Task '${command.task}' still runs in ${running.paneID}. Pass --replace to close that pane first, or --into ${localPaneRef(running.paneID)} if its agent never started.`);
    }
    // The supervisor must not take the gap until the new pane for a worker that closed early.
    writeFileAtomic(respawnMarker(program, command.task), `${Date.now()}\n`);
    runTMuxRequired(["kill-pane", "-t", running.paneID], "tmux kill-pane");
  }
  const parent = records.find(record => record.uuid === meta.parentUUID) || own;
  // The earlier worker's transcript: from its pane while it is there, else as its last report
  // recorded it.
  const since = Date.parse(meta.createdAt || "") || 0;
  const transcriptOf = transcriptLookup();
  const listed = readSessionLines(sessionsFile(program, command.task)).reverse()
    .map(session => ({ agent: session.agent, sessionId: session.session, file: transcriptOf(session.agent, session.session, session.cwd) }))
    .find(session => session.file);
  const previousSession = [running && agentSessionFile(running.paneID, since), readJSON(files.reportJSON, {}).session, listed]
    .find(session => session?.file && fs.existsSync(session.file));
  return runAgentSpawn({
    prompt: "",
    params: { ...params, pane: params.pane || localPaneRef(parent.paneID), parent: localPaneRef(parent.paneID) },
    respawn: { task: command.task, program, launchCommand: meta.launchCommand, cwd: meta.cwd, model: meta.model, previousSession: previousSession?.file && fs.existsSync(previousSession.file) ? previousSession : undefined },
  }, currentSocketPath);
}

export function respawnMarker(program, task) {
  return path.join(taskPaths(program, task).dir, ".respawning");
}

export function isRespawning(program, task) {
  try {
    return Date.now() - fs.statSync(respawnMarker(program, task)).mtimeMs < 120000;
  } catch {
    return false;
  }
}

// Reminders and watches. They live as files in <program>/.watches, so the supervisor (which
// stays alive while there are any) can act on them after a restart, and each ends with one
// self-contained ⟢ agents line for the agent that asked.
