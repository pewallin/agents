// @ts-nocheck
// New panes through the app: splits, tabs and waiting for their shell.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { readPaneLook, readTtyMode, shellState } from "../shell-prompt.js";
import { readToken, requestAppControl, requestID } from "./app-socket.js";
import { assertOK, controlHasArgument, shellQuote } from "./launch.js";
import { fail, usage } from "./output.js";
import { canonicalSourcePaneRecord, localPaneRef, paneIDFromRef, resolveLocalSourcePane, runTMux, tmuxArgs, TMUX_TIMEOUT_MS } from "./panes.js";

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Each wait after the app accepted a spawn gets this long; slow shells or a busy app can ask for more.
export function spawnTimeoutMs() {
  const value = Number(process.env.AGENTS_APP_SPAWN_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

export const SPAWN_ID_OPTION = "@agents_spawn_id";

// The app sets the caller's spawn id on the pane it creates. That pane is found by the id alone,
// in whichever window and session the app put it, however many other panes appear meanwhile.
export async function createPaneThroughApp(currentSocketPath, token, descriptors, controlID, invokeParams) {
  if (!controlHasArgument(descriptors, controlID, "spawnID")) {
    fail(
      2,
      "appOutdated",
      `The running AgentsNext app advertises '${controlID}' without a 'spawnID' argument, so the pane it creates cannot be identified. Update AgentsNext.`
    );
  }
  const spawnID = requestID("spawn");
  const invokeResult = assertOK(
    await requestAppControl(currentSocketPath, token, "control.invoke", { ...invokeParams, spawnID }, "cli"),
    controlID
  );
  const deadline = Date.now() + spawnTimeoutMs();
  while (Date.now() < deadline) {
    const output = runTMux(["list-panes", "-a", "-F", `#{pane_id}\t#{${SPAWN_ID_OPTION}}`]) || "";
    const paneIDs = new Set(output.split(/\r?\n/)
      .map(line => line.split("\t"))
      .filter(([, id]) => id === spawnID)
      .map(([paneID]) => paneID));
    if (paneIDs.size === 1) {
      return { newPane: localPaneRef([...paneIDs][0]), spawnID, invokeResult };
    }
    if (paneIDs.size > 1) {
      fail(1, "spawnAmbiguous", `More than one pane carries spawn id '${spawnID}'.`, { spawnID, panes: [...paneIDs].map(localPaneRef) });
    }
    await sleep(100);
  }
  fail(
    1,
    "spawnTimedOut",
    `The app accepted '${controlID}' but no pane with spawn id '${spawnID}' appeared. A pane that shows up later carries ${SPAWN_ID_OPTION} '${spawnID}' and holds only a shell.`,
    { spawnID }
  );
}

export async function waitForPaneAddressable(currentSocketPath, token, paneRef) {
  const deadline = Date.now() + spawnTimeoutMs();
  while (Date.now() < deadline) {
    const response = await requestAppControl(
      currentSocketPath,
      token,
      "surface.read_text",
      { pane: paneRef, lines: 1 },
      "cli"
    );
    if (response.ok !== false) {
      return response.result;
    }
    const code = response.error?.code;
    if (code && !["unsupportedTarget", "disabled"].includes(code)) {
      fail(1, code, `surface readiness failed: ${response.error?.message || "unknown error"}`);
    }
    await sleep(100);
  }
  fail(1, "spawnTimedOut", `Timed out waiting for spawned pane '${paneRef}' to become addressable.`);
}

export function octalEscape(value) {
  return [...Buffer.from(value, "utf8")]
    .map(byte => `\\${byte.toString(8).padStart(3, "0")}`)
    .join("");
}

// How long a spawn waits for a question the new shell asks as it starts to be answered.
export const SHELL_QUESTION_WAIT_MS = 10 * 60 * 1000;

// Where the new pane's shell is (shell-prompt.ts): at its prompt, asking a question, or busy.
// tmux's output is kept as it is: the cursor's row counts the screen's leading blank lines.
export function paneShellState(paneID, stillMs) {
  const tmux = args => {
    const result = spawnSync("tmux", tmuxArgs(args), { encoding: "utf8", timeout: TMUX_TIMEOUT_MS });
    return result.status === 0 ? result.stdout.replace(/\n$/, "") : undefined;
  };
  const look = readPaneLook(paneID, tmux);
  if (!look) return { state: "busy", screen: "" };
  return { state: shellState(look, readTtyMode(look.tty), stillMs), screen: look.screen };
}

// The probe prints a marker that its own echo does not contain, so the marker shows up only once a
// shell has run it. It is typed only once the shell waits at its prompt: text typed while a startup
// file asks something (an updater's [Y/n]) would answer the question. While the shell asks, the wait
// stands still (the user answers it in the pane's terminal, which Agents Next shows), up to
// SHELL_QUESTION_WAIT_MS. Some prompts take typed input for themselves, so the probe is typed again
// at the next prompt after a while.
// The marker also says whether that shell finds the agent's executable: `exec` of a missing one
// ends the shell and closes the pane, leaving nothing to read the error from.
export async function waitForExecutableShell(currentSocketPath, token, paneRef, executable, cwd, shellAt = paneShellState) {
  const marker = `agents-app-shell-ready-${requestID("probe")}`;
  const found = `${marker}-found`;
  const missing = `${marker}-missing`;
  const check = executable.includes("/")
    ? `[ -x ${shellQuote(path.resolve(cwd || process.cwd(), executable))} ]`
    : `command -v ${shellQuote(executable)} >/dev/null 2>&1`;
  const probe = `${check} && printf '${octalEscape(`${found}\n`)}' || printf '${octalEscape(`${missing}\n`)}'`;
  const paneID = paneIDFromRef(paneRef);
  const questionDeadline = Date.now() + SHELL_QUESTION_WAIT_MS;
  let waitLeft = spawnTimeoutMs();
  let last = Date.now();
  let screen;
  let stillSince = Date.now();
  let typedAt;
  let state = "busy";

  for (;;) {
    const now = Date.now();
    // Time spent on a question is the user's: only the rest counts against the spawn's timeout.
    if (state !== "question") waitLeft -= now - last;
    last = now;
    const shell = shellAt(paneID, now - stillSince);
    if (shell.screen !== screen) {
      screen = shell.screen;
      stillSince = now;
    }
    state = shell.state;
    if (state === "question" && now >= questionDeadline) {
      fail(1, "spawnTimedOut", `The shell in '${paneRef}' asks a question that nobody answered in ${SHELL_QUESTION_WAIT_MS / 60000} minutes: ${lastLines(screen)}`);
    }
    if (waitLeft <= 0) {
      fail(1, "spawnTimedOut", `Timed out waiting for the shell in spawned pane '${paneRef}' to show its prompt; its screen ends: ${lastLines(screen)}`);
    }
    if (state === "prompt" && (typedAt === undefined || now - typedAt >= 3000)) {
      assertOK(
        await requestAppControl(
          currentSocketPath,
          token,
          "surface.send_text",
          { pane: paneRef, text: probe, submit: true },
          "cli"
        ),
        "surface readiness probe"
      );
      typedAt = Date.now();
    }
    await sleep(50);
    if (typedAt === undefined) continue;
    const response = await requestAppControl(
      currentSocketPath,
      token,
      "surface.read_text",
      { pane: paneRef, lines: 20 },
      "cli"
    );
    const output = response.ok !== false ? response.result?.output || "" : "";
    if (output.includes(found)) {
      return;
    }
    if (output.includes(missing)) {
      fail(
        1,
        "launchUnavailable",
        `The shell in '${paneRef}' cannot find '${executable}', so the agent would not start. Put it on the PATH that new tmux panes get, then finish the spawn with the recovery command.`
      );
    }
    const code = response.error?.code;
    if (code && !["unsupportedTarget", "disabled"].includes(code)) {
      fail(1, code, `shell readiness failed: ${response.error?.message || "unknown error"}`);
    }
  }
}

function lastLines(screen) {
  const lines = (screen || "").split("\n").map(line => line.trimEnd()).filter(Boolean).slice(-3);
  return lines.length > 0 ? lines.join(" / ") : "(empty)";
}

export async function runWorkspacePlacement(command, currentSocketPath) {
  const params = command.params;
  const placement = command.placement;
  const axis = (params.axis || "horizontal").toLowerCase();
  if (placement === "split" && !["horizontal", "vertical"].includes(axis)) {
    fail(64, "usage", "workspace split --axis must be 'horizontal' or 'vertical'.");
  }

  const sourcePane = resolveLocalSourcePane(params, `workspace ${placement}`);
  const controlID = placement === "tab" ? "workspace.create-local-tab" : "workspace.split-active-pane";
  const invokeParams = placement === "tab"
    ? { id: controlID, pane: sourcePane }
    : { id: controlID, pane: sourcePane, axis };
  const planned = {
    sourcePane,
    placement,
    axis: placement === "split" ? axis : undefined,
    controlID,
    invokeParams,
  };

  if (params["dry-run"]) {
    return {
      id: requestID("cli"),
      ok: true,
      result: {
        ...planned,
        dryRun: true,
      },
    };
  }

  const sourceRecord = canonicalSourcePaneRecord(sourcePane);
  if (!sourceRecord) {
    fail(2, "paneUnavailable", `Could not find source pane '${sourcePane}' in local tmux.`);
  }

  const token = readToken(currentSocketPath);
  const descriptors = assertOK(
    await requestAppControl(currentSocketPath, token, "control.list", { context: "focused-pane" }, "cli"),
    "controls list"
  );
  const { newPane, spawnID, invokeResult } = await createPaneThroughApp(
    currentSocketPath,
    token,
    descriptors,
    controlID,
    invokeParams
  );

  return {
    id: requestID("cli"),
    ok: true,
    result: {
      ...planned,
      newPane,
      spawnID,
      invokeResult,
    },
  };
}
