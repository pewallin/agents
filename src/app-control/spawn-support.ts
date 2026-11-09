// @ts-nocheck
// Starting a spawned agent: its view, startup checks, recovery and lock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentsCLI } from "./agent-state.js";
import { requestAppControl, runtimeDirectory } from "./app-socket.js";
import { sharedCLIPath } from "./briefs.js";
import { newMessageID } from "./delivery.js";
import { acpViewAgentOf, acpViewAgents, promptArgsForAgent, shellCommand, shellQuote } from "./launch.js";
import { enqueueRider } from "./messages.js";
import { fail, setFailureContext } from "./output.js";
import { paneIDFromRef, runTMux, tmuxPaneOption } from "./panes.js";
import { sleep } from "./placement.js";
import { oneLine, processTable } from "./processes.js";
import { readJSON, taskPaths, writeFileAtomic } from "./program.js";
import { respawnMarker } from "./promote.js";

// A hand-off agent that starts in its ACP view: `acp-session` starts it with no TUI and gives the
// brief to its host, which prompts the agent with it over ACP. The TUI command keeps the brief
// for the agent that starts in its terminal after all; without the brief, it is the command the
// TUI takes the session back with.
export function briefInViewLaunch(launchPlan, prompt, pane) {
  const promptArgs = promptArgsForAgent(launchPlan.agent, prompt);
  const tuiArgv = launchPlan.argv.slice(0, launchPlan.argv.length - promptArgs.length);
  const handOffAgent = acpViewAgentOf(launchPlan.argv[0])?.registryId;
  const briefFile = path.join(os.tmpdir(), `agents-brief-${process.pid}-${String(paneIDFromRef(pane)).replace(/\W/g, "")}.txt`);
  fs.writeFileSync(briefFile, prompt, { mode: 0o600 });
  return {
    shell: shellCommand([
      agentsCLI(), "acp-session", "--agent", handOffAgent,
      "--tui", shellCommand(tuiArgv),
      "--first-tui", shellCommand(launchPlan.argv),
      "--first-prompt-file", briefFile,
    ]),
  };
}

// Whether the agents CLI can prompt a hand-off agent its pane's host holds (`acp-prompt`): one
// that lists the agents with an ACP view has it.
export function acpPromptSupported() {
  return acpViewAgents().length > 0;
}

// A line for an agent whose pane's host holds its session (a hand-off agent in its ACP view): the
// host prompts the agent with it, as typing it into the TUI would, once the agent's turn ends.
// True when the host took it.
// A line for the agent of a pane whose ACP host holds its session. With steer, into its running
// turn where it can take that: the host's answer says how (steered, offered in its steer inbox,
// or queued as its next prompt). False when the host did not take it.
export function promptHosted(paneID, text, steer = false) {
  if (!acpPromptSupported()) return false;
  const result = spawnSync(agentsCLI(), ["acp-prompt", "--pane", paneID, ...(steer ? ["--steer"] : [])], { input: text, encoding: "utf8", timeout: 45000 });
  if (result.status !== 0) return false;
  let answer = {};
  try { answer = JSON.parse(String(result.stdout || "").trim().split("\n").pop() || "{}"); } catch { /* an older CLI */ }
  return { state: answer.state || (steer ? "steered" : "prompted") };
}

// The pane's ACP view host, from the metadata the agents CLI writes for it (the rule of the app's
// WorkspacePaneRuntimeMetadata): <AGENTS_TMP_DIR or AGENTS_HOME/runtime/tmp>/acp-session/pane-N.json.
export function acpViewHost(paneID) {
  const home = process.env.AGENTS_HOME || path.join(os.homedir(), ".agents", "agents-app");
  const tmp = process.env.AGENTS_TMP_DIR || path.join(home, "runtime", "tmp");
  const number = String(paneID).replace(/^%/, "");
  if (!/^\d+$/.test(number)) return undefined;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, "acp-session", `pane-${number}.json`), "utf8"));
    const url = new URL(meta.url);
    if (url.hostname !== "127.0.0.1" || !meta.token) return undefined;
    return { url: url.origin, token: meta.token };
  } catch {
    return undefined;
  }
}

