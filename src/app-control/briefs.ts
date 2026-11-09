// @ts-nocheck
// The shared CLI, worker prompts, briefs, task files and status files.

import { appControlArgv } from "./self.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { skillFile, userInstructions } from "./coordinator.js";
import { shellQuote } from "./launch.js";
import { queuedNotes } from "./messages.js";
import { fail, usage } from "./output.js";
import { localPaneRef, resolveLocalSourcePane, setPaneOption, tmuxPaneOption } from "./panes.js";
import { sleep } from "./placement.js";
import { oneLine } from "./processes.js";
import { readJSON, taskPaths, writeFileAtomic } from "./program.js";
import { subWorkerLead } from "./spawn-support.js";
import { readFileOr } from "./supervisor-control.js";
import { getSharedAppControlPath } from "../paths.js";

// Settings the shared command keeps as they were where it was written, so an agent whose
// harness runs commands with another environment still reaches this app instance.
export const PINNED_ENVIRONMENT = [
  "AGENTS_PRODUCT_DIRNAME", "AGENTS_HOME", "AGENTS_SHARED_HOME", "AGENTS_STATE_DIR", "TMUX_TMPDIR",
  "AGENTS_APP_RUNTIME_DIR", "AGENTS_APP_SOCKET_PATH", "AGENTS_APP_TOKEN_PATH", "AGENTS_APP_CONTROL_TOKEN_PATH",
  "AGENTS_APP_AGENTS_BIN", "AGENTS_APP_CONFIG_PATH", "AGENTS_APP_CONTROL_SKILL_DIR",
];

// Every coordinator and worker runs the CLI by one path, ~/.agents/<suite>/bin/agents-app-control:
// the CLI finds the agent that runs it by its process tree (see resolveLocalSourcePane), so no
// agent needs a script of its own. Each app instance (suite) has its own.
export function sharedCLIPath() {
  return getSharedAppControlPath();
}

export function coordinatorCLIName(uuid) {
  return `coordinator-${String(uuid).slice(0, 8)}`;
}

export function ensureSharedCLI() {
  const lines = [
    "#!/bin/sh",
    "# agents-app-control for every agent of this app instance; it finds the agent that runs it by itself.",
    ...PINNED_ENVIRONMENT.filter(name => process.env[name] !== undefined).map(name => `export ${name}=${shellQuote(process.env[name])}`),
    `export AGENTS_APP_CONTROL_ENTRY=${shellQuote(sharedCLIPath())}`,
    `exec ${appControlArgv().map(shellQuote).join(" ")} "$@"`,
  ];
  const file = sharedCLIPath();
  const contents = `${lines.join("\n")}\n`;
  if (readFileOr(file, undefined) !== contents) {
    writeFileAtomic(file, contents);
    fs.chmodSync(file, 0o755);
  }
  return file;
}

// What an agent adds to a command when the CLI cannot see its pane (Codex on the shared daemon).
export function asHint(name) {
  return `It finds your pane by itself; should it ever say it cannot tell which agent you are, add --as ${name}.`;
}

// The language the user talks in, which a coordinator's workers talk to them in too. The
// coordinator names it (`--language`), and its pane keeps it for later workers.
export const LANGUAGE_OPTION = "@agents_language";

export function coordinatorLanguage(params, coordinatorRecord) {
  const given = params.language === undefined ? "" : oneLine(params.language, 40);
  if (params.language !== undefined && !given) fail(64, "usage", "--language needs a language, e.g. --language Swedish.");
  if (!coordinatorRecord) return given || undefined;
  if (given && !params["dry-run"]) setPaneOption(localPaneRef(coordinatorRecord.paneID), LANGUAGE_OPTION, given);
  return given || tmuxPaneOption(coordinatorRecord.paneID, LANGUAGE_OPTION) || undefined;
}

export function languageSentence(language) {
  return language
    ? `Talk to the user in ${language}.`
    : "Talk to the user in the language they write to you in.";
}

