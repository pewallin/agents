// @ts-nocheck
// The app as an agent drives it: what is open (`ls`), help per command, and controls that act on
// the agent's own pane unless told otherwise, say which pane they made and wait for a close.

import os from "node:os";
import path from "node:path";
import { readToken, requestAppControl } from "./app-socket.js";
import { fail } from "./output.js";
import { localPaneRef, paneIDFromRef, paneOfProcessTree, runTMux, runsUnderDetachedCodex } from "./panes.js";
import { sleep } from "./placement.js";

// The pane this command runs in, or undefined outside every pane (then the app's focused pane is
// the target, as it is for a person at a terminal of their own).
export function ownPane() {
  if (process.env.AGENTS_APP_TMUX_PANE_ID) return localPaneRef(process.env.AGENTS_APP_TMUX_PANE_ID);
  const tree = paneOfProcessTree();
  if (tree.paneID) return localPaneRef(tree.paneID);
  if (!tree.unknown && runsUnderDetachedCodex(tree.ancestors)) return undefined;
  return process.env.TMUX_PANE ? localPaneRef(process.env.TMUX_PANE) : undefined;
}

// Controls that open a pane, and say which one in `newPane`.
const CREATES_PANE = new Set([
  "workspace.create-local-tab",
  "workspace.split-active-pane",
  "workspace.open-markdown-preview",
  "workspace.open-file-preview",
  "workspace.open-web-page",
  "workspace.create",
]);

// Controls whose `pane` is what they act on: they take the caller's own pane when it is left out.
// Typing into a pane and reading one always name it (`surface ...`).
const NEEDS_NAMED_PANE = new Set(["surface.send-text", "surface.send-key", "surface.read-text"]);

// "right" and "down" as the app says them: a split's axis.
const DIRECTIONS = { right: "horizontal", down: "vertical" };

function paneSet() {
  const output = runTMux(["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}\t#{window_id}"]) || "";
  const panes = new Map();
  for (const [paneID, session, windowID] of output.split(/\r?\n/).map(line => line.split("\t"))) {
    if (!paneID) continue;
    // A window the app shows is linked into its control session too: the user's session names it.
    if (!panes.has(paneID) || panes.get(paneID).session.startsWith("_agents_next_")) panes.set(paneID, { session, windowID });
  }
  return panes;
}

async function waitForNewPane(before, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const after = paneSet();
    const added = [...after.keys()].filter(paneID => !before.has(paneID));
    if (added.length > 0) {
      const [paneID] = added;
      const { session, windowID } = after.get(paneID);
      return { newPane: localPaneRef(paneID), workspace: windowID, session };
    }
    await sleep(100);
  }
  return undefined;
}

async function waitForPaneGone(pane, timeoutMs = 3000) {
  const paneID = paneIDFromRef(pane);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!paneSet().has(paneID)) return true;
    await sleep(100);
  }
  return false;
}

// The values the app expects: `%12` and `12` name local:%12; `right`/`down` a split.
export function normalizeControlParams(controlID, params) {
  const result = { ...params };
  for (const name of ["pane", "tab-of", "beside"]) {
    if (typeof result[name] === "string" && /^%?\d+$/.test(result[name])) {
      result[name] = localPaneRef(result[name].startsWith("%") ? result[name] : `%${result[name]}`);
    }
  }
  if (result.direction !== undefined) {
    const axis = DIRECTIONS[String(result.direction).toLowerCase()];
    if (!axis) {
      fail(64, "usage", `--direction is right or down (a new pane opens to the right of or below the pane); got '${result.direction}'.`);
    }
    delete result.direction;
    result.axis = axis;
    if (controlID !== "workspace.split-active-pane") result.placement = "split";
  }
  if (controlID === "workspace.create" && typeof result.cwd === "string") {
    result.cwd = path.resolve(result.cwd.replace(/^~(?=$|\/)/, os.homedir()));
  }
  if (["workspace.open-file-preview", "workspace.open-markdown-preview"].includes(controlID) && typeof result.path === "string") {
    // A path relative to where the command runs, as a shell would read it, not to the target pane.
    result.path = path.resolve(result.path.replace(/^~(?=$|\/)/, os.homedir()));
  }
  return result;
}

