export interface TmuxReportBindingInput {
  requestedSession: string;
  reportedAgent: string;
  paneCwd?: string;
  commandId?: string;
  commandContentKind?: string;
  commandOwner?: string;
  foregroundAgent?: string;
}

export type TmuxReportBinding =
  | {
      owned: true;
      requestedSession: string;
      paneCwd?: string;
      reason: "managed-command" | "foreground-agent";
    }
  | {
      owned: false;
      requestedSession: string;
      reason: "unverified-pane";
    };

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
