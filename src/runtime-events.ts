import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "fs";
import { getRuntimeStateEventsPath, ensureAgentsDirs } from "./paths.js";

export type RuntimeMux = "tmux" | "zellij";
export type RuntimeStateEventEntity = "primary_state" | "contributor_state";
export type RuntimeStateEventOperation = "upsert" | "remove";

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
  reporter?: string,
): RuntimeStateEvent {
  ensureAgentsDirs();

  const event: RuntimeStateEvent = {
    v: 1,
    ts: Math.floor(Date.now() / 1000),
    entity,
    op,
    agent,
    ...runtimeLocatorForSurface(surfaceId),
    ...(reporter ? { reporter } : {}),
  };

  const eventPath = getRuntimeStateEventsPath();
  rotateRuntimeStateEventsIfNeeded(eventPath);
  appendFileSync(eventPath, `${JSON.stringify(event)}\n`);
  return event;
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
