// Whether keys typed into a pane reach an agent, from fixture process tables, and how a task's
// report.md is written.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { writeTaskReport } from "./briefs.js";
import { identifyMCPCaller } from "./mcp.js";
import { agentInFrontOfShell, parseProcessTable } from "./processes.js";

// Rows as `ps -A -o pid=,ppid=,pgid=,tpgid=,tty=,stat=,ucomm=,args=` prints them.
function front(rows, panePid) {
  return agentInFrontOfShell({ paneID: "%7", panePid, currentCommand: "zsh" }, parseProcessTable(rows));
}

// macOS ps pads ucomm to its column, so args follow after several spaces (2026-10-29: 531 of
// 1006 rows on Peter's Mac). Claude Code is named by its first argument, its ucomm being its version.
test("agents named by their arguments are found where ps pads the command column", () => {
  const claude = front(`
  900     1   900     0 ??       Ss   tmux             tmux new-session
  950   900   950   951 ttys030  Ss   zsh              -zsh
  951   950   951   951 ttys030  S+   2.1.302          claude --dangerously-skip-permissions
`, 950);
  assert.deepEqual(claude, { agent: "claude", pid: 951 });
  const codex = front(`
  960   900   960   961 ttys031  Ss   zsh              -zsh
  961   960   961   961 ttys031  S+   node             node /opt/homebrew/bin/codex --yolo
`, 960);
  assert.deepEqual(codex, { agent: "codex", pid: 961 });
});

test("Kiro idle at its prompt behind kiro-cli-term, on the proxy's nested terminal, is in front", () => {
  const result = front(`
    1  0     1     0 ??       Ss   launchd launchd
  900  1   900     0 ??       Ss   tmux tmux new-session
40510 900 40510 40510 ttys027 Ss+ zsh (kiro-cli-term) zsh (kiro-cli-term)
40538 40510 40538 41631 ttys028 Ss zsh /bin/zsh --login
41631 40538 41631 41631 ttys028 S+ kiro-cli kiro-cli chat -a
41684 41631 41631 41631 ttys028 S+ kiro-cli-chat kiro-cli-chat chat -a
`, 40510);
  assert.deepEqual(result, { agent: "kiro-cli", pid: 41631 });
});

test("a Kiro worker started straight under kiro-cli-term is in front", () => {
  const result = front(`
50100 900 50100 50100 ttys021 Ss+ zsh (kiro-cli-term) zsh (kiro-cli-term)
50120 50100 50120 50120 ttys024 Ss+ kiro-cli kiro-cli chat --trust-all-tools
50121 50120 50120 50120 ttys024 S+ kiro-cli-chat kiro-cli-chat chat
`, 50100);
  assert.deepEqual(result, { agent: "kiro-cli", pid: 50120 });
});

test("an agent started in the pane's shell is in front", () => {
  const result = front(`
60000 900 60000 60010 ttys030 Ss zsh -zsh
60010 60000 60010 60010 ttys030 S+ node node /opt/homebrew/bin/codex --yolo
`, 60000);
  assert.deepEqual(result, { agent: "codex", pid: 60010 });
});

test("an agent behind a `zsh -c` wrapper is in front, on the pane's terminal or a terminal of its own", () => {
  const samePane = front(`
61000 900 61000 61010 ttys031 Ss zsh -zsh
61010 61000 61010 61010 ttys031 S+ zsh zsh -c kiro-cli chat; :
61020 61010 61010 61010 ttys031 S+ kiro-cli kiro-cli chat
`, 61000);
  assert.deepEqual(samePane, { agent: "kiro-cli", pid: 61020 });

  const nested = front(`
62000 900 62000 62010 ttys032 Ss zsh -zsh
62010 62000 62010 62010 ttys032 S+ zsh zsh -c script -q /dev/null kiro-cli; :
62020 62010 62010 62010 ttys032 S+ script script -q /dev/null kiro-cli
62030 62020 62030 62030 ttys033 Ss+ kiro-cli kiro-cli
`, 62000);
  assert.deepEqual(nested, { agent: "kiro-cli", pid: 62030 });
});

test("Claude Code, whose executable is named after its version, is found by the name it was started by", () => {
  const result = front(`
60500 900 60500 60510 ttys030 Ss zsh -zsh
60510 60500 60510 60510 ttys030 S+ zsh zsh -c claude --resume abc; :
60520 60510 60510 60510 ttys030 S+ 2.1.302 claude --resume abc
`, 60500);
  assert.deepEqual(result, { agent: "claude", pid: 60520 });
});

