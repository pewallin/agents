import { writeFileSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { ensureAgentsDirs, getContributorStateDir, getStateDir } from "./paths.js";

export type ReportedState = "working" | "idle" | "approval" | "question";
export type ModelSource = "hook" | "sdk" | "transcript" | "session-log" | "inferred";

export interface WorkspaceSnapshot {
  command: string;
  cwd: string;
  mux?: "tmux" | "zellij";
  sessionName?: string;
}

export interface ModelMetadata {
  provider?: string;
  modelId?: string;
  modelLabel?: string;
  modelSource?: ModelSource;
  model?: string;
}

export interface StateEntry extends ModelMetadata {
  state: ReportedState;
  ts: number;
  agent: string;
  session: string;
  detail?: string;         // transient activity detail (e.g. tool name, filename)
  externalSessionId?: string;
  context?: string;
  contextTokens?: number;
  contextMax?: number;
  workspace?: WorkspaceSnapshot;
  cleanup?: CleanupState;
}

export interface CleanupState {
  contentHash?: string;
  observedAt?: number;
  unchangedSamples?: number;
}

export interface ContributorStateEntry {
  agent: string;
  session: string;
  reporter: string;
  state: ReportedState;
  ts: number;
  detail?: string;
}

export interface StateProvenance {
  source: "primary" | "contributor";
  primary?: StateEntry;
  contributors: ContributorStateEntry[];
  effectiveReporter?: string;
}

export interface StateSnapshot {
  primaryByKey: Map<string, StateEntry>;
  contributorsByKey: Map<string, ContributorStateEntry[]>;
  mergedEntries: StateEntry[];
  mergedByKey: Map<string, StateEntry>;
  mergedByAgent: Map<string, StateEntry[]>;
  provenanceByKey: Map<string, StateProvenance>;
}

function ensureDir() {
  ensureAgentsDirs();
}

function stateFilePath(agent: string, session: string): string {
  return join(getStateDir(), `${agent}-${session}.json`);
}

function readStateFile(agent: string, session: string): StateEntry | null {
  ensureDir();
  try {
    return JSON.parse(readFileSync(stateFilePath(agent, session), "utf-8")) as StateEntry;
  } catch {
    return null;
  }
}

function writeStateFile(agent: string, session: string, entry: StateEntry): void {
  ensureDir();
  writeFileSync(stateFilePath(agent, session), JSON.stringify(entry));
}

function contributorStateFilePath(agent: string, session: string, reporter: string): string {
  return join(getContributorStateDir(), `${agent}-${session}-${reporter}.json`);
}

function readContributorStateFile(agent: string, session: string, reporter: string): ContributorStateEntry | null {
  ensureDir();
  try {
    return JSON.parse(readFileSync(contributorStateFilePath(agent, session, reporter), "utf-8")) as ContributorStateEntry;
  } catch {
    return null;
  }
}

function writeContributorStateFile(agent: string, session: string, reporter: string, entry: ContributorStateEntry): void {
  ensureDir();
  writeFileSync(contributorStateFilePath(agent, session, reporter), JSON.stringify(entry));
}

function contributorStatePriority(state: ReportedState): number {
  switch (state) {
    case "approval":
      return 4;
    case "working":
      return 3;
    case "question":
      return 2;
    case "idle":
    default:
      return 1;
  }
}

function mergeStateEntries(primary: StateEntry | null, contributors: ContributorStateEntry[]): StateEntry | null {
  if (!primary && contributors.length === 0) return null;
  if (contributors.length === 0) return primary;

  const topContributor = [...contributors].sort((a, b) => {
    const priorityDiff = contributorStatePriority(b.state) - contributorStatePriority(a.state);
    if (priorityDiff !== 0) return priorityDiff;
    return b.ts - a.ts;
  })[0];

  if (!primary) {
    return {
      state: topContributor.state,
      ts: topContributor.ts,
      agent: topContributor.agent,
      session: topContributor.session,
      ...(topContributor.detail ? { detail: topContributor.detail } : {}),
    };
  }

  if (contributorStatePriority(topContributor.state) <= contributorStatePriority(primary.state)) {
    return primary;
  }

  return {
    ...primary,
    state: topContributor.state,
    ts: Math.max(primary.ts, topContributor.ts),
    ...(topContributor.detail ? { detail: topContributor.detail } : {}),
  };
}

function stateSnapshotKey(agent: string, session: string): string {
  return `${agent}\u0000${session}`;
}

function mergeSnapshotKey(
  primary: StateEntry | undefined,
  contributors: ContributorStateEntry[] | undefined,
): { merged?: StateEntry; provenance?: StateProvenance } {
  const contributorList = contributors ? [...contributors] : [];
  const merged = mergeStateEntries(primary ?? null, contributorList);
  if (!merged) return {};

  if (!primary) {
    const topContributor = [...contributorList].sort((a, b) => {
      const priorityDiff = contributorStatePriority(b.state) - contributorStatePriority(a.state);
      if (priorityDiff !== 0) return priorityDiff;
      return b.ts - a.ts;
    })[0];
    return {
      merged,
      provenance: {
        source: "contributor",
        contributors: contributorList,
        ...(topContributor?.reporter ? { effectiveReporter: topContributor.reporter } : {}),
      },
    };
  }

  if (contributorList.length === 0) {
    return {
      merged,
      provenance: {
        source: "primary",
        primary,
        contributors: [],
      },
    };
  }

  const topContributor = [...contributorList].sort((a, b) => {
    const priorityDiff = contributorStatePriority(b.state) - contributorStatePriority(a.state);
    if (priorityDiff !== 0) return priorityDiff;
    return b.ts - a.ts;
  })[0];
  const source = contributorStatePriority(topContributor.state) > contributorStatePriority(primary.state)
    ? "contributor"
    : "primary";

  return {
    merged,
    provenance: {
      source,
      primary,
      contributors: contributorList,
      ...(source === "contributor" && topContributor?.reporter ? { effectiveReporter: topContributor.reporter } : {}),
    },
  };
}

function buildStateSnapshot(
  primaryByKey: Map<string, StateEntry>,
  contributorsByKey: Map<string, ContributorStateEntry[]>,
): StateSnapshot {
  const mergedByKey = new Map<string, StateEntry>();
  const mergedByAgent = new Map<string, StateEntry[]>();
  const provenanceByKey = new Map<string, StateProvenance>();
  const mergedEntries: StateEntry[] = [];
  const keys = new Set<string>([
    ...primaryByKey.keys(),
    ...contributorsByKey.keys(),
  ]);

  for (const key of keys) {
    const { merged, provenance } = mergeSnapshotKey(
      primaryByKey.get(key),
      contributorsByKey.get(key),
    );
    if (!merged || !provenance) continue;
    mergedEntries.push(merged);
    mergedByKey.set(key, merged);
    provenanceByKey.set(key, provenance);
    const existing = mergedByAgent.get(merged.agent);
    if (existing) existing.push(merged);
    else mergedByAgent.set(merged.agent, [merged]);
  }

  return {
    primaryByKey,
    contributorsByKey,
    mergedEntries,
    mergedByKey,
    mergedByAgent,
    provenanceByKey,
  };
}

export function createStateSnapshot(
  primaryEntries: StateEntry[],
  contributorEntries: ContributorStateEntry[],
): StateSnapshot {
  const primaryByKey = new Map<string, StateEntry>();
  const contributorsByKey = new Map<string, ContributorStateEntry[]>();

  for (const entry of primaryEntries) {
    primaryByKey.set(stateSnapshotKey(entry.agent, entry.session), entry);
  }

  for (const entry of contributorEntries) {
    const key = stateSnapshotKey(entry.agent, entry.session);
    const existing = contributorsByKey.get(key);
    if (existing) existing.push(entry);
    else contributorsByKey.set(key, [entry]);
  }

  return buildStateSnapshot(primaryByKey, contributorsByKey);
}

export function readStateSnapshot(maxAge: number = 86400): StateSnapshot {
  return createStateSnapshot(readStates(maxAge), readContributorStates(maxAge));
}

export function upsertStateSnapshotEntry(snapshot: StateSnapshot, entry: StateEntry): void {
  snapshot.primaryByKey.set(stateSnapshotKey(entry.agent, entry.session), entry);
  const rebuilt = buildStateSnapshot(snapshot.primaryByKey, snapshot.contributorsByKey);
  snapshot.primaryByKey = rebuilt.primaryByKey;
  snapshot.contributorsByKey = rebuilt.contributorsByKey;
  snapshot.mergedEntries = rebuilt.mergedEntries;
  snapshot.mergedByKey = rebuilt.mergedByKey;
  snapshot.mergedByAgent = rebuilt.mergedByAgent;
  snapshot.provenanceByKey = rebuilt.provenanceByKey;
}

export function deriveModelDisplay(meta?: ModelMetadata): string | undefined {
  if (!meta) return undefined;
  if (meta.provider && meta.modelId) return `${meta.provider}/${meta.modelId}`;
  if (meta.modelLabel) return meta.modelLabel;
  if (meta.modelId) return meta.modelId;
  return meta.model;
}

function isReportOptions(value: unknown): value is ReportOptions {
  return !!value && typeof value === "object"
    && (
      "detail" in value
      || "model" in value
      || "provider" in value
      || "modelId" in value
      || "modelLabel" in value
      || "modelSource" in value
      || "externalSessionId" in value
      || "context" in value
      || "workspace" in value
      || "contextTokens" in value
      || "contextMax" in value
    );
}

function mergeModelMetadata(existing: ModelMetadata | null, incoming: ModelMetadata): ModelMetadata {
  const provider = incoming.provider !== undefined ? incoming.provider : existing?.provider;
  const modelId = incoming.modelId !== undefined ? incoming.modelId : existing?.modelId;
  const modelLabel = incoming.modelLabel !== undefined ? incoming.modelLabel : existing?.modelLabel;
  const modelSource = incoming.modelSource !== undefined ? incoming.modelSource : existing?.modelSource;
  const legacyModel = incoming.model !== undefined ? incoming.model : existing?.model;
  const model = deriveModelDisplay({ provider, modelId, modelLabel, model: legacyModel });

  return {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(modelSource ? { modelSource } : {}),
    ...(model ? { model } : {}),
  };
}

/** Write state for an agent session. Called by hook integrations. */
export interface ReportOptions extends ModelMetadata {
  detail?: string;
  externalSessionId?: string;
  context?: string;
  workspace?: WorkspaceSnapshot;
  contextTokens?: number;
  contextMax?: number;
}

export interface ContributorReportOptions {
  detail?: string;
}

/** Write state for an agent session. Called by hook integrations. */
export function reportState(agent: string, session: string, state: ReportedState, optsOrContext?: ReportOptions | string, workspace?: WorkspaceSnapshot, contextTokens?: number, contextMax?: number, model?: string, externalSessionId?: string): StateEntry {
  // Support both new options-object style and legacy positional args
  const opts: ReportOptions = isReportOptions(optsOrContext)
    ? optsOrContext
    : { context: optsOrContext as string | undefined, workspace, contextTokens, contextMax, model, externalSessionId };

  const existing = readStateFile(agent, session);

  const mergedModel = mergeModelMetadata(existing, opts);

  let { detail, externalSessionId: extSessionId, context, workspace: ws, contextTokens: ctxTokens, contextMax: ctxMax } = opts;
  if (extSessionId === undefined) extSessionId = existing?.externalSessionId;
  if (context === undefined) context = existing?.context;
  if (ctxTokens === undefined) ctxTokens = existing?.contextTokens;
  if (ctxMax === undefined) ctxMax = existing?.contextMax;
  // Preserve existing workspace if it has a sessionName (seeded by createWorkspace).
  // Hook-reported snapshots lack sessionName and should not overwrite authoritative data.
  if (ws === undefined || (existing?.workspace?.sessionName && !ws?.sessionName)) {
    ws = existing?.workspace;
  }

  const entry: StateEntry = {
    state,
    ts: Math.floor(Date.now() / 1000),
    agent,
    session,
    ...(detail ? { detail } : {}),
    ...mergedModel,
    ...(extSessionId ? { externalSessionId: extSessionId } : {}),
    ...(context ? { context } : {}),
    ...(ctxTokens !== undefined ? { contextTokens: ctxTokens } : {}),
    ...(ctxMax !== undefined ? { contextMax: ctxMax } : {}),
    ...(ws ? { workspace: ws } : {}),
  };
  writeStateFile(agent, session, entry);
  return entry;
}

/** Update only the context field for an agent session, preserving state. */
export function reportContext(agent: string, session: string, context: string, optsOrWorkspace?: ReportOptions | WorkspaceSnapshot, contextTokens?: number, contextMax?: number, model?: string, externalSessionId?: string): StateEntry {
  const opts: ReportOptions = isReportOptions(optsOrWorkspace)
    ? { ...optsOrWorkspace, context }
    : { context, workspace: optsOrWorkspace as WorkspaceSnapshot | undefined, contextTokens, contextMax, model, externalSessionId };

  let entry: StateEntry;
  const existing = readStateFile(agent, session);
  if (existing) {
    const mergedModel = mergeModelMetadata(existing, opts);
    entry = {
      ...existing,
      ...mergedModel,
      context,
      ...(opts.externalSessionId !== undefined ? { externalSessionId: opts.externalSessionId } : {}),
      ...(opts.contextTokens !== undefined ? { contextTokens: opts.contextTokens } : {}),
      ...(opts.contextMax !== undefined ? { contextMax: opts.contextMax } : {}),
      ts: Math.floor(Date.now() / 1000),
    };
    if (opts.workspace !== undefined && !(existing.workspace?.sessionName && !opts.workspace?.sessionName)) {
      entry.workspace = opts.workspace;
    }
  } else {
    entry = {
      state: "idle",
      ts: Math.floor(Date.now() / 1000),
      agent,
      session,
      context,
      ...mergeModelMetadata(null, opts),
      ...(opts.externalSessionId ? { externalSessionId: opts.externalSessionId } : {}),
      ...(opts.contextTokens !== undefined ? { contextTokens: opts.contextTokens } : {}),
      ...(opts.contextMax !== undefined ? { contextMax: opts.contextMax } : {}),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
    };
  }
  writeStateFile(agent, session, entry);
  return entry;
}

export function reportContributorState(
  agent: string,
  session: string,
  reporter: string,
  state: ReportedState,
  opts?: ContributorReportOptions,
): void {
  if (state === "idle" || state === "working") {
    clearContributorState(agent, session, reporter);
    return;
  }

  const existing = readContributorStateFile(agent, session, reporter);
  const entry: ContributorStateEntry = {
    agent,
    session,
    reporter,
    state,
    ts: Math.floor(Date.now() / 1000),
    ...(opts?.detail ? { detail: opts.detail } : existing?.detail ? { detail: existing.detail } : {}),
  };
  writeContributorStateFile(agent, session, reporter, entry);
}

export function clearContributorState(agent: string, session: string, reporter: string): void {
  try {
    unlinkSync(contributorStateFilePath(agent, session, reporter));
  } catch {}
}

export function recordCleanupObservation(
  agent: string,
  session: string,
  cleanup: CleanupState | null,
): StateEntry | null {
  const existing = readStateFile(agent, session);
  if (!existing) return null;

  const next: StateEntry = cleanup
    ? { ...existing, cleanup }
    : existing.cleanup
      ? (() => {
          const { cleanup: _cleanup, ...rest } = existing;
          return rest as StateEntry;
        })()
      : existing;

  if (JSON.stringify(next) !== JSON.stringify(existing)) {
    writeStateFile(agent, session, next);
  }
  return next;
}

/** Read all fresh state entries (< maxAge seconds old).
 *  maxAge is only for disk cleanup of orphaned files (dead sessions).
 *  Active sessions update state via hooks; no hook = no expiry concern. */
export function readStates(maxAge: number = 86400): StateEntry[] {
  ensureDir();
  const now = Math.floor(Date.now() / 1000);
  const entries: StateEntry[] = [];
  const stateDir = getStateDir();
  try {
    for (const f of readdirSync(stateDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const data: StateEntry = JSON.parse(readFileSync(join(stateDir, f), "utf-8"));
        if (now - data.ts > maxAge) {
          // Clean up stale files
          try { unlinkSync(join(stateDir, f)); } catch {}
          continue;
        }
        entries.push(data);
      } catch {}
    }
  } catch {}
  return entries;
}

export function readContributorStates(maxAge: number = 86400): ContributorStateEntry[] {
  ensureDir();
  const now = Math.floor(Date.now() / 1000);
  const entries: ContributorStateEntry[] = [];
  const contributorStateDir = getContributorStateDir();
  try {
    for (const f of readdirSync(contributorStateDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const data: ContributorStateEntry = JSON.parse(readFileSync(join(contributorStateDir, f), "utf-8"));
        if (now - data.ts > maxAge) {
          try { unlinkSync(join(contributorStateDir, f)); } catch {}
          continue;
        }
        entries.push(data);
      } catch {}
    }
  } catch {}
  return entries;
}

/** Get the aggregate state for an agent type (e.g. "claude").
 *  If session is provided, only check that specific session.
 *  If ANY session is in approval → approval.
 *  If ANY session is working → working.
 *  Otherwise → idle (or null if no data). */

/** Get the state entry (with timestamp) for a specific agent session. */
export function getAgentStateEntry(agent: string, session?: string, snapshot?: StateSnapshot): StateEntry | null {
  const resolvedSnapshot = snapshot ?? readStateSnapshot();
  if (session) {
    return resolvedSnapshot.mergedByKey.get(stateSnapshotKey(agent, session)) ?? null;
  }

  const entries = resolvedSnapshot.mergedByAgent.get(agent) ?? [];
  if (entries.length === 0) return null;
  return entries.find((e) => e.state === "approval")
    || entries.find((e) => e.state === "working")
    || entries.find((e) => e.state === "question")
    || entries[0];
}

export function getAgentState(agent: string, session?: string, snapshot?: StateSnapshot): ReportedState | null {
  const resolvedSnapshot = snapshot ?? readStateSnapshot();
  const entries = session
    ? (() => {
        const entry = resolvedSnapshot.mergedByKey.get(stateSnapshotKey(agent, session));
        return entry ? [entry] : [];
      })()
    : (resolvedSnapshot.mergedByAgent.get(agent) ?? []);

  if (entries.length === 0) return null;
  if (entries.some((e) => e.state === "approval")) return "approval";
  if (entries.some((e) => e.state === "working")) return "working";
  if (entries.some((e) => e.state === "question")) return "question";
  return "idle";
}

export function getAgentStateProvenance(agent: string, session: string, snapshot?: StateSnapshot): StateProvenance | null {
  const resolvedSnapshot = snapshot ?? readStateSnapshot();
  return resolvedSnapshot.provenanceByKey.get(stateSnapshotKey(agent, session)) ?? null;
}
