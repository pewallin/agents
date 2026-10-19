import { describe, expect, it } from "vitest";
import {
  codexSharedAppServerClientPanes,
  isCodexSharedAppServerClient,
  runsUnderCodexSharedAppServer,
} from "./codex-shared-app-server.js";
import type { ProcEntry, ProcessTree } from "./scanner-discovery.js";

const CODEX = "/Users/me/.nvm/versions/node/v24/lib/node_modules/@openai/codex/vendor/bin/codex";
const DAEMON = "/Users/me/.codex/packages/app-server-daemon/releases/0.161.0/bin/codex app-server --listen unix:// --analytics-default-enabled --managed-daemon";

function tree(entries: Array<[pid: number, ppid: number, args: string]>): ProcessTree {
  const byPid = new Map<number, ProcEntry>();
  const children = new Map<number, number[]>();
  for (const [pid, ppid, args] of entries) {
    byPid.set(pid, { pid, ppid, comm: args.split(" ")[0].replace(/.*\//, ""), tty: "??", cpuPercent: 0, memoryMB: 0, args });
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  return { byPid, children, byTty: new Map() };
}

// Two panes run plain `codex`: the one in %2 started the shared app-server, whose hooks then
// report for %25 too with %2's TMUX_PANE (the incident of 2026-10-19).
const twoPlainCodexPanes = tree([
  [100, 1, "-zsh"],
  [101, 100, "node /opt/homebrew/bin/codex"],
  [102, 101, CODEX],
  [103, 102, DAEMON],
  [104, 103, "/bin/bash /Users/me/.agents/agents-cli/app/extensions/codex/report-state.sh working"],
  [105, 104, "/Users/me/.agents/agents-cli/app/agents report --agent codex --state working --session %2"],
  [200, 1, "-zsh"],
  [201, 200, `node /opt/homebrew/bin/codex -m gpt-6-astra ROLE: worker. You take over task "astra-review"`],
  [202, 201, `${CODEX} -m gpt-6-astra ROLE: worker. You take over task "astra-review"`],
]);

describe("Codex's shared app-server", () => {
  it("is recognized as the ancestor of a hook's report", () => {
    expect(runsUnderCodexSharedAppServer(105, twoPlainCodexPanes)).toBe(true);
    expect(runsUnderCodexSharedAppServer(202, twoPlainCodexPanes)).toBe(false);
  });

  it("does not run the hooks of a Codex with its own app-server", () => {
    const own = tree([
      [300, 1, "-zsh"],
      [301, 300, `${CODEX} --no-daemon`],
      [302, 301, "/bin/bash report-state.sh working"],
      [303, 302, "agents report --agent codex --state working --session %30"],
    ]);
    expect(runsUnderCodexSharedAppServer(303, own)).toBe(false);
  });

  it("counts only TUIs that use it, not --no-daemon, --remote or other subcommands", () => {
    expect(isCodexSharedAppServerClient({ args: "node /opt/homebrew/bin/codex" })).toBe(true);
    expect(isCodexSharedAppServerClient({ args: `${CODEX} resume 01a13f75-d5c7-7492-9364-7bba6d01e836` })).toBe(true);
    expect(isCodexSharedAppServerClient({ args: `${CODEX} --no-daemon -m gpt-6-astra` })).toBe(false);
    expect(isCodexSharedAppServerClient({ args: `${CODEX} --remote ws://127.0.0.1:50123` })).toBe(false);
    expect(isCodexSharedAppServerClient({ args: DAEMON })).toBe(false);
    expect(isCodexSharedAppServerClient({ args: `${CODEX} exec "review this"` })).toBe(false);
    expect(isCodexSharedAppServerClient({ args: "/usr/bin/git status" })).toBe(false);
  });

  it("leaves a report without its pane when two panes use it", () => {
    const panes = [{ paneId: "%2", pid: 100 }, { paneId: "%25", pid: 200 }];
    expect(codexSharedAppServerClientPanes(panes, twoPlainCodexPanes)).toEqual(["%2", "%25"]);
  });

  it("gives the report the one pane that uses it, whichever pane started it", () => {
    // The worker in %25 runs with --no-daemon, so only %2's Codex reports through the shared one.
    const workerWithOwnServer = tree([
      [100, 1, "-zsh"],
      [101, 100, "node /opt/homebrew/bin/codex"],
      [102, 101, CODEX],
      [103, 102, DAEMON],
      [200, 1, "-zsh"],
      [201, 200, `node /opt/homebrew/bin/codex --no-daemon -m gpt-6-astra ROLE: worker.`],
      [202, 201, `${CODEX} --no-daemon -m gpt-6-astra ROLE: worker.`],
      [300, 1, "-zsh"],
      [301, 300, "node /Users/me/agents/dist/cli.js codex-session --command codex"],
      [302, 301, `${CODEX} app-server --listen ws://127.0.0.1:0`],
      [303, 301, `${CODEX} --remote ws://127.0.0.1:50123`],
    ]);
    const panes = [{ paneId: "%2", pid: 100 }, { paneId: "%25", pid: 200 }, { paneId: "%30", pid: 300 }];
    expect(codexSharedAppServerClientPanes(panes, workerWithOwnServer)).toEqual(["%2"]);
  });
});
