import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The history readers find each harness's files under HOME (Codex's under CODEX_HOME), read when
// the module loads: both point at a folder of made-up sessions before it is imported.
const home = mkdtempSync(join(tmpdir(), "agents-history-"));
const savedHome = process.env.HOME;
const savedCodexHome = process.env.CODEX_HOME;
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");
const { loadHistoryForAgent } = await import("./scanner-history.js");

const cwd = "/repo/app";
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const ids = (agent: string, current?: string) => loadHistoryForAgent(agent, cwd, 10, current).map((item) => item.sessionId);

beforeAll(() => {
  const claude = join(home, ".claude", "projects", "-repo-app");
  write(join(claude, "said.jsonl"), lines(
    { type: "user", timestamp: "2026-11-09T10:00:00Z", message: { role: "user", content: "Fix the build" } },
    { type: "assistant", timestamp: "2026-11-09T10:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
  ));
  write(join(claude, "opened.jsonl"), lines({ type: "permission-mode", permissionMode: "default" }));
  write(join(claude, "login.jsonl"), lines(
    { type: "user", timestamp: "2026-11-09T11:00:00Z", message: { role: "user", content: "<local-command-caveat>Caveat: run directly</local-command-caveat>" } },
    { type: "user", timestamp: "2026-11-09T11:00:01Z", message: { role: "user", content: "<command-name>/login</command-name>" } },
  ));
  write(join(claude, "empty.jsonl"), "");

  const pi = join(home, ".pi", "agent", "sessions", "--repo-app--");
  write(join(pi, "2026-11-09_pi-said.jsonl"), lines(
    { type: "session", id: "pi-said" },
    { type: "message", timestamp: "2026-11-09T10:00:00Z", message: { role: "user", content: "Hello" } },
  ));
  write(join(pi, "2026-11-09_pi-opened.jsonl"), lines({ type: "session", id: "pi-opened" }, { type: "model_change", modelId: "m" }));

  const copilot = join(home, ".copilot", "session-state");
  write(join(copilot, "cp-said", "workspace.yaml"), `cwd: ${cwd}\n`);
  write(join(copilot, "cp-said", "events.jsonl"), lines({ type: "user.message", timestamp: "2026-11-09T10:00:00Z", data: { content: "Hello" } }));
  write(join(copilot, "cp-opened", "workspace.yaml"), `cwd: ${cwd}\n`);
  write(join(copilot, "cp-opened", "events.jsonl"), lines({ type: "session.start", timestamp: "2026-11-09T10:00:00Z" }));

  const cursor = join(home, ".cursor", "projects", "repo-app", "agent-transcripts");
  write(join(cursor, "cu-said.json"), JSON.stringify([{ role: "user", text: "Hello" }]));
  write(join(cursor, "cu-opened.json"), JSON.stringify([]));

  const codex = join(home, ".codex");
  const rollout = (id: string, ...entries: unknown[]) => {
    const path = join(codex, "sessions", "2026", "11", "09", `rollout-2026-11-09T10-00-00-${id}.jsonl`);
    write(path, lines({ type: "session_meta", payload: { id } }, ...entries));
    return path;
  };
  const said = rollout("cx-said", { type: "response_item", timestamp: "2026-11-09T10:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] } });
  const opened = rollout("cx-opened");
  const bootstrap = rollout("cx-bootstrap", { type: "response_item", timestamp: "2026-11-09T10:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] } });
  const guardian = rollout("cx-guardian", { type: "event_msg", timestamp: "2026-11-09T10:00:00Z", payload: { type: "agent_message", message: "Approved" } });
  const row = (id: string, path: string, source: string, title = "") =>
    `insert into threads values ('${id}', '${path}', '${source.replace(/'/g, "''")}', '${cwd}', '${title}', 1794200000, null);`;
  execFileSync("sqlite3", [join(codex, "state_5.sqlite"), [
    "create table threads (id text, rollout_path text, source text, cwd text, title text, updated_at integer, model text);",
    row("cx-said", said, "cli", "Fix it"),
    row("cx-opened", opened, "vscode"),
    row("cx-bootstrap", bootstrap, "vscode"),
    row("cx-guardian", guardian, '{"subagent":{"other":"guardian"}}', "Guardian review"),
  ].join("\n")]);
});

afterAll(() => {
  process.env.HOME = savedHome;
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  rmSync(home, { recursive: true, force: true });
});

describe("agents history leaves out sessions with nothing said in them", () => {
  it("Claude: only opened, or only a command run in Claude Code, is not a conversation", () => {
    expect(ids("claude")).toEqual(["said"]);
    expect(ids("claude", "opened").sort()).toEqual(["opened", "said"]);
  });

  it("Pi, Copilot and Cursor: a session with no message is left out unless a pane has it open", () => {
    expect(ids("pi")).toEqual(["pi-said"]);
    expect(ids("pi", "pi-opened").sort()).toEqual(["pi-opened", "pi-said"]);
    expect(ids("copilot")).toEqual(["cp-said"]);
    expect(ids("cursor")).toEqual(["cu-said"]);
  });

  it("Codex: a thread only opened, or a subagent's, is left out", () => {
    expect(ids("codex")).toEqual(["cx-said"]);
    expect(ids("codex", "cx-opened").sort()).toEqual(["cx-opened", "cx-said"]);
  });
});
