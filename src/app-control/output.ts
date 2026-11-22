// @ts-nocheck
// Usage text and the JSON result every command prints.

import { recordFailure } from "./feedback.js";

export function usage() {
  return [
    "Usage: agents app <command> ... --json   (also agents-app-control; every command prints one JSON line)",
    "",
    "What is open and what you can do:",
    "  agents app ls --json                         every session, workspace and pane; `you` is your own pane",
    "  agents app help [<topic>|<control-id>]       ls, open, review, workspace, controls, surface, panel, settings, window, agent",
    "  agents app controls list --json              every control the app has, with what it does",
    "  agents app controls invoke <control-id> [--pane <ref>] [--<argument> <value>]... --json",
    "",
    "Common commands (act on your own pane unless --pane names another; new panes come back as result.newPane):",
    "  agents app open <file.md|file.html|url> [--direction right|down] --json",
    "  agents app review [--cwd <repo>] [--base <rev> | --commit <sha>] --json   the app's diff view of a repository's changes",
    "  agents app workspace new [--cwd <dir>] [--name <name>] --json",
    "  agents app workspace rename <name> [--pane <ref>] --json",
    "  agents app workspace tab [--pane <ref>] --json",
    "  agents app workspace split [--direction right|down] [--pane <ref>] --json",
    "  agents app surface send-text <text> --pane <ref> [--submit] --json",
    "  agents app surface send-key <key> --pane <ref> --json",
    "  agents app surface read-text --pane <ref> [--lines 80] --json",
    "  agents app settings get [<key>] --json",
    "  agents app settings set <key> <value> --json",
    "  agents app panel show palette|switcher|open [--query <text>] [--activate] --json",
    "  agents app panel hide --json",
    "  agents app window snapshot [--path window.png] [--window panel|settings] --json",
    "  agents app window resize --width 1400 --height 900 --json",
    "  agents app identify --json / capabilities --json / context --json (context: the user's focused pane)",
    "",
    "Agents (workers and coordinators):",
    "  agents app agent spawn <prompt> [--task <name>] --title <the user's words> [--parent <pane-ref>|--no-parent] [--placement auto|split|tab] [--axis horizontal|vertical] [--pane <pane-ref>] [--into <pane-ref>] [--cwd <dir>] [--profile <id>] [--model <model>] [--language <name>] [--launch-command <cmd>] [--program <dir>] [--startup-wait <seconds>] [--approved] [--dry-run] --json",
    "  agents app agent respawn <task> [--title <title>] [--replace|--into <pane-ref>] [--profile <id>] [--model <model>] [--launch-command <cmd>] [--startup-wait <seconds>] --json",
    "  agents app agent promote [--pane <pane-ref>|--spawn-id <id>] [--program <dir>] [--name <name>] [--take-over <pane|task>] [--language <name>] [--tell] --json",
    "  agents app agent protocol --json",
    "  agents app agent adopt <pane-ref> [--task <name>] --title <the user's words> [--language <name>] [--approved] <what to do> --json",
    "  agents app agent remind <text> --in 20m|--at 14:30 --json",
    "  agents app agent watch --cmd <shell command> | --poll <shell command> [--every 60] [--until success|change] [--timeout 24h] [<label>] --json",
    "  agents app agent watch --list | --cancel <id> --json",
    "  agents app agent report <one-line status> [--done|--blocked] [--output <url|file>]... [--details-file <file>] --json   (no flag: progress, wakes nobody)",
    "  agents app agent ask <question> [--to parent] [--timeout 50] --json   (asks your coordinator and waits for its answer)",
    "  agents app agent ask --user <question> --json   (a question for the user; end your turn, it closes when they answer in your pane)",
    "  agents app agent status [--all] --json",
    "  agents app agent wait [<task>...] [--until all|any] [--timeout 1800] --json",
    "  agents app agent send <text> | --file <file> --to parent|<task>|<pane-ref>|<agent uuid> [--mode queue|steer] [--id <message-id>] [--reply-to <message-id>] [--supersedes <message-id>] --json   (always wakes the agent)",
    "  agents app agent delivery <message-id> [--cancel | --deliver-now] --json   (--deliver-now types a held message in now, unless the user is writing there)",
    "  agents app agent close <task>... | --done --json   (a done thread closed is resolved; an unfinished one stays open, stopped)",
    "  agents app agent resolve <task>... [--dropped <why> | --replaced-by <task>] [--program <dir>] --json   (ends a thread: a done one as done, an unfinished one only dropped or replaced; closes its pane if it has one)",
    "  agents app agent resolve <task>... --propose <why> --json   (proposes closing a done thread; the user closes it)",
    "  agents app agent remove <task>... [--program <dir>] | --program <dir> --json   (deletes threads without a pane, or without tasks a whole program nobody leads; agents' own sessions stay)",
    "  agents app agent reopen <task> [<why>] [--title <title>] [--program <dir>] [--pane <pane-ref>] [--dry-run] --json   (a done thread says it was reopened and why; without a pane: resume its latest session, else respawn it, else read it)",
    "  agents app agent name <name> [--program <dir>] --json   (names the coordinator's program: 2-4 words from the user's goal)",
    "  agents app agent title <task> <title> [--program <dir>] --json   (names a thread in the user's words: verb first, 3-6 words)",
    "  agents app feedback <what happened> --command <command or tool> [--suggestion <text>] --json   (also agents feedback; only while Agents Next's development setting collects feedback on its tools)",
    "  agents app mcp [--as <task|coordinator-<id>>]   (report, ask, send, status and delivery as MCP tools over stdio)",
    "  agents app mcp --install-wrapper --json   (writes the stable launcher ~/.agents/agents-app/bin/agents-app-control)",
    "  (agent commands find the agent that runs them by its process tree; --as <task|coordinator-<id>> names it where they cannot)",
  ].join("\n");
}

// The command line being run (after `app`), for the failure an agent may give feedback on.
let commandArgv = [];
export function setCommandArgv(argv) {
  commandArgv = argv;
}

// A failed call of an agent, while the development setting collects feedback: kept for its
// feedback, and its answer invites some. Nothing about it may keep the failure from its answer.
function withFeedbackInvitation(error) {
  try {
    const invitation = recordFailure(error, commandArgv);
    return invitation ? { ...error, feedback: invitation } : error;
  } catch {
    return error;
  }
}

// Set once a spawn has a pane: every later failure names that pane and how to finish the spawn in it.
export let failureContext;
export function setFailureContext(value) {
  failureContext = value;
}

// Every result, success or failure, is one JSON line on stdout; the exit status tells them apart.
export function fail(status, code, message, details) {
  const payload = { ok: false, error: withFeedbackInvitation({ code, message, ...failureContext, ...details }) };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(status);
}
export function outputResponse(response) {
  if (response.ok === false && response.error) response = { ...response, error: withFeedbackInvitation(response.error) };
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(response.ok === false ? 1 : 0);
}
