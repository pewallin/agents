// What a coordinator's program cost in tokens, per thread and for the coordinator, from each
// session's own transcript where its harness records usage: `agents usage --program <dir>`.
//
//   Claude Code  ~/.claude/projects/<folder>/<session>.jsonl: usage on every assistant message
//                (input without cache, cache read, cache write, output), once per message id.
//   Codex        its rollout file: the last token_count event's total_token_usage (its input
//                counts the cached part too, which is taken out here).
//   Kiro         credits, not tokens (kiro-session-usage.ts).
// Other harnesses record no usage the CLI can read: their sessions are counted, not measured.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readKiroSessionUsage, readKiroTurnCredits } from "./kiro-session-usage.js";
import { sessionLogsRoot } from "./session-log.js";
import { sessionTranscriptPath } from "./scanner-history.js";

export interface TokenUsage {
  /** Input read at full price (not from the cache). */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Kiro's spend, in its own unit. */
  credits?: number;
}

export interface SessionUsage extends Partial<TokenUsage> {
  session: string;
  agent: string;
  /** Whether the harness recorded usage the CLI could read. */
  measured: boolean;
}

export interface UsageRow {
  /** "coordinator", or the thread's task. */
  name: string;
  title?: string;
  sessions: SessionUsage[];
  total: TokenUsage;
  /** Sessions with no usage the CLI can read. */
  unmeasured: number;
}

export interface ProgramUsage {
  program: string;
  name?: string;
  coordinator: UsageRow;
  threads: UsageRow[];
  /** Every thread's together. */
  workers: TokenUsage;
}

export type MeasureSession = (agent: string, session: string) => SessionUsage;

const empty = (): TokenUsage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

function add(into: TokenUsage, from: Partial<TokenUsage>): void {
  into.input += from.input ?? 0;
  into.cacheRead += from.cacheRead ?? 0;
  into.cacheWrite += from.cacheWrite ?? 0;
  into.output += from.output ?? 0;
  if (typeof from.credits === "number") into.credits = (into.credits ?? 0) + from.credits;
}

function jsonLines(file: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A Claude Code transcript's usage: each assistant message once (its chunks repeat the usage). */
export function claudeUsage(entries: unknown[]): TokenUsage {
  const byMessage = new Map<string, Record<string, unknown>>();
  entries.forEach((entry, index) => {
    const line = entry as { type?: string; message?: { id?: string; usage?: Record<string, unknown> } };
    if (line?.type !== "assistant" || !line.message?.usage) return;
    byMessage.set(line.message.id ?? `#${index}`, line.message.usage);
  });
  const total = empty();
  for (const usage of byMessage.values()) {
    add(total, { input: num(usage.input_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens), output: num(usage.output_tokens) });
  }
  return total;
}

/** A Codex rollout's usage: its last running total. */
export function codexUsage(entries: unknown[]): TokenUsage | undefined {
  let last: Record<string, unknown> | undefined;
  for (const entry of entries) {
    const payload = (entry as { payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } } })?.payload;
    if (payload?.type === "token_count" && payload.info?.total_token_usage) last = payload.info.total_token_usage;
  }
  if (!last) return undefined;
  const cached = num(last.cached_input_tokens);
  return { input: Math.max(0, num(last.input_tokens) - cached), cacheRead: cached, cacheWrite: num(last.cache_write_input_tokens), output: num(last.output_tokens) };
}

/** Claude Code transcripts by session, read once per run (sessionTranscriptPath reads every
 *  project folder for each). */
function claudeTranscripts(): (session: string) => string | undefined {
  let index: Map<string, string> | undefined;
  return (session) => {
    if (!index) {
      index = new Map();
      const root = join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || "", ".claude"), "projects");
      let folders: string[] = [];
      try { folders = readdirSync(root); } catch { /* none */ }
      for (const folder of folders) {
        try {
          if (!statSync(join(root, folder)).isDirectory()) continue;
          for (const name of readdirSync(join(root, folder))) {
            if (name.endsWith(".jsonl")) index.set(name.slice(0, -6), join(root, folder, name));
          }
        } catch { /* unreadable */ }
      }
    }
    return index.get(session);
  };
}

