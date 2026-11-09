// @ts-nocheck
// agent spawn.

import fs from "node:fs";
import path from "node:path";
import { readAgentStateForPane } from "./agent-state.js";
import { readToken, requestAppControl, requestID } from "./app-socket.js";
import { LANGUAGE_OPTION, coordinatorLanguage, ensureSharedCLI, workerPrompt, writeBrief, writeTaskMeta } from "./briefs.js";
import { inheritCoordinatorBackground } from "./coordinator.js";
import { agentLaunch, agentNameFromLaunchCommand, agentProfile, assertOK, buildNewAgentArgv, controlHasArgument, normalizeAgentName, renderLaunchCommand } from "./launch.js";
import { fail, setFailureContext, usage } from "./output.js";
import { canonicalSourcePaneRecord, localPaneRef, paneIDFromRef, resolveLocalSourcePane, setPaneOption, tmuxPaneOption } from "./panes.js";
import { createPaneThroughApp, waitForExecutableShell, waitForPaneAddressable } from "./placement.js";
import { coordinationPaneRecords, coordinatorProgram, ensurePaneUUID, notifyApp, resolveCoordinatorProgram, taskPaths, uniqueTaskName, waitForPaneUUID, workspaceWindowID } from "./program.js";
import { respawnMarker } from "./promote.js";
import { acpPromptSupported, acquireSpawnLock, briefInViewLaunch, failStartup, noteSubWorker, paneProcesses, showACPView, spawnRecovery, spawnSummary, startupWaitMs, subWorkerLead, watchAgentStartup } from "./spawn-support.js";
import { ensureSupervisor } from "./supervisor-control.js";

