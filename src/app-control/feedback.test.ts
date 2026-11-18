// Agent feedback on Agents Next's tools: off by default, asked for only after a failed call.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { FEEDBACK_INVITATION, callingAgent, feedbackLogPath, recordFailure, writeFeedback } from "./feedback.js";
import { MCP_FEEDBACK_TOOL, mcpArguments, mcpTools } from "./mcp.js";
import { parseProcessTable } from "./processes.js";

// launchd › claude (pid 10) › zsh › agents (pid 30); a second Claude (pid 40) › zsh › agents (pid 60).
const table = parseProcessTable([
  "    1     0     1     0 ??       Ss   launchd /sbin/launchd",
  "   10     1    10    10 ttys001  S+   2.1.302 claude --resume",
  "   20    10    20    20 ttys001  S+   zsh /bin/zsh -c agents app open x.md",
  "   30    20    20    20 ttys001  S+   agents /usr/local/bin/agents app open x.md",
  "   40     1    40    40 ttys002  S+   codex codex",
  "   50    40    50    50 ttys002  S+   zsh /bin/zsh -c agents feedback",
  "   60    50    50    50 ttys002  S+   agents /usr/local/bin/agents feedback",
].join("\n"));

function home(enabled: boolean) {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "agents-feedback-"));
  if (enabled) {
    fs.mkdirSync(path.join(shared, "feedback"));
    fs.writeFileSync(path.join(shared, "feedback", "enabled"), "");
  }
  return { AGENTS_SHARED_HOME: shared, HOME: shared };
}

const now = Date.parse("2026-11-18T15:00:00Z");

test("the agent of a command is the nearest agent executable above it", () => {
  assert.deepEqual(callingAgent(table, 30), { agent: "claude", agentPid: 10 });
  assert.deepEqual(callingAgent(table, 60), { agent: "codex", agentPid: 40 });
  assert.equal(callingAgent(table, 20)?.agentPid, 10);
  assert.equal(callingAgent(table, 1), undefined);
});

test("off, nothing is recorded, no invitation is given and the MCP server does not list the tool", () => {
  const env = home(false);
  assert.equal(recordFailure({ code: "usage", message: "open takes one file" }, ["open"], { env, table, pid: 30, now }), undefined);
  assert.equal(fs.existsSync(path.join(env.AGENTS_SHARED_HOME, "feedback")), false);
  assert.equal(mcpTools(env).some(tool => tool.name === "report_feedback"), false);
  const written = writeFeedback({ command: "agents app open", happened: "It failed." }, { env, table, pid: 30, now });
  assert.equal(written.error?.code, "feedbackOff");
  assert.equal(fs.existsSync(feedbackLogPath(env)), false);
});

test("on, a failed call of an agent is kept and invites feedback, which carries that agent's recent failures", () => {
  const env = home(true);
  assert.ok(mcpTools(env).includes(MCP_FEEDBACK_TOOL));
  // Claude's command failed twice, an hour ago and now; Codex's once.
  recordFailure({ code: "usage", message: "old" }, ["open", "a.md"], { env, table, pid: 30, now: now - 60 * 60 * 1000 });
  const invitation = recordFailure({ code: "usage", message: "open takes one file or URL" }, ["open", "a.md", "b.md", "--json"], { env, table, pid: 30, now });
  assert.equal(invitation, FEEDBACK_INVITATION);
  recordFailure({ code: "tmuxUnavailable", message: "no tmux" }, ["agent", "report", "x"], { env, table, pid: 60, now });
  // Feedback and help are never asked about, and a command no agent ran is not kept.
  assert.equal(recordFailure({ code: "usage", message: "x" }, ["feedback"], { env, table, pid: 30, now }), undefined);
  assert.equal(recordFailure({ code: "usage", message: "x" }, ["open"], { env, table, pid: 1, now }), undefined);

  const written = writeFeedback(
    { command: " agents app open a.md b.md ", happened: "I wanted two previews side by side.", suggestion: "Take several files." },
    { env, table, pid: 30, now: now + 1000, cwd: "/repo" },
  );
  assert.equal(written.result?.attachedFailures, 1);
  const [entry] = fs.readFileSync(feedbackLogPath(env), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entry.agent, "claude");
  assert.equal(entry.cwd, "/repo");
  assert.equal(entry.command, "agents app open a.md b.md");
  assert.equal(entry.suggestion, "Take several files.");
  assert.deepEqual(entry.failures.map((failure: any) => [failure.command, failure.code]), [["open a.md b.md", "usage"]]);
});

test("an entry names the command or tool and what happened", () => {
  const env = home(true);
  assert.equal(writeFeedback({ command: "", happened: "Clumsy." }, { env, table, pid: 30, now }).error?.code, "usage");
  assert.equal(writeFeedback({ command: "agents app open", happened: " " }, { env, table, pid: 30, now }).error?.code, "usage");
});

test("report_feedback runs agents feedback", () => {
  assert.deepEqual(mcpArguments("report_feedback", { command: "send", happened: "It waited 50 s.", suggestion: "Say so." }).argv,
    ["feedback", "It waited 50 s.", "--command", "send", "--suggestion", "Say so."]);
});