export function sessionMeasurer(): MeasureSession {
  const claude = claudeTranscripts();
  return (agent, session) => {
    const kind = agent.toLowerCase();
    if (kind === "claude" || kind === "codex") {
      const file = kind === "claude" ? claude(session) : sessionTranscriptPath(kind, session);
      const usage = file ? (kind === "claude" ? claudeUsage(jsonLines(file)) : codexUsage(jsonLines(file))) : undefined;
      const measured = Boolean(usage && (usage.input || usage.cacheRead || usage.cacheWrite || usage.output));
      return { session, agent, measured, ...(measured ? usage : {}) };
    }
    if (kind.startsWith("kiro")) {
      const spend = readKiroSessionUsage(session).spend;
      return typeof spend === "number" ? { session, agent, measured: true, credits: spend } : { session, agent, measured: false };
    }
    return { session, agent, measured: false };
  };
}

function usageRow(name: string, title: string | undefined, sessions: Array<{ agent?: unknown; session: string }>, measure: MeasureSession): UsageRow {
  const seen = new Set<string>();
  const usages = sessions
    .filter((entry) => typeof entry.agent === "string" && !seen.has(entry.session) && Boolean(seen.add(entry.session)))
    .map((entry) => measure(entry.agent as string, entry.session));
  const total = empty();
  for (const usage of usages) add(total, usage);
  return { name, ...(title ? { title } : {}), sessions: usages, total, unmeasured: usages.filter((usage) => !usage.measured).length };
}

function sessionsIn(file: string): Array<{ agent?: unknown; session: string }> {
  return jsonLines(file).filter((entry): entry is { agent?: unknown; session: string } => typeof (entry as { session?: unknown })?.session === "string");
}

