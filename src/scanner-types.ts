import type { ModelSource } from "./state.js";

export type AgentStatus = "attention" | "question" | "working" | "stalled" | "idle";

export interface AgentPane {
  pane: string;
  paneId: string;
  tmuxPaneId: string;
  title: string;
  intent?: string;
  responsePreview?: string;
  agent: string;
  status: AgentStatus;
  cpuPercent: number;
  memoryMB: number;
  detail?: string;
  provider?: string;
  modelId?: string;
  modelLabel?: string;
  modelSource?: ModelSource;
  model?: string;
  externalSessionId?: string;
  windowId?: string;
  cwd?: string;
  branch?: string;
  context?: string;
  contextTokens?: number;
  contextMax?: number;
  spend?: number;
  spendUnit?: string;
  stateSource?: "primary" | "contributor";
  primaryState?: string;
  auxiliaryReporters?: string[];
}

export interface AgentRuntimeState {
  session: string;
  /** The agent in the pane, and its harness's id of the session it runs (where known). */
  agent?: string;
  externalSessionId?: string;
  status: AgentStatus;
  cpuPercent: number;
  memoryMB: number;
  intent?: string;
  responsePreview?: string;
  detail?: string;
  provider?: string;
  modelId?: string;
  modelLabel?: string;
  modelSource?: ModelSource;
  model?: string;
  context?: string;
  contextTokens?: number;
  contextMax?: number;
  spend?: number;
  spendUnit?: string;
  stateSource?: "primary" | "contributor";
  primaryState?: string;
  auxiliaryReporters?: string[];
}
