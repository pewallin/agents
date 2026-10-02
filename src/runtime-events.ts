import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "fs";
import { getRuntimeStateEventsPath, ensureAgentsDirs } from "./paths.js";

export type RuntimeMux = "tmux" | "zellij";
export type RuntimeStateEventEntity = "primary_state" | "contributor_state";
export type RuntimeStateEventOperation = "upsert" | "remove";
export type RuntimeReportedState = "working" | "idle" | "approval" | "question";
export type RuntimeStateSource = "primary" | "contributor";

export interface RuntimeLocator {
  surfaceId: string;
  mux?: RuntimeMux;
}

export interface RuntimeStateEvent extends RuntimeLocator {
  v: 1;
  ts: number;
  entity: RuntimeStateEventEntity;
  op: RuntimeStateEventOperation;
  agent: string;
  reporter?: string;
  state?: RuntimeReportedState;
  intent?: string;
  clearIntent?: boolean;
  responsePreview?: string;
  clearResponsePreview?: boolean;
  detail?: string;
  externalSessionId?: string;
  stateSource?: RuntimeStateSource;
  primaryState?: RuntimeReportedState;
  auxiliaryReporters?: string[];
  activity?: boolean;
}

export interface RuntimeStateEventOptions {
  reporter?: string;
  state?: RuntimeReportedState;
  intent?: string;
  clearIntent?: boolean;
  responsePreview?: string;
  clearResponsePreview?: boolean;
  detail?: string;
  externalSessionId?: string;
  stateSource?: RuntimeStateSource;
  primaryState?: RuntimeReportedState;
  auxiliaryReporters?: string[];
  activity?: boolean;
}

const DEFAULT_RUNTIME_STATE_EVENTS_MAX_BYTES = 5 * 1024 * 1024;
const MIN_RUNTIME_STATE_EVENTS_MAX_BYTES = 256 * 1024;
const MAX_RUNTIME_STATE_EVENTS_MAX_BYTES = 25 * 1024 * 1024;

export function runtimeLocatorForSurface(surfaceId: string): RuntimeLocator {
  if (surfaceId.startsWith("%")) {
    return { surfaceId, mux: "tmux" };
  }
  if (surfaceId.startsWith("terminal_")) {
    return { surfaceId, mux: "zellij" };
  }
  return { surfaceId };
}

export function appendRuntimeStateEvent(
  entity: RuntimeStateEventEntity,
  op: RuntimeStateEventOperation,
  agent: string,
  surfaceId: string,
  optionsOrReporter?: RuntimeStateEventOptions | string,
): RuntimeStateEvent {
  ensureAgentsDirs();
  const options: RuntimeStateEventOptions = typeof optionsOrReporter === "string"
    ? { reporter: optionsOrReporter }
    : optionsOrReporter ?? {};

  const event: RuntimeStateEvent = {
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    entity,
    op,
    agent,
    ...runtimeLocatorForSurface(surfaceId),
    ...(options.reporter ? { reporter: options.reporter } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.clearIntent ? { clearIntent: true } : {}),
    ...(options.responsePreview ? { responsePreview: options.responsePreview } : {}),
    ...(options.clearResponsePreview ? { clearResponsePreview: true } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.externalSessionId ? { externalSessionId: options.externalSessionId } : {}),
    ...(options.stateSource ? { stateSource: options.stateSource } : {}),
    ...(options.primaryState ? { primaryState: options.primaryState } : {}),
    ...(options.auxiliaryReporters?.length ? { auxiliaryReporters: options.auxiliaryReporters } : {}),
    ...(options.activity !== undefined ? { activity: options.activity } : {}),
  };

  const eventPath = getRuntimeStateEventsPath();
  rotateRuntimeStateEventsIfNeeded(eventPath);
  appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
  return event;
}

/** Asks Agents Next to show a pane (it watches this log). Used instead of `switch-client`
 *  when the jump runs inside the app, whose tmux client must stay where it is. */
export function appendRuntimeFocusRequest(surfaceId: string): void {
  ensureAgentsDirs();
  const event = {
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    entity: "focus",
    op: "request",
    agent: "agents",
    ...runtimeLocatorForSurface(surfaceId),
  };
  const eventPath = getRuntimeStateEventsPath();
  rotateRuntimeStateEventsIfNeeded(eventPath);
  appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
}

function rotateRuntimeStateEventsIfNeeded(eventPath: string): void {
  const maxBytes = runtimeStateEventsMaxBytes();
  if (!existsSync(eventPath)) return;
  if (statSync(eventPath).size < maxBytes) return;

  const archivePath = `${eventPath}.1`;
  rmSync(archivePath, { force: true });
  renameSync(eventPath, archivePath);
}

function runtimeStateEventsMaxBytes(): number {
  const rawValue = process.env.AGENTS_RUNTIME_STATE_EVENTS_MAX_BYTES;
  if (!rawValue) return DEFAULT_RUNTIME_STATE_EVENTS_MAX_BYTES;

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_RUNTIME_STATE_EVENTS_MAX_BYTES;
  }
  return Math.min(
    Math.max(parsedValue, MIN_RUNTIME_STATE_EVENTS_MAX_BYTES),
    MAX_RUNTIME_STATE_EVENTS_MAX_BYTES,
  );
}
