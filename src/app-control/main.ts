// @ts-nocheck
// agents app-control: run one command.

import { controlHelp, createWorkspace, helpTopics, invokeControl, listState, openReview, ownPane, topicHelp } from "./app-commands.js";
import { readToken, requestAppControl, requestID, socketPath } from "./app-socket.js";
import { runAgentAsk } from "./ask.js";
import { ensureSharedCLI } from "./briefs.js";
import { parseCommand } from "./command.js";
import { runMCPServer } from "./mcp.js";
import { runAgentNotify } from "./notify.js";
import { runAgentEdit } from "./answer-edits.js";
import { writeFeedback } from "./feedback.js";
import { outputResponse, setCommandArgv, usage } from "./output.js";
import { runWorkspacePlacement } from "./placement.js";
import { runAgentAdopt, runAgentPromote, runAgentProtocol, runAgentRespawn } from "./promote.js";
import { runAgentClose, runAgentReport, runAgentStatus, runAgentWait } from "./report.js";
import { runAgentDelivery, runAgentSend } from "./send.js";
import { runAgentSpawn } from "./spawn.js";
import { runAgentName, runAgentRemove, runAgentReopen, runAgentResolve, runAgentTitle } from "./thread-commands.js";
import { runSupervisor } from "./supervisor.js";
import { runAgentRemind, runAgentWatch } from "./watch.js";

export async function runAppControl(argv) {
  setCommandArgv(argv);
  const command = parseCommand(argv);
  const currentSocketPath = socketPath();
  if (command.kind === "help") {
    const text = !command.topic
      ? usage()
      : topicHelp(command.topic)
        ?? (command.topic === "agent" ? usage().split("\n").filter(line => / agent /.test(line)).join("\n") : undefined)
        ?? (command.topic.includes(".") ? await controlHelp(currentSocketPath, command.topic) : undefined)
        ?? `No help for '${command.topic}'. Topics: ${helpTopics().join(", ")}, agent, or a control id (agents app controls list).`;
    process.stdout.write(`${text}\n`);
    process.exit(0);
  }
  if (command.kind === "feedback") {
    const { result, error } = writeFeedback({ happened: command.happened, command: command.params.command, suggestion: command.params.suggestion });
    outputResponse({ id: requestID("cli"), ok: !error, ...(error ? { error } : { result }) });
  }
  if (command.kind === "ls") {
    outputResponse(await listState(currentSocketPath));
  }
  if (command.kind === "invoke") {
    outputResponse(await invokeControl(currentSocketPath, command.controlID, command.params));
  }
  if (command.kind === "workspace-new") {
    outputResponse(await createWorkspace(currentSocketPath, command.params));
  }
  if (command.kind === "review") {
    outputResponse(await openReview(currentSocketPath, command.params));
  }
  if (command.kind === "workspace-placement") {
    outputResponse(await runWorkspacePlacement(command, currentSocketPath));
  }
  if (command.kind === "agent-spawn") {
    outputResponse(await runAgentSpawn(command, currentSocketPath));
  }
  if (command.kind === "agent-respawn") {
    outputResponse(await runAgentRespawn(command, currentSocketPath));
  }
  if (command.kind === "agent-report") {
    outputResponse(await runAgentReport(command));
  }
  if (command.kind === "agent-ask") {
    outputResponse(await runAgentAsk(command));
  }
  if (command.kind === "agent-status") {
    outputResponse(await runAgentStatus(command));
  }
  if (command.kind === "agent-wait") {
    outputResponse(await runAgentWait(command));
  }
  if (command.kind === "agent-close") {
    outputResponse(await runAgentClose(command));
  }
  if (command.kind === "agent-resolve") {
    outputResponse(await runAgentResolve(command));
  }
  if (command.kind === "agent-notify") {
    outputResponse(await runAgentNotify(command));
  }
  if (command.kind === "agent-edit") {
    outputResponse(await runAgentEdit(command));
  }
  if (command.kind === "agent-remove") {
    outputResponse(await runAgentRemove(command));
  }
  if (command.kind === "agent-name") {
    outputResponse(await runAgentName(command));
  }
  if (command.kind === "agent-title") {
    outputResponse(await runAgentTitle(command));
  }
  if (command.kind === "agent-reopen") {
    outputResponse(await runAgentReopen(command, currentSocketPath));
  }
  if (command.kind === "agent-send") {
    outputResponse(await runAgentSend(command));
  }
  if (command.kind === "agent-delivery") {
    outputResponse(await runAgentDelivery(command));
  }
  if (command.kind === "agent-promote") {
    outputResponse(await runAgentPromote(command));
  }
  if (command.kind === "agent-protocol") {
    outputResponse(await runAgentProtocol(command));
  }
  if (command.kind === "agent-adopt") {
    outputResponse(await runAgentAdopt(command));
  }
  if (command.kind === "agent-remind") {
    outputResponse(await runAgentRemind(command));
  }
  if (command.kind === "agent-watch") {
    outputResponse(await runAgentWatch(command));
  }
  if (command.kind === "mcp-wrapper") {
    // The stable launcher harnesses run the MCP server through (agents setup --mcp).
    outputResponse({ id: requestID("cli"), ok: true, result: { path: ensureSharedCLI() } });
  }
  if (command.kind === "mcp") {
    await runMCPServer(command);
    return;
  }
  if (command.kind === "agent-supervise") {
    await runSupervisor(command);
    process.exit(0);
  }

  const token = readToken(currentSocketPath);
  const response = await requestAppControl(currentSocketPath, token, command.method, command.params, "cli");
  if (command.method === "app.context" && response.ok !== false) {
    // The focused pane is the user's; an agent's own pane is `you`.
    response.result = { you: ownPane() || null, ...response.result };
  }
  outputResponse(response);
}