export async function runAgentSpawn(command, currentSocketPath) {
  const params = command.params;
  const requestedPlacement = (params.placement || "auto").toLowerCase();
  const axis = (params.axis || "horizontal").toLowerCase();
  if (!["auto", "split", "tab"].includes(requestedPlacement)) {
    fail(64, "usage", "agent spawn --placement must be 'auto', 'split' or 'tab'.");
  }
  if (!["horizontal", "vertical"].includes(axis)) {
    fail(64, "usage", "agent spawn --axis must be 'horizontal' or 'vertical'.");
  }

  const sourcePane = resolveLocalSourcePane(params, "agent spawn");
  // --into finishes a spawn in a pane that already exists, typically one a failed spawn left behind.
  const intoPane = params.into ? resolveLocalSourcePane({ pane: params.into }, "agent spawn --into") : undefined;
  const parentPane = params["no-parent"]
    ? undefined
    : (params.parent ? resolveLocalSourcePane({ pane: params.parent }, "agent spawn --parent") : sourcePane);
  const respawn = command.respawn;
  // Spawns from one parent take turns from here until the new pane is marked as its child, so
  // that workers started together still share one split instead of each opening another.
  const releaseSpawnLock = parentPane && !params["dry-run"] && !params.into
    ? await acquireSpawnLock(paneIDFromRef(parentPane))
    : () => {};
  const records = parentPane || respawn ? coordinationPaneRecords() : [];
  // A pane tmux does not know cannot be a parent; the spawn then fails on the source pane, or is a dry run.
  const parentRecord = parentPane ? records.find(record => record.paneID === paneIDFromRef(parentPane)) : undefined;
  if (params.parent && !parentRecord) {
    fail(2, "paneUnavailable", `Could not find parent pane '${parentPane}' in local tmux.`);
  }
  // Children of one parent share a slot: the first one splits from the parent, later ones are its
  // tabs. Only a child in the parent's own workspace is that slot: one moved to another workspace
  // or session took its place with it, and a tab of it would open away from the parent.
  const parentWindow = parentRecord && workspaceWindowID(parentRecord, records);
  const tabSlot = parentRecord && requestedPlacement === "auto" && parentRecord.uuid
    ? records.find(record => record.parent === parentRecord.uuid && !record.tabOf
      && record.paneID !== parentRecord.paneID && record.windowID === parentWindow)
    : undefined;
  const placement = requestedPlacement === "auto" ? (tabSlot ? "tab" : "split") : requestedPlacement;
  const placementPane = tabSlot ? localPaneRef(tabSlot.paneID) : sourcePane;

  let task;
  let program;
  const sub = subWorkerLead(parentRecord, params, records, "start", !respawn);
  if (parentRecord) {
    program = respawn?.program
      || (params.program && path.resolve(params.program))
      || resolveCoordinatorProgram(parentRecord, undefined, records).program;
    task = respawn?.task || uniqueTaskName(command.prompt, records, program, params.task);
  }

  const state = readAgentStateForPane(sourcePane);
  const profile = params.profile ? agentProfile(params.profile) : undefined;
  // A respawned worker keeps its own harness; a new one gets its source pane's.
  const launchCommand = profile?.command
    || params["launch-command"]
    || respawn?.launchCommand
    || tmuxPaneOption(sourcePane, "@agents_command_launch");
  if (!launchCommand) {
    fail(2, "launchUnavailable", `Pane '${sourcePane}' does not expose @agents_command_launch. Start the agent through the AgentsNext/agents harness first, or pass --launch-command.`);
  }
  const cwd = params.cwd
    || respawn?.cwd
    || tmuxPaneOption(sourcePane, "@agents_command_cwd")
    || state?.workspace?.cwd;
  let launchAgent;
  try {
    launchAgent = agentNameFromLaunchCommand(launchCommand);
  } catch (error) {
    fail(1, "launchParseFailed", error.message);
  }
  const stateAgent = state?.agent ? normalizeAgentName(state.agent) : undefined;
  // A respawned worker keeps the model it was started with, unless it is given another harness.
  const keptModel = respawn && launchCommand === respawn.launchCommand ? respawn.model : undefined;
  const explicitModel = params.model || keptModel;
  // Another harness than the source pane's does not take its model.
  const model = explicitModel || (!profile && stateAgent === launchAgent ? state?.modelId || state?.model : undefined);
  const taskFiles = task ? taskPaths(program, task) : undefined;
  const language = task ? coordinatorLanguage(params, parentRecord) : undefined;
  const prompt = task
    ? workerPrompt(task, taskFiles, parentRecord, Boolean(respawn), language, respawn?.previousSession)
    : command.prompt;
  let launchPlan;
  try {
    launchPlan = buildNewAgentArgv(launchCommand, prompt, { model, explicitModel });
  } catch (error) {
    fail(1, "launchParseFailed", error.message);
  }
  const launch = agentLaunch(launchPlan.argv);
  const argv = launch.argv;
  let renderedLaunchCommand = renderLaunchCommand(launch, cwd);
  const planned = {
    sourcePane,
    placement: intoPane ? "into" : placement,
    placementPane: !intoPane && placementPane !== sourcePane ? placementPane : undefined,
    intoPane,
    axis: !intoPane && placement === "split" ? axis : undefined,
    parentPane: parentRecord ? localPaneRef(parentRecord.paneID) : undefined,
    task,
    program,
    language,
    brief: taskFiles?.brief,
    report: taskFiles?.report,
    harness: {
      agent: launchPlan.agent || state?.agent,
      profile: profile?.id,
      model,
      originalLaunchCommand: launchCommand,
    },
    launch: {
      cwd,
      argv,
      via: launch.via,
      command: renderedLaunchCommand,
    },
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
  if (intoPane && !canonicalSourcePaneRecord(intoPane)) {
    fail(2, "paneUnavailable", `Could not find pane '${intoPane}' in local tmux.`);
  }

  // The brief is on disk before the worker starts, so it can always be read again or respawned.
  let parentUUID;
  if (task) {
    parentUUID = ensurePaneUUID(parentRecord);
    if (!respawn) coordinatorProgram(parentRecord, params.program, records);
    if (!parentRecord.role) setPaneOption(localPaneRef(parentRecord.paneID), "@agents_role", "coordinator");
    if (!respawn) writeBrief(program, task, command.prompt, parentRecord, language);
    writeTaskMeta(program, task, { launchCommand, cwd, parentUUID, ...(sub ? { parentTask: sub.parentTask } : {}), ...(explicitModel ? { model: explicitModel } : {}) });
  }
  const markWorker = newPane => {
    if (!task) return;
    ensureSharedCLI();
    setPaneOption(newPane, "@agents_parent", parentUUID);
    setPaneOption(newPane, "@agents_role", "worker");
    setPaneOption(newPane, "@agents_task", task);
    setPaneOption(newPane, "@agents_program", program);
    setPaneOption(newPane, "@agents_report_state", "started");
    setPaneOption(newPane, "@agents_report_at", String(Math.floor(Date.now() / 1000)));
    // Its own sub-workers, should it start any, talk to the user in the same language.
    if (language) setPaneOption(newPane, LANGUAGE_OPTION, language);
    if (sub && !respawn) noteSubWorker(program, sub, task, command.prompt);
    ensureSupervisor(program);
    notifyApp(parentRecord.sessionName);
  };

  const token = readToken(currentSocketPath);
  let newPane;
  let spawnID;
  if (intoPane) {
    newPane = intoPane;
  } else {
    const descriptors = assertOK(
      await requestAppControl(currentSocketPath, token, "control.list", { context: "focused-pane" }, "cli"),
      "controls list"
    );
    const controlID = placement === "tab" ? "workspace.create-local-tab" : "workspace.split-active-pane";
    const invokeParams = placement === "tab"
      ? { id: controlID, pane: placementPane }
      : { id: controlID, pane: sourcePane, axis };
    // An agent with an ACP view: the app marks its pane when Settings › Agents › Open agents in
    // says ACP View, and the pane shows the view once the agent runs. A Codex shares its session
    // live with the view; another agent starts in the view, its brief the host's first prompt.
    if ((launch.via === "codex-session" || (launch.via === "acp-session" && acpPromptSupported()))
      && controlHasArgument(descriptors, controlID, "acpAgent")) {
      invokeParams.acpAgent = true;
    }
    ({ newPane, spawnID } = await createPaneThroughApp(currentSocketPath, token, descriptors, controlID, invokeParams));
  }
  setFailureContext({ newPane, spawnID, recovery: spawnRecovery(newPane, command, task, program, launchCommand, cwd) });
  markWorker(newPane);
  if (task) fs.rmSync(respawnMarker(program, task), { force: true });
  // The app names the panes it creates; a later child's tab refers to this pane by that name.
  if (task) await waitForPaneUUID(newPane);
  releaseSpawnLock();
  await waitForPaneAddressable(currentSocketPath, token, newPane);
  // Once the app shows the pane: before, it has no workspace to keep the color in.
  const background = task ? await inheritCoordinatorBackground(parentRecord.paneID, newPane) : undefined;
  await waitForExecutableShell(currentSocketPath, token, newPane, argv[0], cwd);
  if (launch.via === "acp-session" && tmuxPaneOption(newPane, "@agents_open_in") === "acp-view") {
    renderedLaunchCommand = renderLaunchCommand(briefInViewLaunch(launchPlan, prompt, newPane), cwd);
    planned.launch.command = renderedLaunchCommand;
  }
  const startupWait = startupWaitMs(params);
  if (startupWait > 0) setPaneOption(newPane, "remain-on-exit", "on");
  const before = startupWait > 0 ? paneProcesses(newPane) : undefined;
  const sendResult = assertOK(
    await requestAppControl(
      currentSocketPath,
      token,
      "surface.send_text",
      { pane: newPane, text: renderedLaunchCommand, submit: true },
      "cli"
    ),
    "surface send-text"
  );
  const startup = startupWait > 0 ? await watchAgentStartup(newPane, startupWait, before) : { checked: false };
  if (startup.started === false) {
    failStartup(newPane, startup, { planned, task, program, command, launchCommand, cwd });
  }
  const acpView = tmuxPaneOption(newPane, "@agents_open_in") === "acp-view"
    ? await showACPView(currentSocketPath, token, newPane)
    : undefined;

  return {
    id: requestID("cli"),
    ok: true,
    result: {
      ...spawnSummary(planned, task),
      newPane,
      spawnID,
      background,
      startup,
      ...(acpView === undefined ? {} : { acpView }),
      sendText: task ? undefined : sendResult,
    },
  };
}