export async function invokeControl(currentSocketPath, controlID, rawParams) {
  const token = readToken(currentSocketPath);
  const params = normalizeControlParams(controlID, rawParams);
  if (NEEDS_NAMED_PANE.has(controlID) && !params.pane) {
    fail(64, "usage", `${controlID} needs --pane: the pane to ${controlID === "surface.read-text" ? "read" : "type into"} (\`agents app ls\` lists them).`);
  }
  const self = ownPane();
  if (!params.pane && self && !NEEDS_NAMED_PANE.has(controlID)) {
    const list = await requestAppControl(currentSocketPath, token, "control.list", {}, "cli");
    const descriptor = (list.result || []).find(control => control.id === controlID);
    if (descriptor?.arguments?.some(argument => argument.name === "pane")) params.pane = self;
  }
  const before = CREATES_PANE.has(controlID) ? paneSet() : undefined;
  const response = await requestAppControl(currentSocketPath, token, "control.invoke", { ...params, id: controlID }, "cli");
  if (response.ok === false) return response;
  const result = { ...response.result };
  if (params.pane) result.pane = params.pane;
  if (before) {
    const created = await waitForNewPane(before);
    if (created) {
      const settled = SHOWS_PAGE.has(controlID) ? found => found.kind !== "terminal" : () => true;
      Object.assign(result, created, await placeOf(currentSocketPath, token, created.newPane, settled));
    }
    else result.note = "No new pane: it opened in a pane that was there (a preview tab is reused), or is still opening. `agents app ls` shows the panes.";
  }
  if (controlID === "pane.close" && params.pane) {
    result.closed = await waitForPaneGone(params.pane);
    if (!result.closed) result.note = "The pane is still open: the app is asking the user whether to close it (an agent pane, the last pane of a session).";
  }
  if (controlID === "surface.read-text" && typeof result.output === "string") {
    result.output = result.output.replace(/\s+$/, "");
  }
  return { ...response, result };
}

// Where the app shows a pane: its workspace (a tab's is that of the pane it shares a place with).
async function placeOf(currentSocketPath, token, pane, settled = () => true) {
  const deadline = Date.now() + 2000;
  let last = {};
  while (Date.now() < deadline) {
    const response = await requestAppControl(currentSocketPath, token, "app.state", {}, "cli");
    for (const session of response.result?.sessions || []) {
      for (const workspace of session.workspaces || []) {
        const found = (workspace.panes || []).find(entry => entry.ref === pane);
        if (found) {
          last = { session: session.name, workspace: workspace.id, workspaceName: workspace.name, kind: found.kind, ...(found.tabOf ? { tabOf: found.tabOf } : {}) };
          if (settled(found, workspace)) return last;
        }
      }
    }
    if (response.ok === false) return last;
    await sleep(100);
  }
  return last;
}

// A pane opened to show a page or a file is a terminal for a moment, until the app has its view.
const SHOWS_PAGE = new Set(["workspace.open-markdown-preview", "workspace.open-file-preview", "workspace.open-web-page"]);

// `ls`: every session, workspace and pane, the caller's own pane marked.
export async function listState(currentSocketPath) {
  const token = readToken(currentSocketPath);
  const response = await requestAppControl(currentSocketPath, token, "app.state", {}, "cli");
  if (response.ok === false) {
    if (response.error?.code === "unknownControl") {
      fail(2, "appOutdated", "The running Agents Next app cannot list what is open (app.state). Update Agents Next.");
    }
    return response;
  }
  const self = ownPane();
  const state = response.result;
  for (const session of state.sessions || []) {
    for (const workspace of session.workspaces || []) {
      for (const pane of workspace.panes || []) {
        if (self && pane.ref === self) pane.isYou = true;
      }
    }
  }
  return { ...response, result: { you: self || null, ...state } };
}

// `workspace new`: a workspace with a terminal, in a folder and with a name if given.
export async function createWorkspace(currentSocketPath, params) {
  const { name, ...rest } = params;
  const created = await invokeControl(currentSocketPath, "workspace.create", rest);
  if (created.ok === false || name === undefined) return created;
  if (!created.result.newPane) {
    fail(1, "paneNotFound", "The app made the workspace, but its pane did not show up in time to name it; name it with `agents app workspace rename <name> --pane <pane>`.");
  }
  // A rename the app takes before it has the new window's workspace is lost: name it until it shows.
  const token = readToken(currentSocketPath);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const renamed = await invokeControl(currentSocketPath, "workspace.rename", { pane: created.result.newPane, name });
    if (renamed.ok === false) return renamed;
    const place = await placeOf(currentSocketPath, token, created.result.newPane, (_, workspace) => workspace.isNamed && workspace.name === name);
    if (place.workspaceName === name) return { ...created, result: { ...created.result, ...place } };
  }
  fail(1, "renameFailed", `The workspace of ${created.result.newPane} was made, but did not take the name '${name}'; name it with \`agents app workspace rename <name> --pane ${created.result.newPane}\`.`, { newPane: created.result.newPane });
}

// `review`: the app's review of a repository's changes (the diff view), beside your pane.
export async function openReview(currentSocketPath, params) {
  const { reviewFiles, reviewPage } = await import("../review-server.js");
  const cwd = path.resolve(params.cwd || process.cwd());
  let url;
  try {
    url = await reviewPage({ cwd, base: params.base, commit: params.commit, paths: [].concat(params.path || []) });
  } catch (error) {
    fail(1, "reviewFailed", `No review of ${cwd}: ${error instanceof Error ? error.message : error}.`);
  }
  const placement = params.placement || (params.direction ? undefined : "split");
  const open = { url, ...(placement ? { placement } : {}), ...(params.direction ? { direction: params.direction } : { axis: params.axis || "horizontal" }) };
  if (params.pane) open.pane = params.pane;
  const response = await invokeControl(currentSocketPath, "workspace.open-web-page", open);
  if (response.ok === false) return response;
  const files = reviewFiles({ cwd, base: params.base, commit: params.commit, paths: [].concat(params.path || []) });
  const compared = params.commit ? `commit ${params.commit}` : params.base ? `against ${params.base}` : "uncommitted (against HEAD)";
  return { ...response, result: { ...response.result, cwd, shows: compared, files } };
}

