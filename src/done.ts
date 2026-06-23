import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { ensureAgentsDirs, getDoneStorePath } from "./paths.js";

export const AGENTS_DONE_CONTRACT_VERSION = 1;

export interface DoneTmuxContext {
  session?: string | null;
  window?: string | null;
  pane?: string | null;
}

export interface AgentDoneRecord {
  doneEventID: string;
  sessionIdentity: string;
  hostID: string;
  tmux: DoneTmuxContext;
  agentKind: string;
  externalSessionID?: string | null;
  title: string;
  detail?: string | null;
  statusSnapshot: string;
  createdAt: string;
  acknowledged: boolean;
  cleared: boolean;
}

export interface AgentPinnedSession {
  sessionIdentity: string;
  hostID: string;
  tmux: DoneTmuxContext;
  agentKind?: string | null;
  externalSessionID?: string | null;
  title?: string | null;
  detail?: string | null;
  latestDoneEventID?: string | null;
  pinnedAt: string;
}

export interface AgentDoneProjection {
  contractVersion: 1;
  records: AgentDoneRecord[];
  pinnedSessions: AgentPinnedSession[];
}

export interface AgentDoneRecordInput {
  contractVersion?: number;
  doneEventID?: string;
  sessionIdentity?: string;
  hostID?: string;
  tmux?: DoneTmuxContext;
  agentKind?: string;
  externalSessionID?: string | null;
  externalSessionId?: string | null;
  title?: string;
  detail?: string | null;
  statusSnapshot?: string;
  createdAt?: string;
  acknowledged?: boolean;
  cleared?: boolean;
}

export interface DoneUpdateOptions {
  doneEventID?: string;
  sessionIdentity?: string;
  externalSessionID?: string;
  pin?: boolean;
  acknowledge?: boolean;
  clear?: boolean;
}

interface StoredDoneProjection {
  contractVersion?: number;
  records?: unknown;
  pinnedSessions?: unknown;
}

export class AgentDoneError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentDoneError";
  }
}

export function listDoneProjection(): AgentDoneProjection {
  return normalizeProjection(readStore());
}

export function recordDoneEvent(input: AgentDoneRecordInput): AgentDoneProjection {
  const projection = normalizeProjection(readStore());
  const record = normalizeRecordInput(input);
  const existingIndex = projection.records.findIndex((candidate) => candidate.doneEventID === record.doneEventID);

  if (existingIndex >= 0) {
    projection.records[existingIndex] = {
      ...projection.records[existingIndex],
      ...record,
      acknowledged: record.acknowledged,
      cleared: record.cleared,
    };
  } else {
    projection.records.push(record);
  }

  projection.records.sort(compareRecordsNewestFirst);
  projection.pinnedSessions = projection.pinnedSessions.map((session) => (
    session.sessionIdentity === record.sessionIdentity
      ? pinnedSessionFromRecord(record, session.pinnedAt)
      : session
  ));

  writeStore(projection);
  return projection;
}

export function updateDoneProjection(options: DoneUpdateOptions): AgentDoneProjection {
  const projection = normalizeProjection(readStore());
  const hasDoneMutation = options.acknowledge !== undefined || options.clear !== undefined;
  const hasPinMutation = options.pin !== undefined;

  if (!hasDoneMutation && !hasPinMutation) {
    throw new AgentDoneError("missing_update", "Pass at least one of --pin, --acknowledge, or --clear.");
  }

  if (hasDoneMutation) {
    if (!optionalString(options.doneEventID)) {
      throw new AgentDoneError("missing_done_event_id", "--acknowledge and --clear require --done-event-id.");
    }
    const index = projection.records.findIndex((record) => record.doneEventID === options.doneEventID);
    if (index < 0) {
      throw new AgentDoneError("done_event_not_found", `No Done event found for ${options.doneEventID}.`);
    }
    projection.records[index] = {
      ...projection.records[index],
      ...(options.acknowledge !== undefined ? { acknowledged: options.acknowledge } : {}),
      ...(options.clear !== undefined ? { cleared: options.clear } : {}),
    };
  }

  if (hasPinMutation) {
    const sessionIdentity = resolveUpdateSessionIdentity(projection, options);
    if (options.pin) {
      const latest = latestRecordForSession(projection, sessionIdentity, options.externalSessionID);
      const existing = projection.pinnedSessions.find((session) => session.sessionIdentity === sessionIdentity);
      const pinned = latest
        ? pinnedSessionFromRecord(latest, existing?.pinnedAt ?? isoTimestamp())
        : {
            sessionIdentity,
            hostID: "local",
            tmux: {},
            agentKind: null,
            externalSessionID: options.externalSessionID ?? null,
            title: null,
            detail: null,
            latestDoneEventID: null,
            pinnedAt: existing?.pinnedAt ?? isoTimestamp(),
          };

      projection.pinnedSessions = [
        ...projection.pinnedSessions.filter((session) => session.sessionIdentity !== sessionIdentity),
        pinned,
      ].sort(comparePinnedSessionsNewestFirst);
    } else {
      projection.pinnedSessions = projection.pinnedSessions.filter((session) => session.sessionIdentity !== sessionIdentity);
    }
  }

  projection.records.sort(compareRecordsNewestFirst);
  projection.pinnedSessions.sort(comparePinnedSessionsNewestFirst);
  writeStore(projection);
  return projection;
}

