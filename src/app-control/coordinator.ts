// @ts-nocheck
// Coordinators: backgrounds, the protocol, starter files and taking over.

import { appControlSkillDirectory } from "./self.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentSessionFile } from "./agent-state.js";
import { socketPath } from "./app-socket.js";
import { ensureSharedCLI, taskRows } from "./briefs.js";
import { shellQuote } from "./launch.js";
import { enqueueMessage } from "./messages.js";
import { fail, usage } from "./output.js";
import { localPaneRef, paneIDFromRef, runTMux, setPaneOption, tmuxPaneOption, unsetPaneOption } from "./panes.js";
import { SPAWN_ID_OPTION, sleep, spawnTimeoutMs } from "./placement.js";
import { paneRunsAgent } from "./processes.js";
import { coordinationPaneRecords, coordinatorLeads, ensurePaneUUID, notifyApp, programsRoot, recordedCoordinatorProgram, writeFileAtomic } from "./program.js";
import { isPaneRefText } from "./send.js";
import { appRequestIfRunning } from "./supervisor.js";
import { readFileOr } from "./supervisor-control.js";
import { getUserInstructionsPath } from "../paths.js";

// A worker takes its coordinator's terminal background, so it is seen as that coordinator's.
export function paneBackgroundStyle(paneID) {
  const encoded = tmuxPaneOption(paneID, "@agents_view");
  if (!encoded) return undefined;
  try {
    const style = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).terminalBackgroundStyleID;
    return style && style !== "default" ? style : undefined;
  } catch {
    return undefined;
  }
}

// A new coordinator wears a background nobody else does, which its workers then take, so its
// work stands apart from the rest. One taking over wears its predecessor's, which the workers
// already have. The app picks the color: it knows the palette and every pane's background.
export async function giveCoordinatorBackground(paneID, predecessorPaneID) {
  const inherited = predecessorPaneID ? paneBackgroundStyle(predecessorPaneID) : undefined;
  const result = await appRequestIfRunning("control.invoke", { id: "pane.set-terminal-background", pane: localPaneRef(paneID), style: inherited || "unused" });
  if (!result) return undefined;
  return inherited || JSON.stringify(result).match(/style=([A-Za-z]+)/)?.[1];
}

export async function inheritCoordinatorBackground(coordinatorPaneID, workerPane) {
  const style = paneBackgroundStyle(coordinatorPaneID);
  if (!style) return undefined;
  // Without the app the worker keeps the default background. A pane the app has only just
  // placed can be refused for a moment.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await appRequestIfRunning("control.invoke", { id: "pane.set-terminal-background", pane: localPaneRef(workerPane), style });
    if (result) return style;
    if (!fs.existsSync(socketPath())) return undefined;
    await sleep(300);
  }
  return undefined;
}

// The skill that describes the whole CLI, for coordinators and workers to look up: the
// agents-app-control skill whose launcher ran this command.
export function skillFile() {
  const directory = appControlSkillDirectory();
  return directory ? path.join(directory, "SKILL.md") : undefined;
}

// The protocol a coordinator follows, in the agents-coordinator skill beside this one (in the
// app bundle or the repository, wherever the user linked the skills from).
export function protocolFile() {
  const directory = appControlSkillDirectory();
  if (!directory) return undefined;
  const file = path.resolve(directory, "..", "agents-coordinator", "coordinator.md");
  return fs.existsSync(file) ? file : undefined;
}

export function protocolText(file, program, cli) {
  const text = readFileOr(file, "")
    .replace(/`agents-app-control /g, `\`${shellQuote(cli)} `)
    .replace(/<program>/g, program);
  const instructions = userInstructions();
  return instructions ? `${text.trimEnd()}\n\n## The user's instructions\n\n${instructions}\n` : text;
}

// What the user wants every coordinator and worker to know, whatever the program: language,
// conventions, tone. The app's Settings edits the same file.
export function userInstructionsPath() {
  return getUserInstructionsPath();
}

export function userInstructions() {
  return readFileOr(userInstructionsPath(), "").trim();
}

// What the user sees beside the coordinator; the coordinator fills it in and keeps it current.
export function starterOverview() {
  return [
    "# Overview",
    "",
    "<!-- In the user's language, to them. An executive summary first: where the work stands and",
    "every next step for them, with its link, not only blockers. Then one short section per task,",
    "most important first:",
    "",
    "## Needs you",
    "",
    "Login is fixed and in review; logout is done. Next for you:",
    "",
    "- Merge [auth-api !70](https://gitlab.example.com/group/auth-api/-/merge_requests/70), then rotate the Okta token",
    "- Review [repo !45](https://gitlab.example.com/group/repo/-/merge_requests/45), the SSO redirect fix",
    "- Try login on staging once the [deploy pipeline](https://gitlab.example.com/group/repo/-/pipelines/9876) is green",
    "- Decide whether [Validate return URLs](http://127.0.0.1:9000/#/issue/bd-a1b2) comes before the release",
    "",
    "## fix-login: working",
    "",
    "Login lands on the start page after SSO; the redirect URL loses its return path.",
    "",
    "- [PROJ-123](https://jira.example.com/browse/PROJ-123)",
    "- [repo !45](https://gitlab.example.com/group/repo/-/merge_requests/45): 1 of 2 approvals",
    "- [repo !44](https://gitlab.example.com/group/repo/-/merge_requests/44): merged, [deploy pipeline](https://gitlab.example.com/group/repo/-/pipelines/9876) running",
    "- [Validate return URLs](http://127.0.0.1:9000/#/issue/bd-a1b2): open",
    "",
    "## fix-logout: done",
    "-->",
    "",
  ].join("\n");
}

