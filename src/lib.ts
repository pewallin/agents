import { loadConfig, getProfileNames, resolveProfile, type Config, type LaunchProfile } from "./config.js";
import { scan, runtimeStates, getSessionHistory, type AgentPane, type AgentRuntimeState, type AgentSessionHistoryGroup } from "./scanner.js";
import { resumeAgentSession, type AgentSessionResumeResult, type ResumeAgentSessionOptions } from "./resume.js";
import type { RuntimeLocator, RuntimeStateEvent, RuntimeStateEventEntity, RuntimeStateEventOperation, RuntimeMux } from "./runtime-events.js";
import {
  listImplementationTargets,
  resolveImplementationTarget,
  createImplementationCheckout,
  getImplementationCheckoutStatus,
  startImplementationSession,
  resumeImplementationSession,
  listTargetAgentSessions,
  AgentsRuntimeError,
  type CheckoutCreateOptions,
  type CheckoutCreateResult,
  type CheckoutStatusOptions,
  type CheckoutStatusResult,
  type ImplementationCheckout,
  type ImplementationTarget,
  type RuntimeFailureShape,
  type RuntimePhase,
  type SessionResumeOptions,
  type SessionResumeResult,
  type SessionStartOptions,
  type SessionStartResult,
  type TargetListOptions,
  type ResolveTargetOptions,
  type TargetAgentSessionEntry,
  type TargetAgentSessionsOptions,
  type TargetAgentSessionsResult,
} from "./implementation-runtime.js";
import {
  createWorkspaceOrThrow,
  resolveWorkspaceLaunch,
  getRestorableWorkspaces,
  getRestorableWorkspacesFromStates,
  getWorkspacePathState,
  prepareWorkspaceDir,
  type CreateWorkspaceOpts,
  type ResolvedWorkspaceLaunch,
  type WorkspaceLaunchResult,
  type WorkspaceLaunchDiscovery,
  type RestorableWorkspace,
  type WorkspacePathState,
} from "./workspace.js";

export type {
  AgentPane,
  AgentRuntimeState,
  AgentSessionHistoryGroup,
  AgentSessionResumeResult,
  ResumeAgentSessionOptions,
  RuntimeLocator,
  RuntimeMux,
  RuntimeStateEvent,
  RuntimeStateEventEntity,
  RuntimeStateEventOperation,
  Config,
  LaunchProfile,
  CreateWorkspaceOpts,
  ResolvedWorkspaceLaunch,
  WorkspaceLaunchResult,
  WorkspaceLaunchDiscovery,
  RestorableWorkspace,
  WorkspacePathState,
  CheckoutCreateOptions,
  CheckoutCreateResult,
  CheckoutStatusOptions,
  CheckoutStatusResult,
  ImplementationCheckout,
  ImplementationTarget,
  RuntimeFailureShape,
  RuntimePhase,
  SessionResumeOptions,
  SessionResumeResult,
  SessionStartOptions,
  SessionStartResult,
  TargetListOptions,
  ResolveTargetOptions,
  TargetAgentSessionEntry,
  TargetAgentSessionsOptions,
  TargetAgentSessionsResult,
};

export interface LaunchWorkspaceOptions extends Partial<CreateWorkspaceOpts> {
  profile?: string;
  overrides?: string[];
}

export function loadAgentsConfig(): Config {
  return loadConfig();
}

export function listProfiles(): string[] {
  return getProfileNames();
}

export function getProfile(profileName?: string): LaunchProfile {
  return resolveProfile(profileName);
}

export function listAgents(): AgentPane[] {
  return scan();
}

export function listAgentRuntimeStates(paneIds?: string[]): AgentRuntimeState[] {
  return runtimeStates(paneIds);
}

export function listAgentSessionHistory(opts: { agent?: string; cwd?: string; pane?: string; limit?: number } = {}): AgentSessionHistoryGroup[] {
  return getSessionHistory(opts);
}

export function resumeAgentSessionInPane(options: ResumeAgentSessionOptions): AgentSessionResumeResult {
  return resumeAgentSession(options);
}

export function resolveWorkspaceCommand(options: LaunchWorkspaceOptions = {}): ResolvedWorkspaceLaunch {
  const { profile, overrides = [], name, layout, ...workspaceOpts } = options;
  return resolveWorkspaceLaunch(undefined, name, layout, { ...workspaceOpts, profile, overrideArgs: overrides });
}

export function launchWorkspace(options: LaunchWorkspaceOptions = {}): WorkspaceLaunchResult {
  const { profile, overrides = [], name, layout, ...workspaceOpts } = options;
  return createWorkspaceOrThrow(undefined, name, layout, { ...workspaceOpts, profile, overrideArgs: overrides });
}

export {
  AgentsRuntimeError,
  listImplementationTargets,
  resolveImplementationTarget,
  createImplementationCheckout,
  getImplementationCheckoutStatus,
  startImplementationSession,
  resumeImplementationSession,
  listTargetAgentSessions,
  getRestorableWorkspaces,
  getRestorableWorkspacesFromStates,
  getWorkspacePathState,
  prepareWorkspaceDir,
};