export function workerPrompt(task, files, parentRecord, isRespawn, language, previousSession) {
  const transcript = previousSession ? ` Its ${previousSession.agent} transcript is ${previousSession.file}: read the parts the report leaves open.` : "";
  const lead = isRespawn
    ? `ROLE: worker. You take over task "${task}" from an earlier worker. Read your brief at ${files.brief} and the earlier worker's report at ${files.report}, then continue from there.${transcript} Check what the report${previousSession ? " and the transcript" : ""} say was done against the repository before you build on it.`
    : `ROLE: worker. You were started by a coordinator for task "${task}". Read your brief at ${files.brief} and do the task.`;
  return `${lead} ${languageSentence(language)} Report with: ${shellQuote(files.cli)} agent report "<one-line status>" --done (or --blocked, --ask user); ask your coordinator with ${shellQuote(files.cli)} agent ask "<question>".`;
}

// When a worker may lead sub-workers of its own, and how (subWorkerLead enforces the rules).
export function workerSubWorkerLines(cli) {
  return [
    "## Sub-workers",
    "",
    "When your task splits into parts that can run at the same time, you may lead sub-workers of",
    "your own instead of doing every part yourself. Do it only when all of these hold:",
    "",
    "- The parts are independent: none needs another's result, and no two touch the same files.",
    "- Each part is substantial (well over half an hour of work for one agent), so running them",
    "  side by side saves real time.",
    "- You can say exactly what each one does and what it hands back.",
    "",
    "Not for searching or reading code, small tasks, or steps that must land as one change: do",
    "those yourself. Each sub-worker reads its context from scratch and costs as much as you do.",
    "",
    "Ask the user first, with one plan, and end your turn:",
    "",
    `    ${cli} agent report "<how many sub-workers, what each does, which files it touches>" --ask user`,
    "",
    "Start them only once they say yes, each with a brief that stands on its own:",
    "",
    `    ${cli} agent spawn "<brief>" --task <name> --approved`,
    "",
    "Without `--approved` the spawn is refused; sub-workers start no workers of their own. They",
    "report to you, not to your coordinator: their done, blocked and questions wake you, `agent",
    "status` lists them and `agent send --to <task>` reaches them. Work on your own part meanwhile,",
    "or end your turn: a turn you end while they still work is no stop. When they are done, check",
    "and combine their work, close them (`agent close --done`), and only then report your task",
    "done. Your coordinator is told when you start one, but does not follow them.",
  ];
}

export function subWorkerBriefLines(parentTask) {
  return [
    "## Sub-worker",
    "",
    `Worker ${parentTask} started you for part of its task. You report to it, not to the coordinator`,
    "above it, and you start no workers of your own: when your part turns out too big for one",
    `agent, say so to ${parentTask} with \`agent ask\`.`,
  ];
}