function readJSON(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function programUsage(program: string, measure: MeasureSession = sessionMeasurer()): ProgramUsage {
  let tasks: string[] = [];
  try {
    tasks = readdirSync(join(program, "tasks")).filter((name) => statSync(join(program, "tasks", name)).isDirectory()).sort();
  } catch { /* no threads */ }
  const coordinator = usageRow("coordinator", undefined, sessionsIn(join(program, "coordinators.jsonl")), measure);
  const threads = tasks.map((task) => {
    const dir = join(program, "tasks", task);
    const title = readJSON(join(dir, "task.json")).title;
    return usageRow(task, typeof title === "string" ? title : undefined, sessionsIn(join(dir, "sessions.jsonl")), measure);
  });
  const workers = empty();
  for (const thread of threads) add(workers, thread.total);
  const name = readJSON(join(program, "program.json")).name;
  return { program, ...(typeof name === "string" ? { name } : {}), coordinator, threads, workers };
}

/** The share of input that came from the cache, in percent. */
export function cacheShare(usage: TokenUsage): number | undefined {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return input > 0 ? Math.round((usage.cacheRead / input) * 100) : undefined;
}

const amount = (value: number): string => (value >= 1e6 ? `${(value / 1e6).toFixed(1)} M` : value >= 1e3 ? `${Math.round(value / 1e3)} k` : String(value));

export function formatProgramUsage(usage: ProgramUsage): string {
  const cells = (row: { name: string; title?: string; total: TokenUsage; count: number; unmeasured: number }) => {
    const share = cacheShare(row.total);
    return [
      row.title ? `${row.name} · ${row.title}` : row.name,
      String(row.count),
      amount(row.total.input), amount(row.total.cacheRead), amount(row.total.cacheWrite), amount(row.total.output),
      share === undefined ? "" : `${share} %`,
      row.total.credits === undefined ? "" : row.total.credits.toFixed(1),
      row.unmeasured ? String(row.unmeasured) : "",
    ];
  };
  const size = (total: TokenUsage) => total.input + total.cacheRead + total.cacheWrite + total.output;
  const rows = [
    ["", "sessions", "input", "cache read", "cache write", "output", "cached", "credits", "unmeasured"],
    cells({ ...usage.coordinator, count: usage.coordinator.sessions.length }),
    cells({
      name: "all workers",
      total: usage.workers,
      count: usage.threads.reduce((sum, thread) => sum + thread.sessions.length, 0),
      unmeasured: usage.threads.reduce((sum, thread) => sum + thread.unmeasured, 0),
    }),
    ...[...usage.threads].sort((a, b) => size(b.total) - size(a.total)).map((thread) => cells({ ...thread, count: thread.sessions.length })),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return [
    usage.name ? `${usage.name} (${usage.program})` : usage.program,
    "",
    ...rows.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ")),
    "",
    "Input is read at full price, cache reads at about a tenth of it. Kiro counts credits, not tokens. Unmeasured sessions are of harnesses that record no usage (Pi, OpenCode, Copilot).",
  ].join("\n");
}

// --- what each of a coordinator's turns cost (Peter, 2026-11-27) ---------------------------------
// The coordinator is woken for every message in its threads; what that costs against the turns the
// user starts is read back from its sessions' logs (~/.agents/sessions/<harness>/<session>.jsonl,
// written by the pane's ACP host): each prompt line says what began a turn (an <agents-event> wake,
// or the user's words) and each turnEnd when it ended. Tokens per turn come from Claude Code's
// transcript (its messages in the turn's time), credits from Kiro's own per-turn figures (the
// turns in order), cost from the agent's last usage_update where it sends one (cumulative, so a
// turn's is the difference).

export type TurnKind = "wake" | "user";

export interface CoordinatorTurn {
  session: string;
  agent: string;
  at: string;
  kind: TurnKind;
  /** The envelope's kind for a wake (wake, thread, message, messages, …). */
  event?: string;
  ms?: number;
  usage?: TokenUsage;
  cost?: number;
}

export interface TurnSummary {
  turns: number;
  usage: TokenUsage;
  /** Where the agent says it. */
  cost?: number;
  ms: number;
}

export interface CoordinatorTurns {
  program: string;
  from?: string;
  to?: string;
  /** Hours from the first turn to the last. */
  hours: number;
  wake: TurnSummary;
  user: TurnSummary;
  turns: CoordinatorTurn[];
}

function findSessionLog(session: string, root: string): string | undefined {
  let harnesses: string[] = [];
  try { harnesses = readdirSync(root); } catch { return undefined; }
  for (const harness of harnesses) {
    const file = join(root, harness, `${session}.jsonl`);
    try { if (statSync(file).isFile()) return file; } catch { /* not this one */ }
  }
  return undefined;
}

function promptText(line: Record<string, unknown>): string {
  const prompt = line.prompt ?? line.content ?? line.text;
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) return prompt.map((block) => (typeof (block as { text?: unknown })?.text === "string" ? (block as { text: string }).text : "")).join("");
  return "";
}

/** The turns a session log holds, with what began each. */
export function turnsInLog(lines: unknown[], session: string, agent: string): CoordinatorTurn[] {
  const turns: CoordinatorTurn[] = [];
  let open: CoordinatorTurn | undefined;
  let lastCost: number | undefined;
  for (const entry of lines) {
    const line = entry as Record<string, unknown>;
    if (line?.kind === "user" && !open) {
      const text = promptText(line).trimStart();
      const wake = text.startsWith("<agents-event");
      const event = wake ? text.match(/^<agents-event[^>]*\bkind="([^"]+)"/)?.[1] ?? "wake" : undefined;
      const from = wake ? text.match(/^<agents-event[^>]*\bfrom="([^"]+)"/)?.[1] : undefined;
      open = { session, agent, at: String(line.at ?? ""), kind: wake && from !== "user" ? "wake" : "user", ...(event ? { event } : {}) };
    } else if (line?.kind === "turnEnd" && open) {
      if (typeof line.ms === "number") open.ms = line.ms;
      const amount = num((line.usage as { cost?: { amount?: unknown } } | undefined)?.cost?.amount);
      if (amount > 0) {
        if (lastCost !== undefined && amount >= lastCost) open.cost = amount - lastCost;
        lastCost = amount;
      }
      turns.push(open);
      open = undefined;
    }
  }
  if (open) turns.push(open);
  return turns;
}