export function starterContext(record) {
  const cwd = tmuxPaneOption(record.paneID, "@agents_command_cwd")
    || runTMux(["display-message", "-p", "-t", record.paneID, "#{pane_current_path}"]);
  return [
    "# Context",
    "",
    "What every worker in this program needs before its brief: the goal, where the work is",
    "(repositories, branches, hosts), conventions and constraints, and who decides what. The",
    "coordinator keeps it current; briefs point here instead of repeating it.",
    "",
    ...(cwd ? [`Working directory: ${cwd}`, ""] : []),
  ].join("\n");
}

export async function waitForSpawnedRecord(spawnID) {
  const deadline = Date.now() + spawnTimeoutMs();
  while (Date.now() < deadline) {
    const output = runTMux(["list-panes", "-a", "-F", `#{pane_id}\t#{${SPAWN_ID_OPTION}}`]) || "";
    const paneID = output.split(/\r?\n/).map(line => line.split("\t")).find(([, id]) => id === spawnID)?.[0];
    const record = paneID && coordinationPaneRecords().find(candidate => candidate.paneID === paneID);
    if (record) return record;
    await sleep(200);
  }
  fail(1, "spawnTimedOut", `No pane with spawn id '${spawnID}' appeared.`);
}

// The program directories under ~/.agents/programs, for a coordinator whose pane is gone.
export function programDirectories() {
  const dir = programsRoot();
  try {
    return fs.readdirSync(dir).map(name => path.join(dir, name)).filter(candidate => fs.statSync(candidate).isDirectory());
  } catch {
    return [];
  }
}

// The coordinator to take over: a live pane (by pane, task or @agents_uuid), or one whose pane is
// gone, by the @agents_uuid its workers' task records name. Only a coordinator can be taken over;
// anything else fails here, before promote changes a pane, a queue or a task.
export function coordinatorToTakeOver(reference, record, explicitProgram) {
  const records = coordinationPaneRecords();
  const old = isPaneRefText(reference)
    ? records.find(candidate => candidate.paneID === paneIDFromRef(reference))
    : records.find(candidate => candidate.task === reference && (!explicitProgram || candidate.program === explicitProgram))
      || records.find(candidate => candidate.task === reference)
      || records.find(candidate => candidate.uuid && candidate.uuid === reference.toLowerCase());
  if (old) {
    if (old.paneID === record.paneID) fail(64, "usage", "A coordinator cannot take over from itself.");
    const name = `Pane ${old.paneID}${old.task ? ` (task ${old.task})` : ""}`;
    const program = old.uuid ? recordedCoordinatorProgram(old, records) : old.program;
    const leads = Boolean(old.uuid) && (records.some(candidate => candidate.parent === old.uuid)
      || (program && taskRows(program).some(row => row.meta.parentUUID === old.uuid)));
    if (old.role !== "coordinator" && !leads) {
      const parent = old.parent && records.find(candidate => candidate.uuid === old.parent);
      const hint = !parent ? ""
        : parent.paneID === record.paneID ? " It is your own worker."
          : ` Its coordinator is in pane ${parent.paneID}: agent promote --take-over ${localPaneRef(parent.paneID)}.`;
      fail(2, "notACoordinator", `${name} is ${old.parent ? "a worker" : "no coordinator"} with no workers of its own, so there is nothing to take over. Nothing was changed.${hint}`);
    }
    if (explicitProgram && program && program !== explicitProgram) {
      fail(2, "programMismatch", `${name} coordinates ${program}, not ${explicitProgram}. Nothing was changed. Leave out --program to take over ${program} with it.`);
    }
    ensurePaneUUID(old);
    return { ...old, program, live: !old.dead && paneRunsAgent(old).ok };
  }
  if (isPaneRefText(reference)) fail(2, "paneUnavailable", `Could not find pane '${reference}' in local tmux. Nothing was changed.`);
  // A coordinator whose pane is gone, named by its @agents_uuid: the program whose tasks it started.
  const programs = (explicitProgram ? [explicitProgram] : programDirectories())
    .filter(candidate => taskRows(candidate).some(row => row.meta.parentUUID === reference));
  if (programs.length === 1) return { uuid: reference, program: programs[0], live: false };
  if (programs.length > 1) {
    fail(2, "programAmbiguous", `Coordinator ${reference} started tasks in ${programs.join(" and ")}. Nothing was changed. Pass --program to choose one.`);
  }
  fail(2, "paneUnavailable", `No coordinator '${reference}' to take over: name its pane, its task, or the @agents_uuid in its workers' task.json. Nothing was changed.`);
}