// Tells the pane's ACP view what was typed into its terminal. Nothing happens without a view.
export function announceToView(paneID, text) {
  const host = acpViewHost(paneID);
  if (!host) return;
  // The token goes to curl on stdin, not on its command line.
  spawnSync("curl", ["-s", "-m", "2", "-K", "-", "-X", "POST", "-H", "Content-Type: application/json",
    "--data-binary", JSON.stringify({ text }), `${host.url}/api/typed`], {
    input: `header = "Authorization: Bearer ${host.token}"\n`,
    encoding: "utf8",
    timeout: 3000,
  });
}

export function hostsSession(paneID) {
  return tmuxPaneOption(paneID, "@agents_acp_hosted") === "1";
}

// A pane the app marked to open in its ACP view shows it once the app knows the pane's agent,
// a moment after the agent starts: until then the pane has no view to switch to.
export async function showACPView(currentSocketPath, token, pane) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await requestAppControl(currentSocketPath, token, "control.invoke", { id: "pane.toggle-view", pane }, "cli");
    if (response.ok !== false) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

// The launch is only typed into the pane. The agent may still end as it starts, on a flag it
// refuses or a login it lacks, and `exec` then closes its pane with the error in it. So for the
// first seconds the pane stays when its agent ends: the spawn sees that, keeps what the agent
// printed and its exit status, and fails with them. --startup-wait 0 returns once the command
// is typed.
export function startupWaitMs(params) {
  const seconds = params["startup-wait"] !== undefined
    ? Number(params["startup-wait"])
    : Number(process.env.AGENTS_APP_STARTUP_WAIT_MS) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 8000;
}

// The pane's processes, by pid: its own process and every process beneath it. The shell the
// launch is typed into is one of them: the pane's own, or a shell a terminal proxy such as Kiro's
// kiro-cli-term runs beneath it on a terminal of its own (2026-10-29).
export function paneProcesses(paneRef) {
  const pid = Number(runTMux(["display-message", "-p", "-t", paneIDFromRef(paneRef), "#{pane_pid}"]));
  if (!pid) return undefined;
  const table = processTable();
  const processes = new Map();
  const queue = [pid];
  for (let index = 0; index < queue.length; index += 1) {
    const entry = table.byPid.get(queue[index]);
    if (!entry) continue;
    processes.set(entry.pid, `${entry.comm} ${entry.args}`);
    queue.push(...(table.children.get(entry.pid) || []));
  }
  return processes.size ? processes : undefined;
}

// Whether the launch's `exec` replaced one of the pane's processes from before it: the shell that
// read the launch is then the agent, or a process the agent became. Each process from before
// still there as it was means no shell ran the launch: a `cd` failed, or the shell was busy.
// Processes that came since do not count: a proxy's shell may run hooks at its prompt.
export function launchReplacedShell(before, now) {
  return [...before].some(([pid, args]) => now.get(pid) !== args);
}

