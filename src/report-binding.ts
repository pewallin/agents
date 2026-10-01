import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { join } from "path";
import { getLogsDir } from "./paths.js";

export interface TmuxReportBindingInput {
  requestedSession: string;
  reportedAgent: string;
  paneCwd?: string;
  paneOwner?: string;
  commandId?: string;
  commandContentKind?: string;
  commandOwner?: string;
  reportedExternalSessionId?: string;
  expectedExternalSessionId?: string;
  liveAgent?: string;
  foregroundAgent?: string;
}

export type TmuxReportBinding =
  | {
      owned: true;
      requestedSession: string;
      paneCwd?: string;
      reason: "managed-command" | "app-owned-live-agent" | "live-descendant-agent" | "foreground-agent";
    }
  | {
      owned: false;
      requestedSession: string;
      reason: "unverified-pane";
    };

export function requiresTmuxReportProcessScan(input: TmuxReportBindingInput): boolean {
  const externalSessionConflicts = !!input.reportedExternalSessionId?.trim()
    && !!input.expectedExternalSessionId?.trim()
    && input.reportedExternalSessionId.trim() !== input.expectedExternalSessionId.trim();
  return externalSessionConflicts || (!input.commandOwner?.trim() && !input.foregroundAgent?.trim());
}

export function resolveTmuxReportBinding(input: TmuxReportBindingInput): TmuxReportBinding {
  const reportedAgent = input.reportedAgent.trim().toLowerCase();
  const externalSessionConflicts = !!input.reportedExternalSessionId?.trim()
    && !!input.expectedExternalSessionId?.trim()
    && input.reportedExternalSessionId.trim() !== input.expectedExternalSessionId.trim();

  if (externalSessionConflicts && input.liveAgent?.trim().toLowerCase() !== reportedAgent) {
    return {
      owned: false,
      requestedSession: input.requestedSession,
      reason: "unverified-pane",
    };
  }

  const managedCommandMatches = input.commandOwner === "launcher"
    && input.commandContentKind === "agent"
    && input.commandId?.trim().toLowerCase() === reportedAgent;

  if (managedCommandMatches) {
    return {
      owned: true,
      requestedSession: input.requestedSession,
      ...(input.paneCwd ? { paneCwd: input.paneCwd } : {}),
      reason: "managed-command",
    };
  }

  const appOwnedLiveAgentMatches = input.paneOwner === "app_owned"
    && !input.commandOwner?.trim()
    && input.liveAgent?.trim().toLowerCase() === reportedAgent;

  if (appOwnedLiveAgentMatches) {
    return {
      owned: true,
      requestedSession: input.requestedSession,
      ...(input.paneCwd ? { paneCwd: input.paneCwd } : {}),
      reason: "app-owned-live-agent",
    };
  }

  const ownerlessLiveAgentMatches = !input.paneOwner?.trim()
    && !input.commandOwner?.trim()
    && input.liveAgent?.trim().toLowerCase() === reportedAgent;

  if (ownerlessLiveAgentMatches) {
    return {
      owned: true,
      requestedSession: input.requestedSession,
      ...(input.paneCwd ? { paneCwd: input.paneCwd } : {}),
      reason: "live-descendant-agent",
    };
  }

  if (input.foregroundAgent?.trim().toLowerCase() === reportedAgent) {
    return {
      owned: true,
      requestedSession: input.requestedSession,
      ...(input.paneCwd ? { paneCwd: input.paneCwd } : {}),
      reason: "foreground-agent",
    };
  }

  return {
    owned: false,
    requestedSession: input.requestedSession,
    reason: "unverified-pane",
  };
}

/** A rejected report leaves no state, so it is written to the hook log with what the pane
 *  showed; otherwise an agent that is never verified looks the same as one never reporting. */
export function logRejectedReport(input: TmuxReportBindingInput): void {
  try {
    const dir = getLogsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "hooks.log");
    try {
      if (statSync(file).size > 262_144) renameSync(file, `${file}.1`);
    } catch {}
    const fields = [
      `pane=${input.requestedSession}`,
      `foreground=${input.foregroundAgent ?? "-"}`,
      `live=${input.liveAgent ?? "-"}`,
      `owner=${input.paneOwner ?? "-"}`,
      `command=${input.commandId ?? "-"}/${input.commandContentKind ?? "-"}/${input.commandOwner ?? "-"}`,
      `session=${input.reportedExternalSessionId ?? "-"}/${input.expectedExternalSessionId ?? "-"}`,
    ];
    appendFileSync(file, `${new Date().toISOString().replace(/\.\d+Z$/, "Z")} ${input.reportedAgent} rejected unverified-pane ${fields.join(" ")}\n`);
  } catch {}
}