const HELP = {
  ls: [
    "agents app ls --json",
    "Every session, its workspaces (tmux windows) and their panes: ref (what --pane takes), kind",
    "(terminal, agent, agent-view, web, markdown, file), title, folder, url or path, agent and status,",
    "the tab it belongs to (tabOf). `you` and isYou are your own pane, isFocused the user's focus.",
  ],
  context: [
    "agents app context --json",
    "The pane the user has focused (activePaneRef) and its project. Not your own pane: that is `you` in `agents app ls`.",
  ],
  controls: [
    "agents app controls list --json                    every control, with what it does and its arguments",
    "agents app controls invoke <control-id> [--<argument> <value>]... --json",
    "agents app help <control-id>                       one control in full",
    "Controls that take --pane act on your own pane when you leave it out. Controls that open a pane",
    "answer with its ref in result.newPane; pane.close answers result.closed once it is gone.",
    "--direction right|down places a new pane to the right of or below the pane (a split).",
  ],
  workspace: [
    "agents app workspace new [--cwd <dir>] [--name <name>] [--pane <ref>] --json   a new workspace with a terminal; answers newPane",
    "agents app workspace rename <name> [--pane <ref>] --json                         names the workspace of --pane (your own)",
    "agents app workspace tab [--pane <ref>] --json                                   a terminal as a tab in your pane's place",
    "agents app workspace split [--direction right|down] [--pane <ref>] --json        a terminal beside your pane",
  ],
  review: [
    "agents app review [--cwd <repo>] [--base <rev> | --commit <sha>] [--path <file>]... [--direction right|down | --placement local-tab] --json",
    "Shows a repository's changes in the app's diff view, beside your pane: uncommitted changes, changes",
    "against --base (HEAD~3, main) or one --commit. --cwd is the repository you are in by default.",
  ],
  open: [
    "agents app open <file|url> [--direction right|down | --placement local-tab|beside] [--pane <ref>] --json",
    "A Markdown or HTML file as a rendered preview, or a web page (https://..., localhost:3000) in a browser",
    "pane. A tab in your pane's place unless --direction puts it beside your pane. Answers newPane.",
  ],
  surface: [
    "agents app surface send-text <text> --pane <ref> [--submit] --json   types into a terminal pane (Return with --submit)",
    "agents app surface send-key <key> --pane <ref> --json               enter, escape, tab, backspace, up, down, left, right, ctrl-c",
    "agents app surface read-text --pane <ref> [--lines 80] --json        the last lines the pane shows",
    "Name the pane: `agents app ls` lists them. Check a pane is at a prompt (read-text) before typing a command into it.",
  ],
  panel: [
    "agents app panel show palette|switcher|open [--query <text>] [--activate] --json",
    "agents app panel hide --json",
  ],
  settings: [
    "agents app settings get [<key>] --json     every setting with its type, allowed values and current value",
    "agents app settings set <key> <value> --json",
    "Change a setting only when the user asked for it.",
  ],
  window: [
    "agents app window snapshot [--path window.png] [--window panel|settings] --json   a picture of the app window",
    "agents app window resize --width 1400 --height 900 --json",
  ],
};

export function helpTopics() {
  return Object.keys(HELP);
}

export function topicHelp(topic) {
  return HELP[topic] ? HELP[topic].join("\n") : undefined;
}

// `help <control-id>`: the control as the running app describes it.
export async function controlHelp(currentSocketPath, controlID) {
  const token = readToken(currentSocketPath);
  const response = await requestAppControl(currentSocketPath, token, "control.list", {}, "cli");
  const descriptor = (response.result || []).find(control => control.id === controlID);
  if (!descriptor) {
    const ids = (response.result || []).map(control => control.id).join(", ");
    return `No control '${controlID}'. The app's controls: ${ids}.`;
  }
  const lines = [`${descriptor.id}: ${descriptor.title}`];
  if (descriptor.summary) lines.push(descriptor.summary);
  if (!descriptor.isEnabled && descriptor.disabledReason) lines.push(`Disabled now for the focused pane: ${descriptor.disabledReason}`);
  lines.push("", "Arguments:");
  for (const argument of descriptor.arguments || []) {
    const values = argument.allowedValues?.length ? ` (${argument.allowedValues.join(", ")})` : "";
    lines.push(`  --${argument.name}${argument.isRequired ? " (required)" : ""}${values}${argument.summary ? `: ${argument.summary}` : ""}`);
  }
  if (!(descriptor.arguments || []).length) lines.push("  none");
  lines.push("", `agents app controls invoke ${descriptor.id}${(descriptor.arguments || []).filter(a => a.isRequired).map(a => ` --${a.name} <${a.name}>`).join("")} --json`);
  return lines.join("\n");
}