export async function watchAgentStartup(paneRef, waitMs, before) {
  const paneID = paneIDFromRef(paneRef);
  const started = Date.now();
  const look = () => {
    const line = runTMux(["display-message", "-p", "-t", paneID, "#{pane_id}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_current_command}"]);
    if (!line || line.split("\t")[0] !== paneID) return { gone: true };
    const [, dead, status, signal, current] = line.split("\t");
    return { dead: dead === "1", status, signal, current };
  };
  const ended = state => {
    const output = state.gone ? "" : (runTMux(["capture-pane", "-p", "-J", "-t", paneID, "-S", "-60"]) || "");
    return {
      checked: true,
      started: false,
      afterMs: Date.now() - started,
      ...(state.gone ? { reason: "the pane closed" } : {}),
      ...(state.status ? { exitStatus: Number(state.status) } : {}),
      ...(state.signal ? { signal: Number(state.signal) } : {}),
      // A screen is mostly empty rows between what the agent printed and tmux's own last line.
      output: output.split("\n").map(line => line.replace(/\s+$/, "")).filter(Boolean).slice(-40).join("\n"),
    };
  };
  for (;;) {
    const state = look();
    if (state.gone || state.dead) return ended(state);
    if (Date.now() - started >= waitMs) {
      runTMux(["set-option", "-p", "-q", "-u", "-t", paneID, "remain-on-exit"]);
      // It may have ended just now, after the last look and before the option went.
      const last = look();
      if (last.gone || last.dead) return ended(last);
      // The launch never replaced the shell it was typed into: a `cd` that failed, or a shell
      // still busy. The command tmux names does not tell: it is whichever process has the pane's
      // terminal, a shell whenever an agent runs a tool in one, and always kiro-cli-term's
      // "zsh (kiro-cli-term)" behind Kiro's terminal proxy (2026-10-29).
      const now = paneProcesses(paneRef);
      if (before && now && !launchReplacedShell(before, now)) {
        // Beneath any proxy: the last process found is the deepest.
        const shell = [...before.values()].pop();
        return { ...ended(last), reason: `the pane's shell (${shell}) still runs: the agent did not start` };
      }
      return { checked: true, started: true, afterMs: Date.now() - started, command: last.current };
    }
    await sleep(250);
  }
}

// A worker that did not start leaves its error where it can be read again, and its pane goes:
// a dead pane is no worker. The spawn is run again with the same task, harness and model.
export function failStartup(newPane, startup, { planned, task, program, command, launchCommand, cwd }) {
  const paneID = paneIDFromRef(newPane);
  const lines = [
    `# ${planned.harness.agent || "agent"} did not start in ${paneID}`,
    "",
    `At: ${new Date().toISOString()}`,
    `Command: ${planned.launch.command}`,
    ...(startup.exitStatus !== undefined ? [`Exit status: ${startup.exitStatus}`] : []),
    ...(startup.signal ? [`Signal: ${startup.signal}`] : []),
    ...(startup.reason ? [`Reason: ${startup.reason}`] : []),
    "",
    "Output:",
    "",
    startup.output || "(none)",
    "",
  ];
  let log;
  if (task) {
    log = path.join(taskPaths(program, task).dir, "startup-failure.log");
    // The supervisor does not report the closed pane: this failure does.
    writeFileAtomic(respawnMarker(program, task), `${Date.now()}\n`);
  } else {
    log = path.join(runtimeDirectory(), "startup-failures", `${paneID.replace(/^%/, "pane-")}-${Date.now()}.log`);
  }
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, lines.join("\n"));
  if (!startup.reason?.startsWith("the pane closed")) runTMux(["kill-pane", "-t", paneID]);
  const harness = planned.harness;
  const again = task
    ? ["agents-app-control", "agent", "respawn", task, "--program", program, ...(harness.model ? ["--model", harness.model] : []), "--json"]
    : [
      "agents-app-control", "agent", "spawn", command.prompt, "--no-parent", "--launch-command", launchCommand,
      ...(cwd ? ["--cwd", cwd] : []), ...(harness.model ? ["--model", harness.model] : []), "--json",
    ];
  const status = startup.exitStatus !== undefined ? ` with status ${startup.exitStatus}` : "";
  const tail = (startup.output || "").split("\n").filter(line => line.trim()).slice(-3).join(" / ");
  setFailureContext({ newPane, recovery: shellCommand(again) });
  fail(
    1,
    "agentStartFailed",
    `${harness.agent || "The agent"} in ${paneID} ended${status} ${Math.round(startup.afterMs / 100) / 10}s after it was started${startup.reason ? ` (${startup.reason})` : ""}${tail ? `: ${tail}` : ""}. Its output is in ${log}. Fix the cause, then start it again with the recovery command; it keeps the ${harness.agent || "same"} harness${harness.model ? ` and model ${harness.model}` : ""}.`,
    { startup: { ...startup, log }, harness }
  );
}