test("an agent is in front when a `zsh -c` wrapper is the pane's own process", () => {
  const result = front(`
63000 900 63000 63000 ttys034 Ss+ zsh zsh -c claude; exec zsh
63010 63000 63000 63000 ttys034 S+ claude claude
`, 63000);
  assert.deepEqual(result, { agent: "claude", pid: 63010 });
});

test("a shell at its own prompt holds a line, with or without kiro-cli-term", () => {
  const plain = front(`
64000 900 64000 64000 ttys035 Ss+ zsh -zsh
`, 64000);
  assert.deepEqual(plain, { reason: "pane %7 runs zsh at its own prompt, with no agent in front of it" });

  const proxied = front(`
65000 900 65000 65000 ttys036 Ss+ zsh (kiro-cli-term) zsh (kiro-cli-term)
65010 65000 65010 65010 ttys037 Ss+ zsh /bin/zsh --login
`, 65000);
  assert.deepEqual(proxied, { reason: "pane %7 runs zsh at its own prompt, with no agent in front of it" });
});

test("an editor in front of a background agent holds a line, with or without kiro-cli-term", () => {
  const plain = front(`
66000 900 66000 66020 ttys038 Ss zsh -zsh
66010 66000 66010 66020 ttys038 S claude claude
66020 66000 66020 66020 ttys038 S+ vim vim notes.md
`, 66000);
  assert.deepEqual(plain, { reason: "the agent claude in pane %7 runs in the background, behind vim" });

  const proxied = front(`
67000 900 67000 67000 ttys039 Ss+ zsh (kiro-cli-term) zsh (kiro-cli-term)
67010 67000 67010 67030 ttys040 Ss zsh /bin/zsh --login
67020 67010 67020 67030 ttys040 S kiro-cli kiro-cli chat
67030 67010 67030 67030 ttys040 S+ nvim nvim notes.md
`, 67000);
  assert.deepEqual(proxied, { reason: "the agent kiro-cli in pane %7 runs in the background, behind nvim" });
});

test("a background job with a terminal of its own holds a line while the shell waits at its prompt", () => {
  const result = front(`
68000 900 68000 68000 ttys041 Ss+ zsh -zsh
68010 68000 68010 68000 ttys041 S script script -q /dev/null kiro-cli
68020 68010 68020 68020 ttys042 Ss+ kiro-cli kiro-cli
`, 68000);
  assert.deepEqual(result, { reason: "the agent kiro-cli in pane %7 runs in the background, behind zsh at its own prompt" });
});

test("a stopped agent holds a line, with or without kiro-cli-term", () => {
  const plain = front(`
69000 900 69000 69000 ttys043 Ss+ zsh -zsh
69010 69000 69010 69000 ttys043 T claude claude
`, 69000);
  assert.deepEqual(plain, { reason: "the agent claude in pane %7 is stopped" });

  // Stopped while it still holds the terminal, before the shell takes it back.
  const proxied = front(`
70000 900 70000 70000 ttys044 Ss+ zsh (kiro-cli-term) zsh (kiro-cli-term)
70010 70000 70010 70020 ttys045 Ss zsh /bin/zsh --login
70020 70010 70020 70020 ttys045 T+ kiro-cli kiro-cli chat
`, 70000);
  assert.deepEqual(proxied, { reason: "the agent kiro-cli in pane %7 is stopped" });
});

test("a pane whose process is gone holds a line", () => {
  assert.deepEqual(front("", 71000), { reason: "pane %7 runs zsh and its process is gone" });
});

