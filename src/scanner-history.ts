import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { exec } from "./shell.js";

export interface AgentSessionHistoryItem {
  sessionId: string;
  title: string;
  titleSource?: "rename" | "summary" | "stored_title" | "session_info" | "first_prompt" | "fallback";
  model?: string;
  updatedAt: number;
  current?: boolean;
  resumeStrategy?: AgentSessionResumeStrategy;
  resumeTarget?: string;
  resumeTargetKind?: AgentSessionResumeTargetKind;
}

export type AgentSessionResumeStrategy = "restart" | "switch-in-place";
export type AgentSessionResumeTargetKind = "session-id" | "session-path";

export interface AgentSessionResumeInfo {
  strategy: AgentSessionResumeStrategy;
  target: string;
  targetKind: AgentSessionResumeTargetKind;
}

const claudeRenameCache = new Map<string, { mtimeMs: number; title?: string }>();
const codexSessionIndexPath = join(homedir(), ".codex", "session_index.jsonl");
let codexSessionIndexCache: { mtimeMs: number; entries: Map<string, string> } | null = null;
let codexStateDbPathCache: string | null | undefined;
const codexTitleCache = new Map<string, { dbPath?: string; dbMtimeMs?: number; sessionIndexMtimeMs?: number; title?: string }>();

type ClaudeSessionsIndexEntry = {
  summary?: string;
  firstPrompt?: string;
  modifiedAt?: number;
  transcriptPath?: string;
};

function sqliteMtimeMs(dbPath: string): number {
  let latest = 0;
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(candidate)) latest = Math.max(latest, statSync(candidate).mtimeMs);
    } catch {}
  }
  return latest;
}

export function extractClaudeRenameTitleFromTranscript(lines: string[]): string | undefined {
  let renamedTitle: string | undefined;
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; subtype?: string; content?: string };
      if (entry.type !== "system" || entry.subtype !== "local_command" || !entry.content?.includes("<command-name>/rename</command-name>")) continue;
      const match = entry.content.match(/<command-args>(.*?)<\/command-args>/s);
      const candidate = match?.[1]?.trim();
      renamedTitle = candidate || undefined;
    } catch {}
  }
  return renamedTitle;
}

function claudeTranscriptPath(cwdRaw?: string, externalSessionId?: string): string | undefined {
  if (!cwdRaw || !externalSessionId) return undefined;
  const projectDir = cwdRaw.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", projectDir, `${externalSessionId}.jsonl`);
}

function getClaudeRenamedTitle(cwdRaw?: string, externalSessionId?: string): string | undefined {
  const transcript = claudeTranscriptPath(cwdRaw, externalSessionId);
  if (!transcript || !existsSync(transcript)) return undefined;

  try {
    const mtimeMs = statSync(transcript).mtimeMs;
    const cached = claudeRenameCache.get(transcript);
    if (cached?.mtimeMs === mtimeMs) return cached.title;

    const renamedTitle = extractClaudeRenameTitleFromTranscript(readFileSync(transcript, "utf-8").split("\n"));
    claudeRenameCache.set(transcript, { mtimeMs, title: renamedTitle });
    return renamedTitle;
  } catch {
    return undefined;
  }
}

function codexStateDbPath(): string | undefined {
  if (codexStateDbPathCache !== undefined) return codexStateDbPathCache || undefined;

  const codexDir = join(homedir(), ".codex");
  const candidates: Array<{ path: string; version: number }> = [];
  try {
    for (const entry of readdirSync(codexDir)) {
      const match = entry.match(/^state_(\d+)\.sqlite$/);
      if (!match) continue;
      candidates.push({ path: join(codexDir, entry), version: Number.parseInt(match[1], 10) || 0 });
    }
  } catch {}

  candidates.sort((a, b) => b.version - a.version);
  const preferred = candidates[0]?.path;
  const fallback = join(codexDir, "state.db");
  codexStateDbPathCache = preferred || (existsSync(fallback) ? fallback : null);
  return codexStateDbPathCache || undefined;
}

export function extractLatestCodexSessionTitlesFromIndexLines(lines: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { id?: string; thread_name?: string };
      if (entry.id && entry.thread_name) entries.set(entry.id, entry.thread_name);
    } catch {}
  }
  return entries;
}

function readCodexSessionIndex(): Map<string, string> {
  if (!existsSync(codexSessionIndexPath)) return new Map();
  try {
    const mtimeMs = statSync(codexSessionIndexPath).mtimeMs;
    if (codexSessionIndexCache?.mtimeMs === mtimeMs) return codexSessionIndexCache.entries;

    const entries = extractLatestCodexSessionTitlesFromIndexLines(readFileSync(codexSessionIndexPath, "utf-8").split("\n"));
    codexSessionIndexCache = { mtimeMs, entries };
    return entries;
  } catch {
    return new Map();
  }
}