// How to finish a spawn whose pane exists but whose agent did not start: the same spawn, run into
// that pane instead of a new one. A worker is respawned by task name, so its brief is kept.
export function spawnRecovery(newPane, command, task, program, launchCommand, cwd) {
  const argv = task
    ? ["agents-app-control", "agent", "respawn", task, "--into", newPane, "--program", program, "--json"]
    : [
      "agents-app-control", "agent", "spawn", command.prompt, "--no-parent", "--into", newPane,
      "--launch-command", launchCommand, ...(cwd ? ["--cwd", cwd] : []), "--json",
    ];
  return shellCommand(argv);
}

export async function acquireSpawnLock(paneID) {
  const dir = path.join(runtimeDirectory(), "spawn-locks");
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${String(paneID).replace(/[^A-Za-z0-9]/g, "_")}.lock`);
  const release = () => fs.rmSync(lock, { recursive: true, force: true });
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      process.on("exit", release);
      return release;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      // A spawn takes seconds; a lock this old belongs to one that died.
      if (Date.now() - fs.statSync(lock).mtimeMs > 120000) release();
    } catch {
      // Released meanwhile.
    }
    await sleep(100);
  }
  fail(1, "spawnBusy", `Another agent spawn from ${paneID} did not finish within two and a half minutes.`);
}

// A worker's result leaves out the launch command: it repeats the prompt, and the coordinator
// reading it pays for every token. --dry-run still shows it.
export function spawnSummary(planned, task) {
  if (!task) return planned;
  const { launch, ...summary } = planned;
  return { ...summary, harness: { agent: planned.harness.agent, profile: planned.harness.profile, model: planned.harness.model }, cwd: launch.cwd };
}

// Coordinators and workers. tmux carries the structure (who is whose parent, roles, task names,
// the program directory) as pane options; files in the program directory carry the content
// (briefs, reports, STATUS.md, queued messages). A small supervisor process per program watches
// workers and types queued lines into an agent's prompt once it is idle.

// A worker has a task; a worker promoted to coordinator of its own workers keeps its parent.
export function isWorkerRecord(record) {
  return Boolean(record.task) && (record.role === "worker" || Boolean(record.parent));
}

// A worker (not one promoted to coordinator) may lead sub-workers of its own, one level down:
// they report to it, and it reports the task as a whole to its coordinator. It starts them only
// once the user agreed (`--approved`); a sub-worker starts none. Returns undefined for a
// coordinator, else { parentTask, coordinator }: the worker's task and its own coordinator's uuid.
// `check: false` (a respawn) asks for no approval again.
export function subWorkerLead(leader, params, records, verb, check = true) {
  if (!leader || leader.role !== "worker" || !leader.task) return undefined;
  const meta = leader.program ? readJSON(taskPaths(leader.program, leader.task).meta, {}) : {};
  const lead = leader.parent ? records.find(record => record.uuid === leader.parent) : undefined;
  const above = meta.parentTask || (lead?.role === "worker" ? lead.task : undefined);
  if (check && above) {
    fail(2, "depthLimit", `You are a sub-worker of task ${above}, and sub-workers start no workers of their own. Do the work yourself; if it is too big for one agent, say so to task ${above} with agent ask.`);
  }
  if (check && !params.approved) {
    const cli = shellQuote(sharedCLIPath());
    fail(2, "needsApproval", `You are a worker (task ${leader.task}): ${verb} sub-workers only once the user agreed. Ask them first with ${cli} agent report "<how many sub-workers, what each does and which files it touches>" --ask user, then end your turn. When they say yes, run this again with --approved.`);
  }
  return { parentTask: leader.task, coordinator: leader.parent };
}

// Tells a worker's coordinator, without waking it, that the worker started a sub-worker.
export function noteSubWorker(program, sub, task, about) {
  if (!sub?.coordinator) return;
  enqueueRider(program, sub.coordinator, `Worker ${sub.parentTask} started sub-worker ${task}, with the user's approval${about ? `: ${oneLine(about, 200)}` : ""}. It reports to ${sub.parentTask}, not to you; ${sub.parentTask} reports the task as a whole.`, `Worker ${sub.parentTask} started sub-worker ${task}`, newMessageID());
}
