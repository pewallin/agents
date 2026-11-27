// @ts-nocheck
// A coordinator run that starts fresh (T6): its live session goes on while it is warm (its last
// turn under an hour ago, its context under half, conversation.ts nextRunStart); otherwise the
// event that wakes it starts a new session in its pane, from its conversation, OVERVIEW.md,
// MEMORY.md, the open threads and the event: the take-over and promote handover as the normal
// path. How the run started goes into its turn's details (`how`), never into the conversation.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentSessionFile, agentsCLI } from "./agent-state.js";
import { coordinatorStartMessage } from "./promote.js";
import { noteNextRun, nextRunStart, readThread } from "./conversation.js";
import { asHint, coordinatorCLIName, ensureSharedCLI } from "./briefs.js";
import { protocolFile, skillFile, userInstructions, userInstructionsPath } from "./coordinator.js";
import { shellQuote } from "./launch.js";
import { enqueueMessage } from "./messages.js";
import { oneLine } from "./processes.js";
import { programName, readJSON, writeFileAtomic } from "./program.js";
import { threadRows } from "./threads.js";

/** What the new session reads first beside its notes: the conversation's end and the open threads. */
export function freshContext(program, limit = 20) {
  const entries = readThread(program, { withReplies: true }).slice(-limit);
  const said = entries.map(entry => entry.kind === "message"
    ? `- ${entry.at.slice(0, 16).replace("T", " ")} The user: ${oneLine(entry.text, 1200)}`
    : `- ${entry.at.slice(0, 16).replace("T", " ")} You${entry.wokeBy ? ` (woken: ${entry.wokeBy})` : ""}: ${entry.reply ? oneLine(entry.reply, 1200) : "(no answer)"}`);
  // Each open thread with where its worker last stood, so the new session knows its workers
  // before it runs `agent status` (which has them live).
  const open = threadRows(program).filter(row => !row.meta.resolved).map(row => {
    const state = row.report?.state || "started";
    const line = row.report?.line ? `: "${oneLine(row.report.line, 300)}"` : "";
    return `- ${row.task}: ${row.meta.title || row.task} (${state}${row.report?.updatedAt ? ` ${row.report.updatedAt.slice(0, 16).replace("T", " ")}` : ""}${line})`;
  });
  return [
    "# Where the conversation stands",
    "",
    "Your conversation with the user is kept in thread.jsonl; its last entries:",
    "",
    ...(said.length ? said : ["- (nothing yet)"]),
    "",
    "## Open threads",
    "",
    "Each with its latest report; `agent status --json` has your workers as they are now.",
    "",
    ...(open.length ? open : ["- (none)"]),
    "",
  ].join("\n");
}

/**
 * Before a wake is typed into a coordinator: starts its run fresh when its session is cold. Returns
 * true when it started a new session (the wake waits for it), false to go on in the live session.
 */
export function startFreshRunIfCold(program, record, status, log = () => {}) {
  if (record.role !== "coordinator" || !record.paneID) return false;
  // A start is queued already: this run is starting fresh.
  const dir = path.join(program, ".queue", record.uuid);
  const queued = (() => { try { return fs.readdirSync(dir).filter(name => name.endsWith(".txt")).sort(); } catch { return []; } })();
  if (queued.some(name => readJSON(path.join(dir, name), {})?.event?.kind === "start")) return false;
  const how = nextRunStart(program, status?.sessionId ? { session: status.sessionId, context: typeof status.contextUsed === "number" ? status.contextUsed / 100 : undefined } : undefined);
  if (how.start !== "fresh") return false;
  // Without a session the pane's agent has not reported one yet: it is not cold, only new.
  if (!status?.sessionId) return false;
  const protocol = protocolFile();
  if (!protocol) return false;
  // The session that goes cold: its transcript is how the new one learns what the conversation
  // file does not hold yet (what came before the file was written, a TUI's turns).
  const previous = agentSessionFile(record.paneID);
  // The agents CLI the supervisor asks for the panes' state (AGENTS_APP_AGENTS_BIN in tests).
  const socket = process.env.AGENTS_APP_TMUX_SOCKET;
  const resumed = spawnSync(agentsCLI(), ["resume", "--new-session", "--pane", record.paneID, "--json"], { encoding: "utf8", timeout: 30_000, env: { ...process.env, AGENTS_NO_AUTO_SETUP: "1", ...(socket ? { TMUX: `${socket},0,0` } : {}) } });
  if (resumed.status !== 0) {
    log(`the coordinator in ${record.paneID} could not start fresh (${oneLine(resumed.stderr || resumed.stdout || "no answer", 200)}); its live session goes on`);
    return false;
  }
  noteNextRun(program, how);
  const contextFile = path.join(program, ".run", "fresh-context.md");
  fs.mkdirSync(path.dirname(contextFile), { recursive: true });
  writeFileAtomic(contextFile, freshContext(program));
  const cli = ensureSharedCLI();
  const text = coordinatorStartMessage({
    name: programName(program), program, protocol,
    overview: path.join(program, "OVERVIEW.md"), context: path.join(program, "CONTEXT.md"), memoryFile: path.join(program, "MEMORY.md"),
    cli: shellQuote(cli), hint: asHint(coordinatorCLIName(record.uuid)), skill: skillFile(),
    instructions: userInstructions() ? userInstructionsPath() : undefined,
    start: "fresh",
    steps: [
      `You go on from earlier runs of this coordinator. Read ${path.join(program, "MEMORY.md")}, then ${contextFile}: the end of your conversation with the user and the open threads. Your answers so far are in ${path.join(program, "thread.jsonl")}; read more of it only when that is not enough.`,
      previous ? `Your previous session (${previous.agent}) is ${previous.file}: read its end for what you and the user said last where those files do not say it, and check what it says was done before you build on it.` : "",
      "Then handle the event below, as the coordinator before you would have.",
    ],
  });
  // The start goes first, before the wake that came: its queue name sorts before every line there.
  const first = queued[0] ? Number(queued[0].split("-")[0]) : Date.now();
  enqueueMessage(program, record.uuid, text, `Coordinator of “${programName(program)}”`, undefined, { lines: true, event: { kind: "start" }, at: Number.isFinite(first) ? first - 1 : undefined });
  log(`the coordinator in ${record.paneID} starts fresh: ${how.why}`);
  return true;
}
