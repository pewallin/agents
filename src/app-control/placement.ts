// @ts-nocheck
// New panes through the app: splits, tabs and waiting for their shell.

import path from "node:path";
import { readToken, requestAppControl, requestID } from "./app-socket.js";
import { assertOK, controlHasArgument, shellQuote } from "./launch.js";
import { fail, usage } from "./output.js";
import { canonicalSourcePaneRecord, localPaneRef, resolveLocalSourcePane, runTMux } from "./panes.js";

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

// The probe prints a marker that its own echo does not contain, so the marker shows up only once a
// shell has run it. Text typed before the shell reads its terminal waits there, so nothing is
// interrupted: a Ctrl-C here could cut a slow shell startup file short. Some startup prompts eat
// typed input, so the probe is typed again now and then.
// The marker also says whether that shell finds the agent's executable: `exec` of a missing one
// ends the shell and closes the pane, leaving nothing to read the error from.
export async function waitForExecutableShell(currentSocketPath, token, paneRef, executable, cwd) {
  const marker = `agents-app-shell-ready-${requestID("probe")}`;
  const found = `${marker}-found`;
  const missing = `${marker}-missing`;
  const check = executable.includes("/")
    ? `[ -x ${shellQuote(path.resolve(cwd || process.cwd(), executable))} ]`
    : `command -v ${shellQuote(executable)} >/dev/null 2>&1`;
  const probe = `${check} && printf '${octalEscape(`${found}\n`)}' || printf '${octalEscape(`${missing}\n`)}'`;
  const deadline = Date.now() + spawnTimeoutMs();
  let nextProbeAt = 0;

  while (Date.now() < deadline) {
    if (Date.now() >= nextProbeAt) {
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
      nextProbeAt = Date.now() + 3000;
    }
    await sleep(150);
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
  fail(1, "spawnTimedOut", `Timed out waiting for spawned pane '${paneRef}' to start an executable shell.`);
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
