// @ts-nocheck
// Programs (a coordinator's folder), tasks and the panes that coordinate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { runtimeDirectory } from "./app-socket.js";
import { sharedCLIPath } from "./briefs.js";
import { programDirectories } from "./coordinator.js";
import { fail, usage } from "./output.js";
import { failIfTMuxUnreachable, localPaneRef, paneIDFromRef, resolveLocalSourcePane, runTMux, runTMuxRequired, setPaneOption, tmuxPaneOption } from "./panes.js";
import { sleep } from "./placement.js";
import { paneRunsAgent } from "./processes.js";

// Without tmux (a restart, a server that does not answer) the list is empty, or with `strict`
// undefined: to the supervisor an unanswered list is not a list of no panes.
export function coordinationPaneRecords(options = {}) {
  const output = runTMux([
    "list-panes",
    "-a",
    "-F",
    [
      "#{pane_id}",
      "#{session_name}",
      "#{session_id}",
      "#{window_id}",
      "#{@agents_uuid}",
      "#{@agents_parent}",
      "#{@agents_task}",
      "#{@agents_role}",
      "#{@agents_program}",
      "#{@agents_report_state}",
      "#{@agents_report_at}",
      "#{@agents_tab_of}",
      "#{pane_current_command}",
      "#{pane_in_mode}",
      "#{pane_dead}",
      "#{window_name}",
      "#{pane_pid}",
    ].join("\t"),
  ]);
  if (output === undefined) return options.strict ? undefined : [];
  if (!output) return [];
  const byPane = new Map();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [paneID, sessionName, sessionID, windowID, uuid, parent, task, role, program, reportState, reportAt, tabOf, currentCommand, inMode, dead, windowName, panePid] = line.split("\t");
    const record = {
      paneID, sessionName, sessionID, windowID, uuid, parent, task, role, program, reportState,
      reportAt: Number(reportAt) || 0, tabOf, currentCommand, inMode: inMode === "1", dead: dead === "1", windowName,
      panePid: Number(panePid) || 0,
    };
    // A window linked into the app's internal sessions is listed once per session.
    const existing = byPane.get(paneID);
    if (!existing || existing.sessionName.startsWith("_agents_next_")) byPane.set(paneID, record);
  }
  return [...byPane.values()];
}

// The tmux window of the workspace that shows a pane. A tab (`@agents_tab_of`) lives alone in a
// window of its slot's session and is shown in the window of the pane whose slot it is in, through
// tabs of tabs. A tab whose slot is gone is shown in its own window.
export function workspaceWindowID(record, records) {
  const byUUID = new Map(records.filter(candidate => candidate.uuid).map(candidate => [candidate.uuid, candidate]));
  const seen = new Set();
  let current = record;
  while (current.tabOf) {
    const slot = byUUID.get(current.tabOf);
    if (!slot || seen.has(current.tabOf)) return record.windowID;
    seen.add(current.tabOf);
    current = slot;
  }
  return current.windowID;
}

export function ownCoordinationRecord(params, commandName) {
  const pane = resolveLocalSourcePane(params, commandName);
  const record = coordinationPaneRecords().find(candidate => candidate.paneID === paneIDFromRef(pane));
  if (!record) failIfTMuxUnreachable(commandName);
  if (!record) fail(2, "paneUnavailable", `Could not find pane '${pane}' in local tmux.`);
  return record;
}

export async function waitForPaneUUID(pane) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const uuid = tmuxPaneOption(pane, "@agents_uuid");
    if (uuid) return uuid;
    await sleep(100);
  }
  return ensurePaneUUID({ paneID: paneIDFromRef(pane) });
}

// The app reads pane options when tmux reports a change in its event log; tmux has no event
// for an option, so say it here.
export function notifyApp(sessionName) {
  const dir = path.join(runtimeDirectory(), "tmux-events");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "agents-app-events.log"), `${Math.floor(Date.now() / 1000)}\tagents-coordination\t${sessionName || ""}\t\t\n`);
  } catch {
    // Without the app nothing reads it.
  }
}

export function ensurePaneUUID(record) {
  if (record.uuid) return record.uuid;
  const uuid = crypto.randomUUID().toLowerCase();
  setPaneOption(localPaneRef(record.paneID), "@agents_uuid", uuid);
  record.uuid = uuid;
  return uuid;
}

export function slug(text, limit = 40) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, limit)
    .replace(/-+$/g, "");
}