function turnSummary(turns: CoordinatorTurn[]): TurnSummary {
  const usage = empty();
  let cost: number | undefined;
  let ms = 0;
  for (const turn of turns) {
    if (turn.usage) add(usage, turn.usage);
    if (turn.cost !== undefined) cost = (cost ?? 0) + turn.cost;
    ms += turn.ms ?? 0;
  }
  return { turns: turns.length, usage, ...(cost !== undefined ? { cost } : {}), ms };
}

export function coordinatorTurns(program: string, root: string = sessionLogsRoot()): CoordinatorTurns {
  const claude = claudeTranscripts();
  const turns: CoordinatorTurn[] = [];
  const seen = new Set<string>();
  for (const entry of sessionsIn(join(program, "coordinators.jsonl"))) {
    if (seen.has(entry.session)) continue;
    seen.add(entry.session);
    const agent = typeof entry.agent === "string" ? entry.agent.toLowerCase() : "";
    const log = findSessionLog(entry.session, root);
    if (!log) continue;
    const own = turnsInLog(jsonLines(log), entry.session, agent);
    if (agent === "claude") {
      // Its messages in each turn's time, from its own transcript.
      const file = claude(entry.session);
      const lines = file ? jsonLines(file) : [];
      own.forEach((turn, index) => {
        const start = Date.parse(turn.at);
        const end = own[index + 1] ? Date.parse(own[index + 1].at) : Infinity;
        turn.usage = claudeUsage(lines.filter((line) => {
          const at = Date.parse(String((line as { timestamp?: unknown })?.timestamp ?? ""));
          return at >= start && at < end;
        }));
      });
    } else if (agent.startsWith("kiro")) {
      const credits = readKiroTurnCredits(entry.session);
      // Kiro counts every prompt turn of the session; the log may begin later (a resumed one).
      const offset = Math.max(0, credits.length - own.length);
      own.forEach((turn, index) => {
        const value = credits[offset + index];
        if (value !== undefined) turn.usage = { ...empty(), credits: value };
      });
    }
    turns.push(...own);
  }
  turns.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const from = turns[0]?.at;
  const to = turns.at(-1)?.at;
  const hours = from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 3_600_000) : 0;
  return {
    program, ...(from ? { from } : {}), ...(to ? { to } : {}), hours,
    wake: turnSummary(turns.filter((turn) => turn.kind === "wake")),
    user: turnSummary(turns.filter((turn) => turn.kind === "user")),
    turns,
  };
}

export function formatCoordinatorTurns(report: CoordinatorTurns): string {
  if (report.turns.length === 0) return `No turns of the coordinator in its session logs (${report.program}).`;
  const perHour = (value: number, digits = 1) => (report.hours >= 0.1 ? (value / report.hours).toFixed(digits) : "");
  const row = (name: string, part: TurnSummary) => {
    const tokens = part.usage.input + part.usage.cacheRead + part.usage.cacheWrite + part.usage.output;
    return [
      name, String(part.turns), perHour(part.turns),
      tokens ? amount(tokens) : "", tokens && report.hours >= 0.1 ? amount(Math.round(tokens / report.hours)) : "",
      part.usage.credits === undefined ? "" : part.usage.credits.toFixed(1),
      part.usage.credits === undefined ? "" : perHour(part.usage.credits),
      part.cost === undefined ? "" : `$${part.cost.toFixed(2)}`,
    ];
  };
  const rows = [
    ["", "turns", "/h", "tokens", "tokens/h", "credits", "credits/h", "cost"],
    row("wakes", report.wake),
    row("your turns", report.user),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((cells) => cells[column].length)));
  return [
    `Coordinator turns, ${report.from} to ${report.to} (${report.hours.toFixed(1)} h)`,
    "",
    ...rows.map((cells) => cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ")),
    "",
    "Wakes are turns a line from the CLI began (a worker's report, a message in a thread); your turns are the ones your words began. Tokens from Claude Code's transcripts, credits from Kiro's own files, cost where the agent reports it.",
  ].join("\n");
}
