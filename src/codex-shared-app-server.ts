import { basename } from "path";
import { buildProcessTree, type ProcEntry, type ProcessTree } from "./scanner-discovery.js";
import { exec } from "./shell.js";

// Codex's TUI uses a shared app-server daemon (`codex app-server --managed-daemon`) unless it is
// started with --no-daemon or connected to an app-server of its own with --remote. The first Codex
// starts the daemon, and the daemon runs the hooks of every Codex that uses it with that first
// Codex's environment: their TMUX_PANE names its pane, whichever pane the reporting Codex is in.

const WRAPPERS = new Set(["node", "bun", "env"]);
// Subcommands that run no TUI, so their processes are not a pane's Codex.
const NON_TUI_SUBCOMMANDS = new Set([
  "app-server", "exec", "e", "review", "mcp", "mcp-server", "exec-server", "login", "logout",
  "apply", "a", "cloud", "sandbox", "debug", "features", "completion", "doctor", "update",
]);

function codexArguments(args: string): string[] | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;
  if (basename(tokens[0]) === "codex") return tokens.slice(1);
  if (WRAPPERS.has(basename(tokens[0])) && tokens[1] && basename(tokens[1]) === "codex") return tokens.slice(2);
  return undefined;
}

export function isCodexSharedAppServer(entry: Pick<ProcEntry, "args">): boolean {
  const rest = codexArguments(entry.args);
  return !!rest && rest[0] === "app-server" && rest.includes("--managed-daemon");
}

/** Whether a process, typically the reporting CLI, runs as a hook of the shared app-server. */
export function runsUnderCodexSharedAppServer(pid: number, tree: ProcessTree, maxDepth = 8): boolean {
  let current = tree.byPid.get(pid);
  for (let depth = 0; current && depth < maxDepth; depth += 1) {
    if (isCodexSharedAppServer(current)) return true;
    if (current.ppid === current.pid) return false;
    current = tree.byPid.get(current.ppid);
  }
  return false;
}

/** A Codex TUI whose hooks run in the shared app-server. */
export function isCodexSharedAppServerClient(entry: Pick<ProcEntry, "args">): boolean {
  const rest = codexArguments(entry.args);
  if (!rest) return false;
  if (rest[0] && NON_TUI_SUBCOMMANDS.has(rest[0])) return false;
  return !rest.some((token) => token === "--no-daemon" || token === "--remote" || token.startsWith("--remote="));
}

function treeHasSharedAppServerClient(pid: number, tree: ProcessTree, seen: Set<number>): boolean {
  if (seen.has(pid)) return false;
  seen.add(pid);
  const entry = tree.byPid.get(pid);
  if (entry && isCodexSharedAppServerClient(entry)) return true;
  return (tree.children.get(pid) ?? []).some((child) => treeHasSharedAppServerClient(child, tree, seen));
}

/** The panes whose Codex uses the shared app-server. A hook of the shared app-server comes from one
 *  of them, so it belongs to a pane only when there is exactly one. */
export function codexSharedAppServerClientPanes(
  panes: ReadonlyArray<{ paneId: string; pid: number }>,
  tree: ProcessTree,
): string[] {
  return panes
    .filter((pane) => pane.pid > 0 && treeHasSharedAppServerClient(pane.pid, tree, new Set()))
    .map((pane) => pane.paneId);
}

export type CodexSharedAppServerReport =
  | { shared: false }
  | { shared: true; pane?: string; clients: string[] };

/** For a Codex report from the shared app-server, the pane it can only have come from, if any. */
export function resolveCodexSharedAppServerReport(pid: number = process.pid): CodexSharedAppServerReport {
  const tree = buildProcessTree();
  if (!runsUnderCodexSharedAppServer(pid, tree)) return { shared: false };
  const panes = exec("tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([paneId, pid]) => paneId?.startsWith("%") && pid)
    .map(([paneId, pid]) => ({ paneId, pid: parseInt(pid, 10) || 0 }));
  const clients = codexSharedAppServerClientPanes(panes, tree);
  return { shared: true, ...(clients.length === 1 ? { pane: clients[0] } : {}), clients };
}
