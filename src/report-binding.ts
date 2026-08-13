export interface TmuxReportBindingInput {
  requestedSession: string;
  reportedAgent: string;
  paneCwd?: string;
  paneOwner?: string;
  commandId?: string;
  commandContentKind?: string;
  commandOwner?: string;
  liveAgent?: string;
  foregroundAgent?: string;
}

export type TmuxReportBinding =
  | {
      owned: true;
      requestedSession: string;
      paneCwd?: string;
      reason: "managed-command" | "app-owned-live-agent" | "foreground-agent";
    }
  | {
      owned: false;
      requestedSession: string;
      reason: "unverified-pane";
    };

export function requiresTmuxReportProcessScan(input: TmuxReportBindingInput): boolean {
  return input.paneOwner === "app_owned" && !input.commandOwner?.trim();
}

export function resolveTmuxReportBinding(input: TmuxReportBindingInput): TmuxReportBinding {
  const reportedAgent = input.reportedAgent.trim().toLowerCase();
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
