import type { ModelSource } from "./state.js";

export type AgentStatus = "attention" | "question" | "working" | "stalled" | "idle";

export interface AgentPane {
  pane: string;
  paneId: string;
  tmuxPaneId: string;
  title: string;
  intent?: string;
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
  windowId?: string;
  cwd?: string;
  branch?: string;
  context?: string;
  contextTokens?: number;
  contextMax?: number;
  stateSource?: "primary" | "contributor";
  primaryState?: string;
  auxiliaryReporters?: string[];
}

export interface AgentRuntimeState {
  session: string;
  status: AgentStatus;
  cpuPercent: number;
  memoryMB: number;
  intent?: string;
  detail?: string;
  provider?: string;
  modelId?: string;
  modelLabel?: string;
  modelSource?: ModelSource;
  model?: string;
  context?: string;
  contextTokens?: number;
  contextMax?: number;
  stateSource?: "primary" | "contributor";
  primaryState?: string;
  auxiliaryReporters?: string[];
}