export function writeBrief(program, task, text, parentRecord, language) {
  const files = taskPaths(program, task);
  ensureSharedCLI();
  const cli = shellQuote(files.cli);
  const guardrailsPath = path.join(program, "guardrails.md");
  const guardrails = fs.existsSync(guardrailsPath) ? fs.readFileSync(guardrailsPath, "utf8").trim() : "";
  const contextPath = path.join(program, "CONTEXT.md");
  // A worker's own worker: its coordinator is that worker (subWorkerLead).
  const underWorker = parentRecord.role === "worker" && parentRecord.task;
  const lines = [
    `# Task: ${task}`,
    "",
    underWorker
      ? `Started ${new Date().toISOString()} by worker ${parentRecord.task} in tmux pane ${parentRecord.paneID}, for part of its task; it is your coordinator.`
      : `Started ${new Date().toISOString()} by the coordinator in tmux pane ${parentRecord.paneID}${parentRecord.task ? ` (task ${parentRecord.task})` : ""}.`,
    `Program directory: ${program}${fs.existsSync(contextPath) ? ` (read CONTEXT.md there for background)` : ""}.`,
    "",
    "## Brief",
    "",
    String(text).trim(),
    "",
    "## Talking to the user",
    "",
    `${languageSentence(language)} That covers your questions (\`--ask user\`), your summaries and`,
    "anything else you write in your pane for them. Code, commits, file contents, briefs and reports",
    "for the coordinator follow the repository's conventions (English unless told otherwise).",
    "",
    "The user reads your work in your pane, not through your coordinator: when you finish, explain",
    "there what you found, what you changed and what is left, in as much detail as they need. Your",
    "coordinator passes on only your status and at most a sentence on your result.",
    "",
    "## Reporting",
    "",
    "Your coordinator does not watch your terminal. It reads your report, and it is woken when you",
    "report done, blocked, or a question for it. Report one short line that stands on its own, with:",
    "",
    `    ${cli} agent report "<status>" [--done | --blocked | --ask user]`,
    "",
    asHint(task),
    "",
    "- `--done`: the deliverable is ready, e.g. \"Fixed the token refresh; MR !123 is open\". Add",
    "  `--output <url or file>` for each thing you produced.",
    "- `--blocked`: you cannot go on, and why.",
    "- `--ask user`: a question for the person you work for. The app shows it on your row and",
    "  notifies them; they answer in your terminal.",
    "- No flag: progress. It wakes nobody.",
    "",
    "When your tools include the `agents` MCP tools (report, ask, send, status, delivery), use them",
    "instead of these commands: they do the same, and work where your shell cannot run the CLI (a",
    "sandbox that denies tmux). Otherwise use the CLI as shown here.",
    "",
    "Ask your coordinator a question with:",
    "",
    `    ${cli} agent ask "<question>" [--timeout 50]`,
    "",
    "It waits for the answer (50 s unless `--timeout` says otherwise, at most 10m) and prints it, so",
    "you go on in the same turn; give the shell command a timeout longer than that. Exit status 4",
    "means no answer came in time: the question stays open and the answer arrives in your prompt.",
    "Go on with what does not depend on it, or end your turn. (`agent report --ask coordinator`",
    "asks without waiting.)",
    "",
    "A message from your coordinator (a `⟢ agents` line) is work: when it is done or blocked, report",
    "again, also after an earlier done. Answering only in your pane leaves your coordinator waiting.",
    "",
    "The user may also write to you in your pane. Answer them there, and report again only when the",
    "task as a whole is done or blocked, not after each answer. Turns the user drives in your pane",
    "do not wake your coordinator; it hears of them with its next message.",
    "",
    "For a longer write-up (findings, evidence, what you verified and what you did not), write it to",
    "a file and add `--details-file <file>`; it goes into your report. A report.md you write yourself is",
    "kept; the report then goes to summary.md beside it. Messages for you arrive in your",
    "prompt as one line that starts with `⟢ agents` and names a file: read that file, it holds the",
    "messages; answer your coordinator with",
    `\`${cli} agent send "<text>" --to parent\`. Add \`--no-wake\` to information it needs only`,
    "with its next message: it then wakes nobody.",
    "",
    "## Waiting",
    "",
    "Never wait through the model: no `sleep` or polling loops in your shell. To wait for a deploy,",
    "CI, a time or a condition, set one of these and end your turn; its line wakes you in your prompt:",
    "",
    `    ${cli} agent watch --poll "<check>" --every 2m --until change`,
    `    ${cli} agent watch --cmd "<script that exits on completion or failure>"`,
    `    ${cli} agent remind "<what to check>" --in 20m`,
    "",
    "If you must check within your turn, keep the checks under 4 minutes apart. Why: the model's",
    "prompt cache lasts 5 minutes, and a call after a longer gap pays about ten times as much to",
    "read your whole context again.",
    "",
    ...(underWorker ? subWorkerBriefLines(parentRecord.task) : workerSubWorkerLines(cli)),
  ];
  const skill = skillFile();
  if (skill) {
    lines.push(
      "",
      "## The app",
      "",
      `You run in the Agents Next app. ${skill} describes what else its CLI can do, run as ${cli}:`,
      "open a file or preview for the user, split a pane, start a browser and more.",
    );
  }
  const instructions = userInstructions();
  if (instructions) {
    lines.push("", "## The user's instructions", "", instructions);
  }
  if (guardrails) {
    lines.push("", "## Guardrails", "", guardrails);
  }
  writeFileAtomic(files.brief, `${lines.join("\n")}\n`);
}

