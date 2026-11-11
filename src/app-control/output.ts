// @ts-nocheck
// Usage text and the JSON result every command prints.


export function usage() {
  return [
    "Usage:",
    "  agents-app-control identify --json",
    "  agents-app-control capabilities --json",
    "  agents-app-control context --json",
    "  agents-app-control controls list --context focused-pane --json",
    "  agents-app-control controls invoke <control-id> [--pane <pane-ref>] [--style glacierTeal] [--path README.md] [--url https://example.com] [--placement split] [--axis horizontal] --json",
    "  agents-app-control surface send-text <text> [--pane <pane-ref>] [--submit] --json",
    "  agents-app-control surface send-key <key> [--pane <pane-ref>] --json",
    "  agents-app-control surface read-text [--lines 80] [--pane <pane-ref>] --json",
    "  agents-app-control settings get [<key>] --json",
    "  agents-app-control settings set <key> <value> --json",
    "  agents-app-control panel show palette|switcher|open [--query <text>] [--activate] --json",
    "  agents-app-control window snapshot [--path window.png] [--window panel] --json",
    "  agents-app-control window resize --width 1400 --height 900 --json",
    "  agents-app-control workspace tab [--pane <pane-ref>] [--dry-run] --json",
    "  agents-app-control workspace split [--axis horizontal|vertical] [--pane <pane-ref>] [--dry-run] --json",
    "  agents-app-control agent spawn <prompt> [--task <name>] [--title <the user's words>] [--parent <pane-ref>|--no-parent] [--placement auto|split|tab] [--axis horizontal|vertical] [--pane <pane-ref>] [--into <pane-ref>] [--cwd <dir>] [--profile <id>] [--model <model>] [--language <name>] [--launch-command <cmd>] [--program <dir>] [--startup-wait <seconds>] [--approved] [--dry-run] --json",
    "  agents-app-control agent respawn <task> [--replace|--into <pane-ref>] [--profile <id>] [--model <model>] [--launch-command <cmd>] [--startup-wait <seconds>] --json",
    "  agents-app-control agent promote [--pane <pane-ref>|--spawn-id <id>] [--program <dir>] [--take-over <pane|task>] [--language <name>] [--tell] --json",
    "  agents-app-control agent protocol --json",
    "  agents-app-control agent adopt <pane-ref> [--task <name>] [--title <the user's words>] [--language <name>] [--approved] <what to do> --json",
    "  agents-app-control agent remind <text> --in 20m|--at 14:30 --json",
    "  agents-app-control agent watch --cmd <shell command> | --poll <shell command> [--every 60] [--until success|change] [--timeout 24h] [<label>] --json",
    "  agents-app-control agent watch --list | --cancel <id> --json",
    "  agents-app-control agent report <one-line status> [--done|--blocked|--ask coordinator|user] [--output <url|file>]... [--details-file <file>] --json",
    "  agents-app-control agent ask <question> [--to parent] [--timeout 50] --json",
    "  agents-app-control agent status [--all] --json",
    "  agents-app-control agent wait [<task>...] [--until all|any] [--timeout 1800] --json",
    "  agents-app-control agent send <text> | --file <file> --to parent|<task>|<pane-ref>|<agent uuid> [--mode queue|steer] [--id <message-id>] [--reply-to <message-id>] [--no-wake] [--supersedes <message-id>] --json",
    "  agents-app-control agent delivery <message-id> [--cancel] --json",
    "  agents-app-control agent close <task>... | --done --json   (a done thread closed is resolved; an unfinished one stays open, stopped)",
    "  agents-app-control agent resolve <task>... [--program <dir>] --json   (nothing is left: closes its pane if it has one)",
    "  agents-app-control agent reopen <task> [--program <dir>] [--pane <pane-ref>] [--dry-run] --json   (resume its latest session, else respawn it, else read it)",
    "  agents-app-control mcp [--as <task|coordinator-<id>>]   (report, ask, send, status and delivery as MCP tools over stdio)",
    "  agents-app-control mcp --install-wrapper --json   (writes the stable launcher ~/.agents/agents-app/bin/agents-app-control)",
    "  (agent commands find the agent that runs them by its process tree; --as <task|coordinator-<id>> names it where they cannot)",
  ].join("\n");
}

// Set once a spawn has a pane: every later failure names that pane and how to finish the spawn in it.
export let failureContext;
export function setFailureContext(value) {
  failureContext = value;
}

// Every result, success or failure, is one JSON line on stdout; the exit status tells them apart.
export function fail(status, code, message, details) {
  const payload = { ok: false, error: { code, message, ...failureContext, ...details } };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(status);
}
export function outputResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
  process.exit(response.ok === false ? 1 : 0);
}
