import { appendFileSync } from "fs";
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

  appendFileSync(getRuntimeStateEventsPath(), `${JSON.stringify(event)}\n`);
  return event;
}