function getCodexThreadTitle(externalSessionId?: string): string | undefined {
  if (!externalSessionId) return undefined;

  const sessionIndexTitle = readCodexSessionIndex().get(externalSessionId);
  const sessionIndexMtimeMs = codexSessionIndexCache?.mtimeMs;
  const dbPath = codexStateDbPath();
  const dbMtimeMs = dbPath && existsSync(dbPath) ? sqliteMtimeMs(dbPath) : undefined;

  const cached = codexTitleCache.get(externalSessionId);
  if (cached && cached.dbPath === dbPath && cached.dbMtimeMs === dbMtimeMs && cached.sessionIndexMtimeMs === sessionIndexMtimeMs) {
    return cached.title;
  }

  let title = sessionIndexTitle;
  if (!title && dbPath && existsSync(dbPath)) {
    try {
      const sqlId = externalSessionId.replace(/'/g, "''");
      title = exec(`sqlite3 ${JSON.stringify(dbPath)} ${JSON.stringify(`select title from threads where id='${sqlId}' limit 1;`)}`) || undefined;
    } catch {
      title = undefined;
    }
  }

  codexTitleCache.set(externalSessionId, { dbPath, dbMtimeMs, sessionIndexMtimeMs, title });
  return title;
}

function isLikelyProjectBasenameTitle(title: string, cwdRaw?: string): boolean {
  if (!cwdRaw) return false;
  const normalizedTitle = title.trim().toLowerCase();
  if (!normalizedTitle) return false;
  return normalizedTitle === basename(cwdRaw).trim().toLowerCase();
}

export function resolveCodexFallbackTitleFromHistory(
  fallbackTitle: string,
  cwdRaw: string | undefined,
  candidateTitles: string[],
): string | undefined {
  if (!cwdRaw || !isLikelyProjectBasenameTitle(fallbackTitle, cwdRaw)) return undefined;

  for (const candidateTitle of candidateTitles) {
    const summary = summarizeText(candidateTitle);
    if (!summary) continue;
    if (summary.length > 120) continue;
    if (isLikelyProjectBasenameTitle(summary, cwdRaw)) continue;
    return summary;
  }

  return undefined;
}

function getCodexCwdFallbackTitle(cwdRaw: string | undefined, fallbackTitle: string): string | undefined {
  if (!cwdRaw) return undefined;
  const history = listCodexHistoryForCwd(cwdRaw, 3);
  return resolveCodexFallbackTitleFromHistory(
    fallbackTitle,
    cwdRaw,
    history.map((item) => item.title),
  );
}

export function getHistoryResumeInfo(
  agent: string,
  opts: { sessionId: string; sessionPath?: string },
): AgentSessionResumeInfo | undefined {
  switch (agent) {
    case "claude":
      return {
        strategy: "restart",
        target: opts.sessionId,
        targetKind: "session-id",
      };
    case "codex":
      return {
        strategy: "restart",
        target: opts.sessionId,
        targetKind: "session-id",
      };
    case "copilot":
      return {
        strategy: "restart",
        target: opts.sessionId,
        targetKind: "session-id",
      };
    case "pi":
      if (!opts.sessionPath) return undefined;
      return {
        strategy: "switch-in-place",
        target: opts.sessionPath,
        targetKind: "session-path",
      };
    default:
      return undefined;
  }
}

function resumeInfoFields(agent: string, opts: { sessionId: string; sessionPath?: string }): Partial<AgentSessionHistoryItem> {
  const info = getHistoryResumeInfo(agent, opts);
  return info
    ? {
        resumeStrategy: info.strategy,
        resumeTarget: info.target,
        resumeTargetKind: info.targetKind,
      }
    : {};
}

function listCodexHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dbPath = codexStateDbPath();
  if (!dbPath || !existsSync(dbPath)) return [];

  try {
    const sqlCwd = cwdRaw.replace(/'/g, "''");
    const sql = `select id, title, model, updated_at from threads where cwd='${sqlCwd}' order by updated_at desc limit ${limit};`;
    const raw = exec(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`);
    if (!raw) return [];
    const rows = JSON.parse(raw) as Array<{ id?: string; title?: string; model?: string; updated_at?: number }>;
    const sessionIndex = readCodexSessionIndex();
    return rows
      .filter((row) => !!row.id)
      .map((row) => {
        const indexedTitle = sessionIndex.get(row.id!);
        const isCurrent = !!currentSessionId && row.id === currentSessionId;
        return {
          sessionId: row.id!,
          title: indexedTitle || row.title || row.id!,
          titleSource: indexedTitle ? "rename" : row.title ? "stored_title" : "fallback",
          ...(row.model ? { model: row.model } : {}),
          updatedAt: row.updated_at || 0,
          ...(isCurrent ? { current: true } : {}),
          ...resumeInfoFields("codex", { sessionId: row.id! }),
        };
      });
  } catch {
    return [];
  }
}

function expandHomePath(pathLike?: string): string | undefined {
  if (!pathLike) return undefined;
  return pathLike.startsWith("~/") ? join(homedir(), pathLike.slice(2)) : pathLike;
}

function summarizeText(raw?: string): string | undefined {
  if (!raw) return undefined;
  const lines = raw
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^<[^>]+>$/.test(line));
  const first = lines.find((line) => line !== "[object Object]");
  if (!first) return undefined;
  return first.replace(/\s+/g, " ").slice(0, 160);
}

function encodeClaudeProjectDir(cwdRaw: string): string {
  return cwdRaw.replace(/\//g, "-");
}

function encodePiSessionDir(cwdRaw: string): string {
  return `--${cwdRaw.replace(/^\/+|\/+$/g, "").replace(/\//g, "-")}--`;
}

function encodeCursorProjectDir(cwdRaw: string): string {
  return cwdRaw.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
}

function readClaudeSessionsIndex(cwdRaw: string): Map<string, ClaudeSessionsIndexEntry> {
  const indexPath = join(homedir(), ".claude", "projects", encodeClaudeProjectDir(cwdRaw), "sessions-index.json");
  if (!existsSync(indexPath)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      entries?: Array<{ sessionId?: string; summary?: string; firstPrompt?: string; modified?: string; fileMtime?: number; fullPath?: string }>;
    };
    const entries = new Map<string, ClaudeSessionsIndexEntry>();
    for (const entry of parsed.entries || []) {
      if (!entry.sessionId) continue;
      const modifiedAt = entry.modified ? Math.round(Date.parse(entry.modified) / 1000) : entry.fileMtime ? Math.round(entry.fileMtime / 1000) : undefined;
      entries.set(entry.sessionId, {
        ...(entry.summary ? { summary: entry.summary } : {}),
        ...(entry.firstPrompt ? { firstPrompt: entry.firstPrompt } : {}),
        ...(modifiedAt ? { modifiedAt } : {}),
        ...(entry.fullPath ? { transcriptPath: entry.fullPath } : {}),
      });
    }
    return entries;
  } catch {
    return new Map();
  }
}

function parseClaudeHistoryEntry(filePath: string, currentSessionId?: string, indexEntry?: ClaudeSessionsIndexEntry): AgentSessionHistoryItem | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    const sessionId = basename(filePath, ".jsonl");
    const renamedTitle = extractClaudeRenameTitleFromTranscript(lines);
    let firstUserTitle: string | undefined;
    let model: string | undefined;

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as any;
        const messageContent = typeof entry?.message?.content === "string"
          ? entry.message.content
          : Array.isArray(entry?.message?.content)
            ? entry.message.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
            : typeof entry?.content === "string"
              ? entry.content
              : undefined;
        if (!firstUserTitle && entry?.type === "user") {
          const candidate = summarizeText(messageContent);
          if (candidate
            && !String(messageContent || "").includes("<local-command-caveat>")
            && !candidate.startsWith("Caveat:")
            && !candidate.startsWith("/")
            && !candidate.includes("<command-name>/")) {
            firstUserTitle = candidate;
          }
        }
        if (!model && typeof entry?.message?.model === "string") model = entry.message.model;
      } catch {}
    }

    const mtimeMs = statSync(filePath).mtimeMs;
    const resolvedTitle = renamedTitle || indexEntry?.summary || firstUserTitle || summarizeText(indexEntry?.firstPrompt) || sessionId;
    const titleSource = renamedTitle ? "rename"
      : indexEntry?.summary ? "summary"
      : (firstUserTitle || summarizeText(indexEntry?.firstPrompt)) ? "first_prompt"
      : "fallback";
    return {
      sessionId,
      title: resolvedTitle,
      titleSource,
      ...(model ? { model } : {}),
      updatedAt: indexEntry?.modifiedAt || Math.round(mtimeMs / 1000),
      ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
      ...resumeInfoFields("claude", { sessionId }),
    };
  } catch {
    return null;
  }
}

function listClaudeHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dir = join(homedir(), ".claude", "projects", encodeClaudeProjectDir(cwdRaw));
  if (!existsSync(dir)) return [];
  try {
    const indexEntries = readClaudeSessionsIndex(cwdRaw);
    if (indexEntries.size > 0) {
      return [...indexEntries.entries()]
        .sort((a, b) => (b[1].modifiedAt || 0) - (a[1].modifiedAt || 0))
        .slice(0, limit)
        .map(([sessionId, entry]): AgentSessionHistoryItem | null => {
          const transcriptPath = entry.transcriptPath || join(dir, `${sessionId}.jsonl`);
          if (existsSync(transcriptPath)) return parseClaudeHistoryEntry(transcriptPath, currentSessionId, entry);
          return {
            sessionId,
            title: entry.summary || summarizeText(entry.firstPrompt) || sessionId,
            titleSource: entry.summary ? "summary" : entry.firstPrompt ? "first_prompt" : "fallback",
            updatedAt: entry.modifiedAt || 0,
            ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
            ...resumeInfoFields("claude", { sessionId }),
          };
        })
        .filter((item): item is AgentSessionHistoryItem => item !== null);
    }

    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .map((filePath) => parseClaudeHistoryEntry(filePath, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function parsePiHistoryEntry(filePath: string, currentSessionId?: string): AgentSessionHistoryItem | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    let sessionId = basename(filePath, ".jsonl").split("_").at(-1) || basename(filePath, ".jsonl");
    let firstPromptTitle: string | undefined;
    let sessionInfoTitle: string | undefined;
    let model: string | undefined;
    let ts = Math.round(statSync(filePath).mtimeMs / 1000);

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as any;
        if (entry?.type === "session") {
          if (typeof entry.id === "string") sessionId = entry.id;
          if (typeof entry.timestamp === "string") {
            const parsed = Date.parse(entry.timestamp);
            if (!Number.isNaN(parsed)) ts = Math.round(parsed / 1000);
          }
        }
        if (entry?.type === "model_change" && typeof entry.modelId === "string") model = entry.modelId;
        if (entry?.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
          sessionInfoTitle = entry.name.trim();
        }
        if (!firstPromptTitle && entry?.type === "message" && entry?.message?.role === "user") {
          const text = Array.isArray(entry.message.content)
            ? entry.message.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
            : typeof entry.message.content === "string"
              ? entry.message.content
              : undefined;
          const candidate = summarizeText(text);
          if (candidate && !candidate.includes("Daily Memory")) firstPromptTitle = candidate;
        }
      } catch {}
    }

    const title = sessionInfoTitle || firstPromptTitle || sessionId;
    return {
      sessionId,
      title,
      titleSource: sessionInfoTitle ? "session_info" : firstPromptTitle ? "first_prompt" : "fallback",
      ...(model ? { model } : {}),
      updatedAt: ts,
      ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
      ...resumeInfoFields("pi", { sessionId, sessionPath: filePath }),
    };
  } catch {
    return null;
  }
}

function listPiHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dir = join(homedir(), ".pi", "agent", "sessions", encodePiSessionDir(cwdRaw));
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .map((filePath) => parsePiHistoryEntry(filePath, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function parseCopilotWorkspaceYaml(filePath: string): { cwd?: string; summary?: string; createdAt?: number; updatedAt?: number } {
  try {
    const content = readFileSync(filePath, "utf-8");
    const cwd = content.match(/^cwd:\s*(.+)$/m)?.[1]?.trim();
    const summary = content.match(/^summary:\s*(.+)$/m)?.[1]?.trim();
    const createdAtRaw = content.match(/^created_at:\s*(.+)$/m)?.[1]?.trim();
    const updatedAtRaw = content.match(/^updated_at:\s*(.+)$/m)?.[1]?.trim();
    const createdAt = createdAtRaw ? Math.round(Date.parse(createdAtRaw) / 1000) : undefined;
    const updatedAt = updatedAtRaw ? Math.round(Date.parse(updatedAtRaw) / 1000) : undefined;
    return { cwd, summary, createdAt, updatedAt };
  } catch {
    return {};
  }
}

function parseCopilotHistoryEntry(sessionDir: string, currentSessionId?: string): AgentSessionHistoryItem | null {
  try {
    const sessionId = basename(sessionDir);
    const workspaceMeta = parseCopilotWorkspaceYaml(join(sessionDir, "workspace.yaml"));
    let title = summarizeText(workspaceMeta.summary);
    if (!title) {
      const eventsPath = join(sessionDir, "events.jsonl");
      if (existsSync(eventsPath)) {
        for (const line of readFileSync(eventsPath, "utf-8").split("\n")) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line) as any;
            if (entry?.type === "user.message") {
              title = summarizeText(entry?.data?.content || entry?.data?.transformedContent);
              if (title) break;
            }
          } catch {}
        }
      }
    }
    const updatedAt = workspaceMeta.updatedAt || Math.round(statSync(sessionDir).mtimeMs / 1000);
    return {
      sessionId,
      title: title || sessionId,
      titleSource: title ? "summary" : "fallback",
      updatedAt,
      ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
      ...resumeInfoFields("copilot", { sessionId }),
    };
  } catch {
    return null;
  }
}

function listCopilotHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const root = join(homedir(), ".copilot", "session-state");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .map((name) => join(root, name))
      .filter((dir) => existsSync(join(dir, "workspace.yaml")))
      .map((dir) => ({ dir, meta: parseCopilotWorkspaceYaml(join(dir, "workspace.yaml")) }))
      .filter(({ meta }) => meta.cwd === cwdRaw)
      .sort((a, b) => (b.meta.updatedAt || statSync(b.dir).mtimeMs / 1000) - (a.meta.updatedAt || statSync(a.dir).mtimeMs / 1000))
      .slice(0, limit)
      .map(({ dir }) => parseCopilotHistoryEntry(dir, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null);
  } catch {
    return [];
  }
}

function listOpenCodeHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return [];
  try {
    const sqlCwd = cwdRaw.replace(/'/g, "''");
    const sql = `select s.id, s.title, s.time_updated from session s join project p on p.id=s.project_id where p.worktree='${sqlCwd}' order by s.time_updated desc limit ${limit};`;
    const raw = exec(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`);
    if (!raw) return [];
    const rows = JSON.parse(raw) as Array<{ id?: string; title?: string; time_updated?: number }>;
    return rows
      .filter((row) => !!row.id)
      .map((row) => ({
        sessionId: row.id!,
        title: row.title || row.id!,
        titleSource: row.title ? "stored_title" : "fallback",
        updatedAt: Math.round((row.time_updated || 0) / 1000),
        ...(currentSessionId && row.id === currentSessionId ? { current: true } : {}),
      }));
  } catch {
    return [];
  }
}

function listCursorHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dir = join(homedir(), ".cursor", "projects", encodeCursorProjectDir(cwdRaw), "agent-transcripts");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, limit)
      .map((filePath): AgentSessionHistoryItem | null => {
        try {
          const transcript = JSON.parse(readFileSync(filePath, "utf-8")) as any[];
          const title = summarizeText(transcript.find((entry) => entry?.role === "user")?.text);
          const sessionId = basename(filePath, ".json");
          return {
            sessionId,
            title: title || sessionId,
            titleSource: title ? "first_prompt" : "fallback",
            updatedAt: Math.round(statSync(filePath).mtimeMs / 1000),
            ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
          };
        } catch {
          return null;
        }
      })
      .filter((item): item is AgentSessionHistoryItem => item !== null);
  } catch {
    return [];
  }
}

export function resolveAgentDisplayTitle(agent: string, cwdRaw: string | undefined, externalSessionId: string | undefined, fallbackTitle: string): string {
  const renamedTitle = agent === "claude" ? getClaudeRenamedTitle(cwdRaw, externalSessionId) : undefined;
  const codexTitle = agent === "codex" ? getCodexThreadTitle(externalSessionId) : undefined;
  const codexCwdFallback = agent === "codex" && !externalSessionId
    ? getCodexCwdFallbackTitle(cwdRaw, fallbackTitle)
    : undefined;
  return codexTitle || codexCwdFallback || renamedTitle || fallbackTitle;
}

export function normalizeHistoryCwd(cwdRaw: string): string {
  return expandHomePath(cwdRaw) || cwdRaw;
}

export function loadHistoryForAgent(agent: string, cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  switch (agent) {
    case "claude":
      return listClaudeHistoryForCwd(cwdRaw, limit, currentSessionId);
    case "codex":
      return listCodexHistoryForCwd(cwdRaw, limit, currentSessionId);
    case "copilot":
      return listCopilotHistoryForCwd(cwdRaw, limit, currentSessionId);
    case "opencode":
      return listOpenCodeHistoryForCwd(cwdRaw, limit, currentSessionId);
    case "pi":
      return listPiHistoryForCwd(cwdRaw, limit, currentSessionId);
    case "cursor":
      return listCursorHistoryForCwd(cwdRaw, limit, currentSessionId);
    default:
      return [];
  }
}
