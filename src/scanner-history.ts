import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { exec } from "./shell.js";
import { shellCommand } from "./command-words.js";
import { kiroContinuedSession, kiroHistoryForCwd, kiroSessionTranscript } from "./kiro-sessions.js";

export interface AgentSessionHistoryItem {
  sessionId: string;
  title: string;
  shortTitle?: string;
  titleSource?: "rename" | "summary" | "stored_title" | "session_info" | "first_prompt" | "fallback";
  model?: string;
  reasoningEffort?: string;
  updatedAt: number;
  current?: boolean;
  resumeStrategy?: AgentSessionResumeStrategy;
  resumeTarget?: string;
  resumeTargetKind?: AgentSessionResumeTargetKind;
  resumeCommand?: string;
  resumeArgv?: string[];
  /** The first prompt was a message another agent or a host wrapped (isWrappedPrompt). */
  startedByAgent?: boolean;
  /** Another pane (or process) has the session open: where (session-holders.ts). */
  openIn?: { pane?: string; session?: string; window?: string; pid?: number };
}

export type AgentSessionResumeStrategy = "restart" | "switch-in-place";
export type AgentSessionResumeTargetKind = "session-id" | "session-path" | "new-session";

export interface AgentSessionResumeInfo {
  strategy: AgentSessionResumeStrategy;
  target: string;
  targetKind: AgentSessionResumeTargetKind;
  command?: string;
  argv?: string[];
}

const claudeRenameCache = new Map<string, { mtimeMs: number; title?: string }>();
const codexSessionIndexPath = join(homedir(), ".codex", "session_index.jsonl");
const codexSessionsRoot = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
let codexSessionIndexCache: { mtimeMs: number; entries: Map<string, string> } | null = null;
let codexStateDbPathCache: string | null | undefined;
const codexTitleCache = new Map<string, { dbPath?: string; dbMtimeMs?: number; sessionIndexMtimeMs?: number; title?: string }>();
const codexSessionPathCache = new Map<string, string>();
const codexConversationActivityCache = new Map<string, { path: string; mtimeMs: number; updatedAt?: number }>();

type ClaudeSessionsIndexEntry = {
  summary?: string;
  firstPrompt?: string;
  modifiedAt?: number;
  transcriptPath?: string;
};

function parseSessionTimestamp(value?: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value > 10_000_000_000 ? value / 1000 : value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return undefined;
  return Math.round(millis / 1000);
}

function latestTimestamp(current: number | undefined, candidate: number | undefined): number | undefined {
  if (candidate === undefined) return current;
  return current === undefined ? candidate : Math.max(current, candidate);
}

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
      const entry = JSON.parse(line) as { type?: string; subtype?: string; content?: string; customTitle?: string };
      if (entry.type === "custom-title") {
        renamedTitle = entry.customTitle?.trim() || undefined;
        continue;
      }
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
    if (isUnhelpfulCodexFallbackTitle(summary)) continue;
    if (summary.length > 120) continue;
    if (isLikelyProjectBasenameTitle(summary, cwdRaw)) continue;
    return summary;
  }

  return undefined;
}

function isUnhelpfulCodexFallbackTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized.includes("resurrect agent")
    || normalized.includes(">>> transcript start")
    || normalized.includes(">>> approval request start")
    || normalized.startsWith("the following is the codex agent history")
    || /^019e[0-9a-f-]{31,}$/i.test(normalized);
}

function getCodexCwdFallbackTitle(cwdRaw: string | undefined, fallbackTitle: string): string | undefined {
  if (!cwdRaw || !isLikelyProjectBasenameTitle(fallbackTitle, cwdRaw)) return undefined;
  const historyTitles = listCodexHistoryTitlesForCwd(cwdRaw, 3);
  return resolveCodexFallbackTitleFromHistory(
    fallbackTitle,
    cwdRaw,
    historyTitles,
  );
}