function normalizeRecordInput(input: AgentDoneRecordInput): AgentDoneRecord {
  if (input.contractVersion !== undefined && input.contractVersion !== AGENTS_DONE_CONTRACT_VERSION) {
    throw new AgentDoneError("unsupported_contract_version", `Unsupported agents done contract version ${input.contractVersion}.`);
  }

  const hostID = requiredString(input.hostID, "hostID");
  const agentKind = requiredString(input.agentKind, "agentKind");
  const externalSessionID = optionalString(input.externalSessionID ?? input.externalSessionId);
  const tmux = normalizeTmux(input.tmux);
  const sessionIdentity = optionalString(input.sessionIdentity)
    ?? externalSessionID
    ?? fallbackSessionIdentity(hostID, tmux, agentKind);
  const createdAt = normalizeTimestamp(input.createdAt, "createdAt");

  return {
    doneEventID: optionalString(input.doneEventID) ?? generateDoneEventID(createdAt, sessionIdentity),
    sessionIdentity,
    hostID,
    tmux,
    agentKind,
    externalSessionID: externalSessionID ?? null,
    title: requiredString(input.title, "title"),
    detail: optionalString(input.detail) ?? null,
    statusSnapshot: requiredString(input.statusSnapshot, "statusSnapshot"),
    createdAt,
    acknowledged: input.acknowledged ?? false,
    cleared: input.cleared ?? false,
  };
}

function readStore(): AgentDoneProjection {
  ensureAgentsDirs();
  const path = getDoneStorePath();
  if (!existsSync(path)) return emptyProjection();

  let parsed: StoredDoneProjection;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as StoredDoneProjection;
  } catch (error) {
    throw new AgentDoneError("corrupt_store", `Could not parse agents Done store at ${path}: ${errorMessage(error)}`);
  }

  return normalizeProjection(parsed);
}