// Programs made before 2026-10-29 were per workspace: `<session>-<window name>`. Still the
// fallback for a pane whose folder is unknown.
export function defaultProgramDirectory(sessionName, windowName) {
  const name = [slug(sessionName), slug(windowName)].filter(Boolean).join("-");
  return path.join(programsRoot(), name || "default");
}

export function programsRoot() {
  return path.join(os.homedir(), ".agents", "programs");
}

// A program made for a folder says so in program.json: { folder, repo }.
export function programMeta(program) {
  return readJSON(path.join(program, "program.json"), undefined);
}

export function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

// A remote URL without its protocol, user and .git, so ssh and https name one repository alike.
export function normalizedRemote(url) {
  return url.trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// The folder a coordinator works in: its repository's top level, else the directory its agent
// was started in. `repo` names the repository wherever it is checked out: its origin, else its
// first commit.
export function paneFolder(record) {
  const cwd = tmuxPaneOption(record.paneID, "@agents_command_cwd")
    || runTMux(["display-message", "-p", "-t", record.paneID, "#{pane_current_path}"]);
  if (!cwd || !fs.existsSync(cwd)) return undefined;
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  let folder = top || cwd;
  try {
    folder = fs.realpathSync(folder);
  } catch {
    // Kept as tmux reports it.
  }
  if (!top) return { folder };
  const remote = runGit(folder, ["config", "--get", "remote.origin.url"]);
  const first = runGit(folder, ["rev-list", "--max-parents=0", "HEAD"]).split(/\s+/).filter(Boolean).sort()[0];
  const repo = remote ? `remote:${normalizedRemote(remote)}` : first ? `commit:${first}` : undefined;
  return { folder, ...(repo ? { repo } : {}) };
}

// A coordinator leads while its agent runs. One whose agent has exited leaves its pane with a
// shell and the pane's options: it leads nothing any more, so the next coordinator of its folder
// carries on its program instead of starting an empty one beside it.
export function coordinatorLeads(candidate) {
  return candidate.role === "coordinator" && !candidate.dead && paneRunsAgent(candidate).ok;
}

// Whether another live coordinator than `record` leads `program`.
export function ledByAnother(program, record, records) {
  return records.some(candidate => candidate.paneID !== record.paneID && candidate.program === program
    && coordinatorLeads(candidate));
}

// A coordinator that still leads earlier work in the folder of `program`, a program of its own:
// the new coordinator is told it can take that work over instead.
export function folderCoordinator(program, record, records) {
  const folder = programMeta(program)?.folder;
  if (!folder) return undefined;
  return records.find(candidate => candidate.paneID !== record.paneID && candidate.program
    && candidate.program !== program && programMeta(candidate.program)?.folder === folder
    && coordinatorLeads(candidate));
}

// The program of a folder: the one made for it, or one made for the same repository in a folder
// that is gone (the repository was moved). A program another live coordinator leads is left to it;
// a second coordinator in the folder gets one of its own. A new one is named after the folder.
export function folderProgram(where, record, records) {
  const programs = programDirectories().sort()
    .map(program => ({ program, meta: programMeta(program) }))
    .filter(entry => entry.meta && entry.meta.folder);
  const exact = programs.filter(entry => entry.meta.folder === where.folder);
  const moved = exact.length || !where.repo ? []
    : programs.filter(entry => entry.meta.repo === where.repo && !fs.existsSync(entry.meta.folder));
  const free = [...exact, ...moved].find(entry => !ledByAnother(entry.program, record, records));
  if (free) return { program: free.program, meta: { ...free.meta, ...where } };
  const base = slug(path.basename(where.folder)) || "default";
  for (let suffix = 1; ; suffix += 1) {
    const program = path.join(programsRoot(), suffix === 1 ? base : `${base}-${suffix}`);
    if (!fs.existsSync(program)) return { program, meta: { ...where, created: new Date().toISOString() } };
  }
}

// The program a coordinator already has. Its window's option names the program of the workspace
// it became a coordinator in, but a pane moved out of that window (made a tab, which lives in a
// window of its own, or moved to another workspace) sees another window's option, or
// none. So the program is kept on the pane too, and one moved before that is found through its
// workers, which carry it on their own panes.
export function recordedCoordinatorProgram(record, records) {
  const own = tmuxPaneOption(record.paneID, "@agents_program");
  if (own) return own;
  if (record.uuid) {
    const workers = (records || coordinationPaneRecords())
      .filter(candidate => candidate.parent === record.uuid && candidate.program)
      .sort((a, b) => b.reportAt - a.reportAt);
    if (workers.length) return workers[0].program;
  }
  return record.program;
}

// The workspace window a pane is shown in, with its program: a coordinator started in a tab (a
// window of its own) belongs to the workspace whose slot shows it, so a new coordinator
// there, on whatever agent, finds the program and notes of the coordinators before it.
export function workspaceWindow(record, records) {
  const own = { windowID: record.windowID, sessionName: record.sessionName, windowName: record.windowName, program: undefined };
  if (!record.tabOf) return own;
  const all = records || coordinationPaneRecords();
  const windowID = workspaceWindowID(record, all);
  if (windowID === record.windowID) return own;
  const shown = all.find(candidate => candidate.windowID === windowID && !candidate.tabOf) || all.find(candidate => candidate.windowID === windowID);
  if (!shown) return own;
  const program = runTMux(["show-options", "-w", "-q", "-v", "-t", windowID, "@agents_program"]) || undefined;
  return { windowID, sessionName: shown.sessionName, windowName: shown.windowName, program };
}

// The program a coordinator's workers get, without recording it: the one its pane keeps, else
// its workspace's when that is for the same folder (or from before programs had folders), else its
// folder's. `meta` is what program.json should say, when it should say something new.
export function resolveCoordinatorProgram(record, explicit, records) {
  if (explicit) return { program: path.resolve(explicit) };
  const kept = recordedCoordinatorProgram(record, records);
  if (kept) return { program: kept };
  const all = records || coordinationPaneRecords();
  const workspace = workspaceWindow(record, all);
  const where = paneFolder(record);
  if (workspace.program) {
    const meta = programMeta(workspace.program);
    if (!meta || !where || meta.folder === where.folder) return { program: workspace.program, workspace };
  }
  if (!where) {
    return { program: defaultProgramDirectory(workspace.sessionName, workspace.windowName), workspace };
  }
  return { ...folderProgram(where, record, all), workspace };
}

// The program a coordinator's workers get, kept on its pane and, for a new one, on its window.
export function coordinatorProgram(record, explicit, records) {
  const resolved = resolveCoordinatorProgram(record, explicit, records);
  const program = resolved.program;
  if (resolved.meta) {
    const current = programMeta(program);
    if (!current || current.folder !== resolved.meta.folder || current.repo !== resolved.meta.repo) {
      writeFileAtomic(path.join(program, "program.json"), `${JSON.stringify(resolved.meta, null, 2)}\n`);
    }
  }
  if (!explicit && !record.program && resolved.workspace) {
    runTMuxRequired(["set-option", "-w", "-q", "-t", resolved.workspace.windowID, "@agents_program", program], "tmux set-option @agents_program");
  }
  if (tmuxPaneOption(record.paneID, "@agents_program") !== program) {
    setPaneOption(localPaneRef(record.paneID), "@agents_program", program);
  }
  record.program = program;
  return program;
}

export function taskPaths(program, task) {
  const dir = path.join(program, "tasks", task);
  return {
    dir,
    brief: path.join(dir, "brief.md"),
    report: path.join(dir, "report.md"),
    summary: path.join(dir, "summary.md"),
    reportJSON: path.join(dir, "report.json"),
    meta: path.join(dir, "task.json"),
    cli: sharedCLIPath(),
  };
}

export function uniqueTaskName(seed, records, program, explicit) {
  if (explicit) {
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/i.test(explicit)) {
      fail(64, "usage", "--task must be 1-48 letters, digits, '.', '_' or '-'.");
    }
    if (records.some(record => record.task === explicit && record.program === program)) {
      fail(2, "taskExists", `Task '${explicit}' already has a worker. Use another name, or 'agent respawn ${explicit} --replace'.`);
    }
    if (fs.existsSync(taskPaths(program, explicit).dir)) {
      fail(2, "taskExists", `Task '${explicit}' already exists in ${program}. Use another name, or 'agent respawn ${explicit}'.`);
    }
    return explicit;
  }
  const base = slug(String(seed).split(/\s+/).slice(0, 5).join(" "), 32) || "task";
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const taken = records.some(record => record.task === name && record.program === program)
      || fs.existsSync(taskPaths(program, name).dir);
    if (!taken) return name;
  }
}

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents);
  fs.renameSync(temporary, file);
}