function listCodexHistoryTitlesForCwd(cwdRaw: string, limit: number): string[] {
  const dbPath = codexStateDbPath();
  if (!dbPath || !existsSync(dbPath)) return [];

  try {
    const sqlCwd = cwdRaw.replace(/'/g, "''");
    const queryLimit = Math.max(limit, Math.min(50, limit * 8));
    const sql = `select id, title from threads where cwd='${sqlCwd}' order by updated_at desc limit ${queryLimit};`;
    const raw = exec(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`);
    if (!raw) return [];
    const rows = JSON.parse(raw) as Array<{ id?: string; title?: string }>;
    const sessionIndex = readCodexSessionIndex();
    return rows
      .map((row) => row.id ? sessionIndex.get(row.id) || row.title || row.id : row.title)
      .filter((title): title is string => !!title && !isUnhelpfulCodexFallbackTitle(title))
      .filter((title): title is string => !!title);
  } catch {
    return [];
  }
}

export function getHistoryResumeInfo(
  agent: string,
  opts: { sessionId: string; sessionPath?: string; reasoningEffort?: string },
): AgentSessionResumeInfo | undefined {
  switch (agent) {
    case "claude":
      const claudeArgv = ["claude", "--resume", opts.sessionId];
      return {
        strategy: "restart",
        target: opts.sessionId,
        targetKind: "session-id",
        command: shellCommand(claudeArgv),
        argv: claudeArgv,
      };
    case "codex":
      const codexArgv = opts.reasoningEffort
        ? ["codex", "resume", "-c", `model_reasoning_effort="${opts.reasoningEffort}"`, opts.sessionId]
        : ["codex", "resume", opts.sessionId];
      return {
        strategy: "restart",
        target: opts.sessionId,
        targetKind: "session-id",
        command: shellCommand(codexArgv),
        argv: codexArgv,
      };
    case "copilot":
      const copilotArgv = ["copilot", `--resume=${opts.sessionId}`];
      return {
        strategy: "restart",
        target: opts.sessionId,
        targetKind: "session-id",
        command: shellCommand(copilotArgv),
        argv: copilotArgv,
      };
    case "pi":
      if (!opts.sessionPath) return undefined;
      const piArgv = ["pi", "--session", opts.sessionPath];
      return {
        strategy: "switch-in-place",
        target: opts.sessionPath,
        targetKind: "session-path",
        command: shellCommand(piArgv),
        argv: piArgv,
      };
    case "opencode":
      const opencodeArgv = ["opencode", "--session", opts.sessionId];
      return {
        strategy: "restart",
        target: opts.sessionId,
        targetKind: "session-id",
        command: shellCommand(opencodeArgv),
        argv: opencodeArgv,
      };
    case "kiro":
      const kiroArgv = ["kiro-cli", "chat", "--tui", "--resume-id", opts.sessionId];
      return {
        strategy: "restart",
        target: opts.sessionId,
        targetKind: "session-id",
        command: shellCommand(kiroArgv),
        argv: kiroArgv,
      };
    default:
      return undefined;
  }
}

function resumeInfoFields(agent: string, opts: { sessionId: string; sessionPath?: string; reasoningEffort?: string }): Partial<AgentSessionHistoryItem> {
  const info = getHistoryResumeInfo(agent, opts);
  return info
    ? {
        resumeStrategy: info.strategy,
        resumeTarget: info.target,
        resumeTargetKind: info.targetKind,
        ...(info.command ? { resumeCommand: info.command } : {}),
        ...(info.argv ? { resumeArgv: info.argv } : {}),
      }
    : {};
}


function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map(textFromContent).filter(Boolean).join("\n");
    return text || undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "value", "message", "transformedContent"]) {
    const text = textFromContent(record[key]);
    if (text) return text;
  }
  return undefined;
}

function contentContainsType(value: unknown, type: string): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.some((item) => contentContainsType(item, type));
  if (typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (record.type === type) return true;
  return Object.values(record).some((item) => contentContainsType(item, type));
}

function isClaudeConversationUserEntry(entry: {
  message?: { role?: string; content?: unknown };
  content?: unknown;
}): boolean {
  if (entry.message?.role && entry.message.role !== "user") return false;
  const content = entry.message?.content ?? entry.content;
  if (contentContainsType(content, "tool_result")) return false;

  const text = textFromContent(content);
  if (!text) return false;
  if (text.includes("<local-command-caveat>")) return false;
  if (text.trim().startsWith("Caveat:")) return false;
  // A command run in Claude Code itself (/login, /model) and what it printed.
  if (text.includes("<command-name>") || text.includes("<local-command-stdout>")) return false;
  return true;
}

export function extractLatestClaudeConversationActivityAt(lines: string[]): number | undefined {
  let latest: number | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        timestamp?: unknown;
        message?: { role?: string; content?: unknown };
        content?: unknown;
      };
      if (entry.type === "assistant") {
        latest = latestTimestamp(latest, parseSessionTimestamp(entry.timestamp));
      } else if (entry.type === "user" && isClaudeConversationUserEntry(entry)) {
        latest = latestTimestamp(latest, parseSessionTimestamp(entry.timestamp));
      }
    } catch {}
  }
  return latest;
}

function isCodexBootstrapUserText(text?: string): boolean {
  const trimmed = text?.trim();
  if (!trimmed) return true;
  return trimmed.startsWith("# AGENTS.md instructions for ")
    || trimmed.startsWith("<environment_context>")
    || trimmed.startsWith("# Instructions");
}

export function extractLatestCodexConversationActivityAt(lines: string[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line) as {
        timestamp?: unknown;
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          content?: unknown;
          message?: string;
          text?: string;
        };
      };
      const timestamp = parseSessionTimestamp(entry.timestamp);
      if (timestamp === undefined) continue;

      if (entry.type === "response_item" && entry.payload?.type === "message") {
        if (entry.payload.role === "assistant") return timestamp;
        if (entry.payload.role === "user" && !isCodexBootstrapUserText(textFromContent(entry.payload.content))) {
          return timestamp;
        }
      }

      if (entry.type === "event_msg" && (entry.payload?.type === "agent_message" || entry.payload?.type === "agent_reasoning")) {
        return timestamp;
      }
    } catch {}
  }
  return undefined;
}

function findCodexSessionPath(sessionId?: string): string | undefined {
  if (!sessionId || !existsSync(codexSessionsRoot)) return undefined;

  const cached = codexSessionPathCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;

  const stack = [codexSessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
          codexSessionPathCache.set(sessionId, fullPath);
          return fullPath;
        }
      }
    } catch {}
  }

  return undefined;
}

function codexConversationActivityAt(sessionId: string): number | undefined {
  const sessionPath = findCodexSessionPath(sessionId);
  if (!sessionPath) return undefined;

  try {
    const mtimeMs = statSync(sessionPath).mtimeMs;
    const cached = codexConversationActivityCache.get(sessionId);
    if (cached && cached.path === sessionPath && cached.mtimeMs === mtimeMs) return cached.updatedAt;

    const updatedAt = extractLatestCodexConversationActivityAt(readFileSync(sessionPath, "utf-8").split("\n"));
    codexConversationActivityCache.set(sessionId, { path: sessionPath, mtimeMs, updatedAt });
    return updatedAt;
  } catch {
    return undefined;
  }
}

export function extractLatestCodexReasoningEffortFromSessionLines(lines: string[]): string | undefined {
  let effort: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; payload?: { effort?: unknown } };
      if (entry.type === "turn_context" && typeof entry.payload?.effort === "string" && entry.payload.effort.trim()) {
        effort = entry.payload.effort.trim();
      }
    } catch {}
  }
  return effort;
}

export function codexReasoningEffortForSession(sessionId: string): string | undefined {
  const sessionPath = findCodexSessionPath(sessionId);
  if (!sessionPath) return undefined;
  try {
    return extractLatestCodexReasoningEffortFromSessionLines(readFileSync(sessionPath, "utf-8").split("\n"));
  } catch {
    return undefined;
  }
}

function listCodexHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dbPath = codexStateDbPath();
  if (!dbPath || !existsSync(dbPath)) return [];

  try {
    const sqlCwd = cwdRaw.replace(/'/g, "''");
    const queryLimit = Math.max(limit, Math.min(250, limit * 8));
    // A subagent's thread (a guardian's approval review, a spawned explorer) is Codex talking to
    // itself, not a conversation of yours.
    const sql = `select id, title, model, updated_at, rollout_path from threads where cwd='${sqlCwd}' and source not like '{"subagent"%' order by updated_at desc limit ${queryLimit};`;
    const raw = exec(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`);
    if (!raw) return [];
    const rows = JSON.parse(raw) as Array<{ id?: string; title?: string; model?: string; updated_at?: number; rollout_path?: string }>;
    const sessionIndex = readCodexSessionIndex();
    return rows
      .filter((row) => !!row.id)
      .filter((row) => {
        if (row.rollout_path && existsSync(row.rollout_path)) codexSessionPathCache.set(row.id!, row.rollout_path);
        // A thread only opened (an ACP view nobody wrote in) has no prompt and no reply.
        if (row.id === currentSessionId) return true;
        return findCodexSessionPath(row.id) ? codexConversationActivityAt(row.id!) !== undefined : !!row.title;
      })
      .map((row): AgentSessionHistoryItem => {
        const indexedTitle = sessionIndex.get(row.id!);
        const isCurrent = !!currentSessionId && row.id === currentSessionId;
        const reasoningEffort = codexReasoningEffortForSession(row.id!);
        return {
          sessionId: row.id!,
          title: indexedTitle || row.title || row.id!,
          titleSource: indexedTitle ? "rename" : row.title ? "stored_title" : "fallback",
          ...(row.model ? { model: row.model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          updatedAt: codexConversationActivityAt(row.id!) ?? row.updated_at ?? 0,
          ...(isCurrent ? { current: true } : {}),
          ...resumeInfoFields("codex", { sessionId: row.id!, reasoningEffort }),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function expandHomePath(pathLike?: string): string | undefined {
  if (!pathLike) return undefined;
  return pathLike.startsWith("~/") ? join(homedir(), pathLike.slice(2)) : pathLike;
}

// A prompt that starts with markup is read for its message. Text outside its elements is the
// message (an element before it is context attached to it, `<system-reminder>…</system-reminder>
// fix the login`); a prompt of elements only is the first element with text, read the same way
// inside: a child element with text is the message and loose text beside it the framing of a
// message another agent or a host wrapped (`<relay …>framing<note>the brief</note></relay>`).
/** Whether a prompt is one element and nothing else: a message another agent or a host wrapped. */
export function isWrappedPrompt(raw: string): boolean {
  const text = raw.trim();
  const open = text.match(/^<([A-Za-z][\w:.-]*)\b[^>]*>/);
  if (!open) return false;
  const close = `</${open[1]}>`;
  return text.indexOf(close) === text.length - close.length;
}

export function unwrappedPromptText(raw: string): string {
  const text = raw.trim();
  if (!/^<[A-Za-z]/.test(text)) return text;
  const elements = [...text.matchAll(/<([A-Za-z][\w:.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)];
  if (elements.length === 0) return text;
  const loose = elements.reduce((rest, element) => rest.replace(element[0], "\n"), text).trim();
  if (loose) return loose;
  const element = elements.find((match) => match[2].replace(/<[^>]+>/g, "").trim());
  return element ? unwrappedElementText(element[2]) : "";
}

function unwrappedElementText(inner: string): string {
  const child = [...inner.matchAll(/<([A-Za-z][\w:.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)]
    .find((match) => match[2].replace(/<[^>]+>/g, "").trim());
  return child ? unwrappedElementText(child[2]) : inner.trim();
}

function summarizeText(raw?: string): string | undefined {
  if (!raw) return undefined;
  const lines = unwrappedPromptText(raw)
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^<[^>]+>$/.test(line));
  const first = lines.find((line) => line !== "[object Object]");
  if (!first) return undefined;
  // A brief's label says nothing of what it is about ("Goal:", "Mål:", as a thread's title).
  const unlabelled = first.replace(/^(goal|task|objective|aim|mål|uppgift)\s*(\([^)]*\))?\s*:\s*/i, "");
  const line = unlabelled && unlabelled !== first ? capitalized(unlabelled) : first;
  return line.replace(/\s+/g, " ").slice(0, 160);
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isLikelyUUID(raw?: string): boolean {
  return !!raw?.trim().match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
}

function summarizeReadableText(raw?: string): string | undefined {
  const title = summarizeText(raw);
  return title && !isLikelyUUID(title) ? title : undefined;
}

export function shortTitleForHistoryTitle(raw: string): string {
  const collapsed = (summarizeText(raw) || raw).replace(/\s+/g, " ").trim();
  const maxLength = 120;
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizedHistoryTitle(raw?: string): string {
  return (summarizeText(raw) || raw || "")
    .replace(/^[\u2801-\u28FF] */u, "")
    .replace(/^(?:\u03c0|pi)\s*-\s*/iu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function historyTitleMatchesPaneTitle(historyTitle: string, paneTitle: string): boolean {
  const history = normalizedHistoryTitle(historyTitle);
  const pane = normalizedHistoryTitle(paneTitle);
  if (!history || !pane) return false;
  if (history === pane) return true;
  return history.length >= 12 && pane.includes(history);
}

// The first prompt a conversation titled by it opened with, for retitledSharedOpenings.
const firstPrompts = new WeakMap<AgentSessionHistoryItem, string>();

function promptSentences(line: string): string[] {
  return line.split(/(?<=[.!?;])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

const sentenceKey = (sentence: string) => sentence.replace(/\s+/g, " ").toLowerCase();

/**
 * Conversations whoever started them opened alike ("Reply in Swedish; all artifacts in
 * English. Repo …, checkout …"): a sentence of a first prompt that another conversation of the
 * list opened with too says nothing of either, so a title made from the prompt starts at its
 * first sentence of its own.
 */
export function retitledSharedOpenings(items: AgentSessionHistoryItem[]): AgentSessionHistoryItem[] {
  const prompts = new Map(items.flatMap((item) => {
    const prompt = firstPrompts.get(item);
    if (!prompt) return [];
    const lines = unwrappedPromptText(prompt).replace(/<[^>]+>/g, " ").split("\n").map((line) => line.trim()).filter(Boolean);
    return [[item, lines.map(promptSentences)] as const];
  }));
  const seenIn = new Map<string, number>();
  for (const lines of prompts.values()) {
    for (const key of new Set(lines.flat().map(sentenceKey))) seenIn.set(key, (seenIn.get(key) || 0) + 1);
  }
  return items.map((item) => {
    const lines = prompts.get(item);
    if (!lines) return item;
    for (const sentences of lines) {
      const own = sentences.findIndex((sentence) => (seenIn.get(sentenceKey(sentence)) || 0) < 2);
      if (own < 0) continue;
      const title = own === 0 ? summarizeText(sentences.join(" ")) : summarizeText(capitalized(sentences.slice(own).join(" ")));
      return title && title !== item.title ? { ...item, title } : item;
    }
    return item;
  });
}

function withShortTitle(item: AgentSessionHistoryItem): AgentSessionHistoryItem {
  return {
    ...item,
    shortTitle: shortTitleForHistoryTitle(item.title),
  };
}

function withCurrentTitleFallback(items: AgentSessionHistoryItem[], currentTitle?: string): AgentSessionHistoryItem[] {
  if (!currentTitle || items.some((item) => item.current)) return items;

  const currentIndex = items.findIndex((item) =>
    historyTitleMatchesPaneTitle(item.title, currentTitle) ||
    (item.shortTitle ? historyTitleMatchesPaneTitle(item.shortTitle, currentTitle) : false)
  );
  if (currentIndex < 0) return items;

  return items.map((item, index) => index === currentIndex ? { ...item, current: true } : item);
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
    let firstUserPrompt: string | undefined;
    // The title Claude gives a conversation itself (its latest).
    let aiTitle: string | undefined;
    let model: string | undefined;
    let latestActivityAt: number | undefined;
    // Something said to Claude or by it: a session only opened, or with only /login, is left out.
    let hasConversation = false;

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as any;
        if (entry?.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) {
          aiTitle = entry.aiTitle.trim();
        } else if (entry?.type === "assistant") {
          hasConversation = true;
          latestActivityAt = latestTimestamp(latestActivityAt, parseSessionTimestamp(entry.timestamp));
        } else if (entry?.type === "user" && isClaudeConversationUserEntry(entry)) {
          hasConversation = true;
          latestActivityAt = latestTimestamp(latestActivityAt, parseSessionTimestamp(entry.timestamp));
        }

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
            firstUserPrompt = String(messageContent);
          }
        }
        if (!model && typeof entry?.message?.model === "string") model = entry.message.model;
      } catch {}
    }

    const isCurrent = !!currentSessionId && sessionId === currentSessionId;
    if (!hasConversation && !isCurrent) return null;
    const mtimeMs = statSync(filePath).mtimeMs;
    const summary = indexEntry?.summary || aiTitle;
    const resolvedTitle = renamedTitle || summary || firstUserTitle || summarizeText(indexEntry?.firstPrompt) || sessionId;
    const titleSource = renamedTitle ? "rename"
      : summary ? "summary"
      : (firstUserTitle || summarizeText(indexEntry?.firstPrompt)) ? "first_prompt"
      : "fallback";
    const item: AgentSessionHistoryItem = {
      sessionId,
      title: resolvedTitle,
      titleSource,
      ...(model ? { model } : {}),
      updatedAt: latestActivityAt || indexEntry?.modifiedAt || Math.round(mtimeMs / 1000),
      ...(isCurrent ? { current: true } : {}),
      ...resumeInfoFields("claude", { sessionId }),
    };
    if (firstUserPrompt && isWrappedPrompt(firstUserPrompt)) item.startedByAgent = true;
    if (titleSource === "first_prompt" && firstUserPrompt) firstPrompts.set(item, firstUserPrompt);
    return item;
  } catch {
    return null;
  }
}

function listClaudeHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dir = join(homedir(), ".claude", "projects", encodeClaudeProjectDir(cwdRaw));
  if (!existsSync(dir)) return [];
  try {
    const candidateLimit = Math.max(limit, Math.min(250, limit * 4));
    const indexEntries = readClaudeSessionsIndex(cwdRaw);
    if (indexEntries.size > 0) {
      const sortedEntries = [...indexEntries.entries()]
        .sort((a, b) => (b[1].modifiedAt || 0) - (a[1].modifiedAt || 0));
      const candidateEntries = sortedEntries.slice(0, candidateLimit);
      if (currentSessionId && !candidateEntries.some(([sessionId]) => sessionId === currentSessionId)) {
        const currentEntry = sortedEntries.find(([sessionId]) => sessionId === currentSessionId);
        if (currentEntry) candidateEntries.push(currentEntry);
      }

      return candidateEntries
        .map(([sessionId, entry]): AgentSessionHistoryItem | null => {
          const transcriptPath = entry.transcriptPath || join(dir, `${sessionId}.jsonl`);
          if (existsSync(transcriptPath)) return parseClaudeHistoryEntry(transcriptPath, currentSessionId, entry);
          if (!entry.firstPrompt && !entry.summary && sessionId !== currentSessionId) return null;
          return {
            sessionId,
            title: entry.summary || summarizeText(entry.firstPrompt) || sessionId,
            titleSource: entry.summary ? "summary" : entry.firstPrompt ? "first_prompt" : "fallback",
            updatedAt: entry.modifiedAt || 0,
            ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
            ...resumeInfoFields("claude", { sessionId }),
          };
        })
        .filter((item): item is AgentSessionHistoryItem => item !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    }

    const sortedFiles = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .map((filePath) => ({ filePath, mtimeMs: statSync(filePath).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const candidateFiles = sortedFiles.slice(0, candidateLimit);
    if (currentSessionId && !candidateFiles.some(({ filePath }) => basename(filePath, ".jsonl") === currentSessionId)) {
      const currentFile = sortedFiles.find(({ filePath }) => basename(filePath, ".jsonl") === currentSessionId);
      if (currentFile) candidateFiles.push(currentFile);
    }

    return candidateFiles
      .map(({ filePath }) => filePath)
      .map((filePath) => parseClaudeHistoryEntry(filePath, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function extractLatestPiConversationActivityAt(lines: string[]): number | undefined {
  let latest: number | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        timestamp?: unknown;
        message?: { role?: string; timestamp?: unknown };
      };
      if (entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant")) {
        latest = latestTimestamp(latest, parseSessionTimestamp(entry.timestamp ?? entry.message?.timestamp));
      }
    } catch {}
  }
  return latest;
}

export function extractLatestPiThinkingLevelFromSessionLines(lines: string[]): string | undefined {
  let thinkingLevel: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; thinkingLevel?: unknown };
      if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string" && entry.thinkingLevel.trim()) {
        thinkingLevel = entry.thinkingLevel.trim();
      }
    } catch {}
  }
  return thinkingLevel;
}

function parsePiHistoryEntry(filePath: string, currentSessionId?: string): AgentSessionHistoryItem | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    let sessionId = basename(filePath, ".jsonl").split("_").at(-1) || basename(filePath, ".jsonl");
    let firstPromptTitle: string | undefined;
    let sessionInfoTitle: string | undefined;
    let model: string | undefined;
    let ts = Math.round(statSync(filePath).mtimeMs / 1000);
    const latestActivityAt = extractLatestPiConversationActivityAt(lines);
    const reasoningEffort = extractLatestPiThinkingLevelFromSessionLines(lines);

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as any;
        if (entry?.type === "session") {
          if (typeof entry.id === "string") sessionId = entry.id;
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

    // A session only opened: nothing said to Pi or by it.
    if (latestActivityAt === undefined && sessionId !== currentSessionId) return null;
    const title = sessionInfoTitle || firstPromptTitle || sessionId;
    return {
      sessionId,
      title,
      titleSource: sessionInfoTitle ? "session_info" : firstPromptTitle ? "first_prompt" : "fallback",
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      updatedAt: latestActivityAt || ts,
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
    const candidateLimit = Math.max(limit, Math.min(250, limit * 4));
    const sortedFiles = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .map((filePath) => ({ filePath, mtimeMs: statSync(filePath).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const candidateFiles = sortedFiles.slice(0, candidateLimit);
    if (currentSessionId && !candidateFiles.some(({ filePath }) => basename(filePath, ".jsonl").includes(currentSessionId))) {
      const currentFile = sortedFiles.find(({ filePath }) => basename(filePath, ".jsonl").includes(currentSessionId));
      if (currentFile) candidateFiles.push(currentFile);
    }

    return candidateFiles
      .map(({ filePath }) => parsePiHistoryEntry(filePath, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

type CopilotWorkspaceMetadata = {
  cwd?: string;
  summary?: string;
  branch?: string;
  repository?: string;
  createdAt?: number;
  updatedAt?: number;
};

function yamlScalar(content: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^${escapedKey}:\\s*(.*)$`, "m"));
  if (!match) return undefined;

  const rawValue = match[1]?.trim();
  if (!rawValue || rawValue === "null" || rawValue === "~") return undefined;
  if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
    return rawValue.slice(1, -1).trim() || undefined;
  }
  return rawValue;
}

function parseCopilotWorkspaceYaml(filePath: string): CopilotWorkspaceMetadata {
  try {
    const content = readFileSync(filePath, "utf-8");
    const cwd = yamlScalar(content, "cwd");
    const summary = yamlScalar(content, "summary");
    const branch = yamlScalar(content, "branch");
    const repository = yamlScalar(content, "repository");
    const createdAtRaw = yamlScalar(content, "created_at");
    const updatedAtRaw = yamlScalar(content, "updated_at");
    const createdAt = createdAtRaw ? Math.round(Date.parse(createdAtRaw) / 1000) : undefined;
    const updatedAt = updatedAtRaw ? Math.round(Date.parse(updatedAtRaw) / 1000) : undefined;
    return { cwd, summary, branch, repository, createdAt, updatedAt };
  } catch {
    return {};
  }
}

function copilotEventText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value) return undefined;
  if (Array.isArray(value)) {
    return value.map(copilotEventText).filter(Boolean).join("\n") || undefined;
  }
  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "value", "message", "transformedContent"]) {
    const text = copilotEventText(record[key]);
    if (text) return text;
  }
  return undefined;
}

export function extractFirstCopilotUserMessageTitleFromEventLines(lines: string[]): string | undefined {
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
      if (entry?.type !== "user.message") continue;
      const title = summarizeReadableText(
        copilotEventText(entry.data?.content) || copilotEventText(entry.data?.transformedContent),
      );
      if (title) return title;
    } catch {}
  }
  return undefined;
}

export function extractLatestCopilotConversationActivityAt(lines: string[]): number | undefined {
  let latest: number | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; timestamp?: unknown };
      if (entry.type === "user.message" || entry.type === "assistant.message") {
        latest = latestTimestamp(latest, parseSessionTimestamp(entry.timestamp));
      }
    } catch {}
  }
  return latest;
}

export function extractLatestOpenCodeConversationActivityAt(rows: Array<{ timeCreated?: number; timeUpdated?: number; data?: string }>): number | undefined {
  let latest: number | undefined;
  for (const row of rows) {
    try {
      const data = row.data ? JSON.parse(row.data) as {
        role?: string;
        time?: { created?: unknown; completed?: unknown };
      } : undefined;
      if (data?.role !== "user" && data?.role !== "assistant") continue;

      const candidate = parseSessionTimestamp(data.time?.completed)
        ?? parseSessionTimestamp(data.time?.created)
        ?? parseSessionTimestamp(row.timeUpdated)
        ?? parseSessionTimestamp(row.timeCreated);
      latest = latestTimestamp(latest, candidate);
    } catch {}
  }
  return latest;
}

export function resolveCopilotHistoryTitle(
  workspaceMeta: Pick<CopilotWorkspaceMetadata, "summary" | "branch" | "repository" | "cwd">,
  eventLines: string[] = [],
): { title: string; titleSource: NonNullable<AgentSessionHistoryItem["titleSource"]> } {
  const summaryTitle = summarizeReadableText(workspaceMeta.summary);
  if (summaryTitle) return { title: summaryTitle, titleSource: "summary" };

  const firstPromptTitle = extractFirstCopilotUserMessageTitleFromEventLines(eventLines);
  if (firstPromptTitle) return { title: firstPromptTitle, titleSource: "first_prompt" };

  const sessionInfoTitle =
    summarizeReadableText(workspaceMeta.branch) ||
    summarizeReadableText(workspaceMeta.repository) ||
    summarizeReadableText(workspaceMeta.cwd ? basename(workspaceMeta.cwd) : undefined);
  if (sessionInfoTitle) return { title: sessionInfoTitle, titleSource: "session_info" };

  return { title: "Copilot session", titleSource: "fallback" };
}

function parseCopilotHistoryEntry(sessionDir: string, currentSessionId?: string): AgentSessionHistoryItem | null {
  try {
    const sessionId = basename(sessionDir);
    const workspaceMeta = parseCopilotWorkspaceYaml(join(sessionDir, "workspace.yaml"));
    const eventsPath = join(sessionDir, "events.jsonl");
    const eventLines = existsSync(eventsPath) ? readFileSync(eventsPath, "utf-8").split("\n") : [];
    const activityAt = extractLatestCopilotConversationActivityAt(eventLines);
    // A session only opened: no message to Copilot or from it.
    if (activityAt === undefined && sessionId !== currentSessionId) return null;
    const { title, titleSource } = resolveCopilotHistoryTitle(workspaceMeta, eventLines);
    const updatedAt = activityAt
      || workspaceMeta.updatedAt
      || Math.round(statSync(sessionDir).mtimeMs / 1000);
    return {
      sessionId,
      title,
      titleSource,
      updatedAt,
      ...(currentSessionId && sessionId === currentSessionId ? { current: true } : {}),
      ...resumeInfoFields("copilot", { sessionId }),
    };
  } catch {
    return null;
  }
}

function listKiroHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  // The pane may still name the Kiro 2 session that Kiro 3 goes on with in a copy.
  const current = currentSessionId
    ? kiroContinuedSession(currentSessionId)
    : undefined;
  const entries = kiroHistoryForCwd(cwdRaw, undefined, current);
  return entries.slice(0, limit).map((entry) => ({
    sessionId: entry.sessionId,
    title: entry.title,
    titleSource: "stored_title" as const,
    ...(entry.model && entry.model !== "auto" ? { model: entry.model } : {}),
    updatedAt: entry.updatedAt,
    ...(current && entry.sessionId === current ? { current: true } : {}),
    ...resumeInfoFields("kiro", { sessionId: entry.sessionId }),
  }));
}

function listCopilotHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const root = join(homedir(), ".copilot", "session-state");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .map((name) => join(root, name))
      .filter((dir) => existsSync(join(dir, "workspace.yaml")))
      .filter((dir) => parseCopilotWorkspaceYaml(join(dir, "workspace.yaml")).cwd === cwdRaw)
      .map((dir) => parseCopilotHistoryEntry(dir, currentSessionId))
      .filter((item): item is AgentSessionHistoryItem => item !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function listOpenCodeHistoryForCwd(cwdRaw: string, limit: number, currentSessionId?: string): AgentSessionHistoryItem[] {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return [];
  try {
    const sqlCwd = cwdRaw.replace(/'/g, "''");
    const sql = `
      select
        s.id,
        s.title,
        coalesce(
          (
            select max(coalesce(
              json_extract(m.data, '$.time.completed'),
              json_extract(m.data, '$.time.created'),
              m.time_updated,
              m.time_created
            ))
            from message m
            where m.session_id = s.id
              and json_extract(m.data, '$.role') in ('user', 'assistant')
          ),
          s.time_updated
        ) as activity_updated
      from session s
      join project p on p.id=s.project_id
      where p.worktree='${sqlCwd}'
        and (
          s.id='${(currentSessionId || "").replace(/'/g, "''")}'
          or exists (select 1 from message m where m.session_id = s.id and json_extract(m.data, '$.role') = 'user')
        )
      order by activity_updated desc
      limit ${limit};
    `;
    const raw = exec(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`);
    if (!raw) return [];
    const rows = JSON.parse(raw) as Array<{ id?: string; title?: string; activity_updated?: number }>;
    return rows
      .filter((row) => !!row.id)
      .map((row) => ({
        sessionId: row.id!,
        title: row.title || row.id!,
        titleSource: row.title ? "stored_title" : "fallback",
        updatedAt: Math.round((row.activity_updated || 0) / 1000),
        ...(currentSessionId && row.id === currentSessionId ? { current: true } : {}),
        ...resumeInfoFields("opencode", { sessionId: row.id! }),
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
      .map((filePath): AgentSessionHistoryItem | null => {
        try {
          const transcript = JSON.parse(readFileSync(filePath, "utf-8")) as any[];
          const sessionId = basename(filePath, ".json");
          // A session only opened: no message to Cursor or from it.
          if (!transcript.some((entry) => entry?.role === "user" || entry?.role === "assistant") && sessionId !== currentSessionId) return null;
          const title = summarizeText(transcript.find((entry) => entry?.role === "user")?.text);
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
      .filter((item): item is AgentSessionHistoryItem => item !== null)
      .slice(0, limit);
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

export function loadHistoryForAgent(agent: string, cwdRaw: string, limit: number, currentSessionId?: string, _currentTitle?: string): AgentSessionHistoryItem[] {
  let items: AgentSessionHistoryItem[];
  switch (agent) {
    case "claude":
      items = listClaudeHistoryForCwd(cwdRaw, limit, currentSessionId);
      break;
    case "codex":
      items = listCodexHistoryForCwd(cwdRaw, limit, currentSessionId);
      break;
    case "copilot":
      items = listCopilotHistoryForCwd(cwdRaw, limit, currentSessionId);
      break;
    case "opencode":
      items = listOpenCodeHistoryForCwd(cwdRaw, limit, currentSessionId);
      break;
    case "pi":
      items = listPiHistoryForCwd(cwdRaw, limit, currentSessionId);
      break;
    case "cursor":
      items = listCursorHistoryForCwd(cwdRaw, limit, currentSessionId);
      break;
    case "kiro":
      items = listKiroHistoryForCwd(cwdRaw, limit, currentSessionId);
      break;
    default:
      return [];
  }
  return retitledSharedOpenings(items).map(withShortTitle);
}

/**
 * The transcript an agent's harness keeps of a session, by its id: Claude Code's
 * projects/<dir>/<id>.jsonl, Codex's rollout-…-<id>.jsonl, Pi's sessions/<dir>/<time>_<id>.jsonl,
 * Kiro's (kiro-sessions.ts), Copilot's session-state/<id>/events.jsonl. For `agents session-file`: a coordinator points the agent after
 * another at the transcript of the one before it.
 */
export function sessionTranscriptPath(agent: string, sessionId: string): string | undefined {
  if (!/^[A-Za-z0-9._-]{4,128}$/.test(sessionId)) return undefined;
  const inSubdirectories = (root: string, matches: (name: string) => boolean): string | undefined => {
    let folders: string[] = [];
    try {
      folders = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const folder of folders) {
      try {
        const hit = readdirSync(join(root, folder)).find(matches);
        if (hit) return join(root, folder, hit);
      } catch {}
    }
    return undefined;
  };
  switch (basename(agent).toLowerCase()) {
    case "claude":
      return inSubdirectories(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"), (name) => name === `${sessionId}.jsonl`);
    case "codex":
      return findCodexSessionPath(sessionId);
    case "pi":
      return inSubdirectories(join(homedir(), ".pi", "agent", "sessions"), (name) => name.endsWith(`_${sessionId}.jsonl`));
    case "kiro":
    case "kiro-cli":
    case "kiro-cli-chat":
      return kiroSessionTranscript(sessionId);
    case "copilot": {
      const file = join(homedir(), ".copilot", "session-state", sessionId, "events.jsonl");
      return existsSync(file) ? file : undefined;
    }
    default:
      return undefined;
  }
}