function writeStore(projection: AgentDoneProjection): void {
  ensureAgentsDirs();
  const path = getDoneStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(projection, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function normalizeProjection(raw: StoredDoneProjection | AgentDoneProjection): AgentDoneProjection {
  if (raw.contractVersion !== undefined && raw.contractVersion !== AGENTS_DONE_CONTRACT_VERSION) {
    throw new AgentDoneError("unsupported_contract_version", `Unsupported agents done contract version ${raw.contractVersion}.`);
  }

  const records = Array.isArray(raw.records)
    ? raw.records.map((record, index) => normalizeStoredRecord(record, index))
    : [];
  const pinnedSessions = Array.isArray(raw.pinnedSessions)
    ? raw.pinnedSessions.map((session, index) => normalizeStoredPinnedSession(session, index))
    : [];

  return {
    contractVersion: AGENTS_DONE_CONTRACT_VERSION,
    records: records.sort(compareRecordsNewestFirst),
    pinnedSessions: pinnedSessions.sort(comparePinnedSessionsNewestFirst),
  };
}

function normalizeStoredRecord(value: unknown, index: number): AgentDoneRecord {
  if (!isRecord(value)) {
    throw new AgentDoneError("invalid_store", `Invalid Done record at records[${index}].`);
  }

  const record = value as Partial<AgentDoneRecord>;
  return {
    doneEventID: requiredString(record.doneEventID, `records[${index}].doneEventID`),
    sessionIdentity: requiredString(record.sessionIdentity, `records[${index}].sessionIdentity`),
    hostID: requiredString(record.hostID, `records[${index}].hostID`),
    tmux: normalizeTmux(record.tmux),
    agentKind: requiredString(record.agentKind, `records[${index}].agentKind`),
    externalSessionID: optionalString(record.externalSessionID) ?? null,
    title: requiredString(record.title, `records[${index}].title`),
    detail: optionalString(record.detail) ?? null,
    statusSnapshot: requiredString(record.statusSnapshot, `records[${index}].statusSnapshot`),
    createdAt: normalizeTimestamp(record.createdAt, `records[${index}].createdAt`),
    acknowledged: record.acknowledged === true,
    cleared: record.cleared === true,
  };
}

function normalizeStoredPinnedSession(value: unknown, index: number): AgentPinnedSession {
  if (!isRecord(value)) {
    throw new AgentDoneError("invalid_store", `Invalid pinned session at pinnedSessions[${index}].`);
  }

  const session = value as Partial<AgentPinnedSession>;
  return {
    sessionIdentity: requiredString(session.sessionIdentity, `pinnedSessions[${index}].sessionIdentity`),
    hostID: requiredString(session.hostID, `pinnedSessions[${index}].hostID`),
    tmux: normalizeTmux(session.tmux),
    agentKind: optionalString(session.agentKind) ?? null,
    externalSessionID: optionalString(session.externalSessionID) ?? null,
    title: optionalString(session.title) ?? null,
    detail: optionalString(session.detail) ?? null,
    latestDoneEventID: optionalString(session.latestDoneEventID) ?? null,
    pinnedAt: normalizeTimestamp(session.pinnedAt, `pinnedSessions[${index}].pinnedAt`),
  };
}

function resolveUpdateSessionIdentity(projection: AgentDoneProjection, options: DoneUpdateOptions): string {
  const explicit = optionalString(options.sessionIdentity);
  if (explicit) return explicit;

  const externalSessionID = optionalString(options.externalSessionID);
  if (externalSessionID) {
    return latestRecordForSession(projection, externalSessionID, externalSessionID)?.sessionIdentity
      ?? projection.pinnedSessions.find((session) => session.externalSessionID === externalSessionID)?.sessionIdentity
      ?? externalSessionID;
  }

  throw new AgentDoneError("missing_session_identity", "--pin requires --session-identity or --external-session-id.");
}

function latestRecordForSession(
  projection: AgentDoneProjection,
  sessionIdentity: string,
  externalSessionID?: string,
): AgentDoneRecord | undefined {
  return projection.records.find((record) => (
    record.sessionIdentity === sessionIdentity
    || (externalSessionID !== undefined && record.externalSessionID === externalSessionID)
  ));
}

function pinnedSessionFromRecord(record: AgentDoneRecord, pinnedAt: string): AgentPinnedSession {
  return {
    sessionIdentity: record.sessionIdentity,
    hostID: record.hostID,
    tmux: record.tmux,
    agentKind: record.agentKind,
    externalSessionID: record.externalSessionID ?? null,
    title: record.title,
    detail: record.detail ?? null,
    latestDoneEventID: record.doneEventID,
    pinnedAt,
  };
}

function normalizeTmux(value: unknown): DoneTmuxContext {
  if (!isRecord(value)) return {};
  return {
    session: optionalString(value.session) ?? null,
    window: optionalString(value.window) ?? null,
    pane: optionalString(value.pane) ?? null,
  };
}

function fallbackSessionIdentity(hostID: string, tmux: DoneTmuxContext, agentKind: string): string {
  const components = [hostID, tmux.session, tmux.window, tmux.pane, agentKind]
    .map((component) => optionalString(component)?.replaceAll("|", "%7C") ?? "");
  if (components.every(Boolean)) return components.join("|");
  throw new AgentDoneError("missing_session_identity", "Done record requires sessionIdentity, externalSessionID, or complete host/tmux/agent identity.");
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new AgentDoneError("missing_field", `Missing required field ${field}.`);
  }
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeTimestamp(value: unknown, field: string): string {
  const text = optionalString(value);
  const date = text ? new Date(text) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new AgentDoneError("invalid_timestamp", `Invalid timestamp for ${field}.`);
  }
  return isoTimestamp(date);
}

function isoTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function generateDoneEventID(createdAt: string, sessionIdentity: string): string {
  const timestamp = createdAt.replace(/[^0-9A-Za-z]/g, "");
  const identity = sessionIdentity.replace(/[^0-9A-Za-z_-]/g, "-").slice(0, 48);
  return `done-${timestamp}-${identity}-${randomUUID().slice(0, 8)}`;
}

function compareRecordsNewestFirst(lhs: AgentDoneRecord, rhs: AgentDoneRecord): number {
  const createdDiff = Date.parse(rhs.createdAt) - Date.parse(lhs.createdAt);
  if (createdDiff !== 0) return createdDiff;
  return rhs.doneEventID.localeCompare(lhs.doneEventID);
}

function comparePinnedSessionsNewestFirst(lhs: AgentPinnedSession, rhs: AgentPinnedSession): number {
  const pinnedDiff = Date.parse(rhs.pinnedAt) - Date.parse(lhs.pinnedAt);
  if (pinnedDiff !== 0) return pinnedDiff;
  return rhs.sessionIdentity.localeCompare(lhs.sessionIdentity);
}

function emptyProjection(): AgentDoneProjection {
  return {
    contractVersion: AGENTS_DONE_CONTRACT_VERSION,
    records: [],
    pinnedSessions: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