export function writeTaskMeta(program, task, meta) {
  const files = taskPaths(program, task);
  const existing = readJSON(files.meta, {});
  writeFileAtomic(files.meta, `${JSON.stringify({
    task,
    createdAt: existing.createdAt || new Date().toISOString(),
    ...meta,
    spawns: (existing.spawns || 0) + 1,
  }, null, 2)}\n`);
}

export function renderReport(report) {
  const lines = [
    `# ${report.task}: ${report.state}`,
    "",
    report.line,
    "",
    `Updated: ${report.updatedAt}`,
  ];
  if (report.outputs?.length) {
    lines.push("", "## Outputs", "", ...report.outputs.map(output => `- ${output}`));
  }
  if (report.details) {
    lines.push("", "## Details", "", report.details.trim());
  }
  if (report.history?.length > 1) {
    lines.push("", "## History", "", ...report.history.map(entry => `- ${entry.at} ${entry.state}: ${entry.line}`));
  }
  return `${lines.join("\n")}\n`;
}

// report.md is the rendering of report.json until the worker writes a report.md of its own, as a
// brief may ask: that one is kept, and the rendering goes to summary.md instead. Returns the file
// the rendering went to.
export function writeTaskReport(files, report) {
  const hash = text => crypto.createHash("sha1").update(text).digest("hex");
  const previous = readJSON(files.reportJSON, {});
  const current = readFileOr(files.report, undefined);
  const rendered = renderReport(report);
  const workersOwn = current !== undefined && hash(current) !== previous.renderedHash;
  const target = workersOwn ? files.summary : files.report;
  report.renderedHash = workersOwn ? previous.renderedHash : hash(rendered);
  writeFileAtomic(files.reportJSON, `${JSON.stringify(report, null, 2)}\n`);
  writeFileAtomic(target, rendered);
  return target;
}

export function taskRows(program) {
  const tasksDir = path.join(program, "tasks");
  let names = [];
  try {
    names = fs.readdirSync(tasksDir).filter(name => fs.statSync(path.join(tasksDir, name)).isDirectory());
  } catch {
    return [];
  }
  return names.map(name => {
    const files = taskPaths(program, name);
    return { task: name, files, meta: readJSON(files.meta, {}), report: readJSON(files.reportJSON, undefined) };
  });
}

export function writeStatusFile(program) {
  const rows = taskRows(program)
    .sort((a, b) => String(b.report?.updatedAt || b.meta.createdAt || "").localeCompare(String(a.report?.updatedAt || a.meta.createdAt || "")));
  const lines = [
    "# Status",
    "",
    "Generated by agents-app-control from the task reports; edits are overwritten.",
    "",
    "| Task | State | Status | Updated |",
    "| --- | --- | --- | --- |",
    ...rows.map(row => `| ${row.task}${row.meta.parentTask ? ` (under ${row.meta.parentTask})` : ""} | ${row.report?.state || "started"} | ${(row.report?.line || "").replace(/\|/g, "\\|")} | ${row.report?.updatedAt || row.meta.createdAt || ""} |`),
  ];
  let targets = [];
  try {
    targets = fs.readdirSync(path.join(program, ".queue")).filter(name => !name.startsWith("."));
  } catch {
    targets = [];
  }
  const notes = targets.flatMap(uuid => queuedNotes(program, uuid).map(note => note.entry));
  if (notes.length > 0) {
    lines.push(
      "",
      "## Not yet told to the coordinator",
      "",
      "Turns the user drove in a worker's pane; the coordinator gets these with its next line.",
      "",
      ...notes.map(note => `- ${note.at} ${note.text}`),
    );
  }
  writeFileAtomic(path.join(program, "STATUS.md"), `${lines.join("\n")}\n`);
}