test("a report.md the worker wrote is kept, and the report goes to summary.md beside it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aacr-"));
  try {
    const files = { report: path.join(dir, "report.md"), reportJSON: path.join(dir, "report.json"), summary: path.join(dir, "summary.md") };
    const report = state => ({ task: "audit", state, line: `Audit ${state}`, updatedAt: "2026-10-23T12:00:00Z", outputs: [], history: [] });

    // Nothing of the worker's yet: the report is report.md, and stays so on every report.
    assert.equal(writeTaskReport(files, report("progress")), files.report);
    assert.equal(writeTaskReport(files, report("progress")), files.report);
    assert.match(fs.readFileSync(files.report, "utf8"), /^# audit: progress/);

    // The worker writes its deliverable there.
    fs.writeFileSync(files.report, "# Audit findings\n\nThree issues.\n");
    assert.equal(writeTaskReport(files, report("done")), files.summary);
    assert.equal(fs.readFileSync(files.report, "utf8"), "# Audit findings\n\nThree issues.\n");
    assert.match(fs.readFileSync(files.summary, "utf8"), /^# audit: done/);
    assert.equal(writeTaskReport(files, report("closed")), files.summary);
    assert.equal(fs.readFileSync(files.report, "utf8"), "# Audit findings\n\nThree issues.\n");

    // A worker that writes report.md before its first report keeps it too.
    fs.rmSync(files.reportJSON);
    assert.equal(writeTaskReport(files, report("done")), files.summary);
    assert.equal(fs.readFileSync(files.report, "utf8"), "# Audit findings\n\nThree issues.\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An MCP server is a child of its harness. Under Codex's shared app-server daemon it is a child of
// the daemon, which the first Codex TUI started in its own pane (measured with Codex 0.167).
const daemonRows = `
  900     1   900     0 ??       Ss   tmux             tmux new-session
  950   900   950   951 ttys030  Ss   zsh              -zsh
  951   950   951   951 ttys030  S+   codex            /usr/local/bin/codex
  952   951   951   951 ttys030  S    codex            /Users/p/.codex/packages/app-server-daemon/releases/0.167.0/bin/codex app-server --listen unix:// --managed-daemon
  960   900   960   961 ttys031  Ss   zsh              -zsh
  961   960   961   961 ttys031  S+   codex            /usr/local/bin/codex
  970   952   951   951 ttys030  S    node             node /Users/p/.agents/agents-app/bin/agents-app-control mcp
`;
const daemonPanes = new Map([[950, "%0"], [960, "%1"]]);

test("an MCP server under Codex's shared daemon never takes the daemon's pane for its agent", () => {
  const unknown = identifyMCPCaller({ table: parseProcessTable(daemonRows), pid: 970, panes: daemonPanes, threadId: "t-second", threadPane: () => undefined });
  assert.equal(unknown.paneID, undefined);
  assert.match(unknown.refused, /shared app-server daemon/);
  assert.match(unknown.refused, /leads to pane %0/);
  assert.match(unknown.refused, /"as"/);
  const noThread = identifyMCPCaller({ table: parseProcessTable(daemonRows), pid: 970, panes: daemonPanes, threadPane: () => "%1" });
  assert.match(noThread.refused, /sent no thread id/);
});

test("an MCP server under Codex's shared daemon serves the pane its thread runs in", () => {
  const asked = [];
  const found = identifyMCPCaller({ table: parseProcessTable(daemonRows), pid: 970, panes: daemonPanes, threadId: "t-second", threadPane: id => (asked.push(id), "%1") });
  assert.deepEqual(found, { paneID: "%1", via: "codex thread" });
  assert.deepEqual(asked, ["t-second"]);
});

test("an MCP server of a harness in its pane serves that pane; one of a daemon whose Codex is gone is refused", () => {
  const own = identifyMCPCaller({ table: parseProcessTable(`
  950   900   950   951 ttys030  Ss   zsh              -zsh
  951   950   951   951 ttys030  S+   2.1.319          claude
  980   951   951   951 ttys030  S    node             node /Users/p/.agents/agents-app/bin/agents-app-control mcp
`), pid: 980, panes: new Map([[950, "%4"]]), threadPane: () => assert.fail("no thread lookup outside Codex's daemon") });
  assert.deepEqual(own, { paneID: "%4", via: "process tree" });
  const noDaemon = identifyMCPCaller({ table: parseProcessTable(`
  960   900   960   961 ttys031  Ss   zsh              -zsh
  961   960   961   961 ttys031  S+   codex            /usr/local/bin/codex --no-daemon
  981   961   961   961 ttys031  S    node             node agents-app-control mcp
`), pid: 981, panes: new Map([[960, "%2"]]), threadId: "t", threadPane: () => assert.fail("no thread lookup") });
  assert.deepEqual(noDaemon, { paneID: "%2", via: "process tree" });
  const orphan = identifyMCPCaller({ table: parseProcessTable(`
  952     1   952     0 ??       S    codex            /x/bin/codex app-server --listen unix:// --managed-daemon
  990   952   952     0 ??       S    node             node agents-app-control mcp
`), pid: 990, panes: daemonPanes, threadId: "t", threadPane: () => undefined });
  assert.match(orphan.refused, /shared app-server daemon/);
});