export function takeOver(old, record, program) {
  const pane = localPaneRef(record.paneID);
  const workers = [];
  for (const worker of coordinationPaneRecords()) {
    if (worker.parent !== old.uuid || worker.paneID === record.paneID) continue;
    setPaneOption(localPaneRef(worker.paneID), "@agents_parent", record.uuid);
    workers.push(worker.task || localPaneRef(worker.paneID));
    notifyApp(worker.sessionName);
  }
  for (const row of taskRows(program)) {
    if (row.meta.parentUUID !== old.uuid || row.task === record.task) continue;
    writeFileAtomic(row.files.meta, `${JSON.stringify({ ...row.meta, parentUUID: record.uuid }, null, 2)}\n`);
  }
  // A worker that takes over from its own coordinator is nobody's worker any more.
  if (record.parent === old.uuid) {
    unsetPaneOption(pane, "@agents_parent");
    record.parent = undefined;
  }
  // Lines still waiting for the old coordinator are for the new one.
  const oldQueue = path.join(program, ".queue", old.uuid);
  const newQueue = path.join(program, ".queue", record.uuid);
  try {
    const waiting = fs.readdirSync(oldQueue).filter(name => name.endsWith(".txt"));
    fs.mkdirSync(newQueue, { recursive: true });
    for (const name of waiting) fs.renameSync(path.join(oldQueue, name), path.join(newQueue, name));
  } catch {
    // Nothing queued.
  }
  const memory = path.join(program, "MEMORY.md");
  // The old coordinator's pane, if it is still there, coordinates no more: with its agent still
  // running, or with only the shell its agent left behind.
  const oldRecord = old.paneID ? old : coordinationPaneRecords().find(candidate => candidate.uuid === old.uuid && !candidate.dead);
  const previousSession = oldRecord?.paneID ? agentSessionFile(oldRecord.paneID) : undefined;
  if (oldRecord && !oldRecord.dead && oldRecord.role === "coordinator") {
    const oldPane = localPaneRef(oldRecord.paneID);
    if (oldRecord.task && oldRecord.parent) setPaneOption(oldPane, "@agents_role", "worker");
    else unsetPaneOption(oldPane, "@agents_role");
    notifyApp(oldRecord.sessionName);
  }
  if (old.live) {
    const oldCLI = ensureSharedCLI();
    enqueueMessage(program, old.uuid, `The agent in pane ${record.paneID} takes over as coordinator of ${program}; your workers report to it from now on. Bring ${memory} up to date for it, under these headings: Next task; Decisions (with the approaches you rejected, and why); Files; Current state (what each worker does and why); Open questions and risks. Then tell it with: ${shellQuote(oldCLI)} agent send "MEMORY.md is written" --to ${record.uuid}`, `Pane ${record.paneID} takes over as coordinator`);
    notifyApp(old.sessionName);
  }
  return {
    from: old.live ? localPaneRef(old.paneID) : old.uuid,
    workers,
    memory,
    memoryRequested: old.live,
    previousSession,
  };
}

// The coordinators of `program` whose panes are gone but whose workers or tasks remain: a new
// coordinator of the program takes them on, so switching the coordinator's agent (Kiro for Codex,
// in a new pane) leaves no worker without one.
export function goneCoordinators(program, record, records) {
  const live = new Set(records.filter(candidate => candidate.uuid && !candidate.dead
    && (candidate.role !== "coordinator" || coordinatorLeads(candidate))).map(candidate => candidate.uuid));
  const parents = new Set([
    ...records.filter(candidate => candidate.program === program && candidate.parent).map(candidate => candidate.parent),
    ...taskRows(program).map(row => row.meta.parentUUID).filter(Boolean),
  ]);
  return [...parents].filter(uuid => uuid !== record.uuid && !live.has(uuid));
}

// What a coordinator left for the next one, whatever agent it ran on: the notes in the program.
export function programNotes(program) {
  const memory = path.join(program, "MEMORY.md");
  const notes = [memory, path.join(program, "CONTEXT.md"), path.join(program, "OVERVIEW.md"), path.join(program, "STATUS.md")]
    .filter(file => fs.existsSync(file));
  // Promote writes OVERVIEW.md, so a program that has one had a coordinator.
  const coordinatedBefore = fs.existsSync(memory) || fs.existsSync(path.join(program, "OVERVIEW.md")) || taskRows(program).length > 0;
  return { coordinatedBefore, files: notes };
}
