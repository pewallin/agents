// The session log of an ACP session: what the pane's ACP view drew, in ACP terms, one JSON line
// each, at ~/.agents/sessions/<harness>/<session-id>.jsonl. The pane's ACP host writes it as the
// traffic between a view (or the host itself) and the agent passes through it; a pane opens from
// it without starting its agent, and `agents session-log` reads it (over SSH too).
//
//   {v: 1, n, at, kind, …}
//   start     the first line: session, harness, cwd, and where it goes on from (previous: the
//             pane's session before it, after a /clear, an agent switch or Kiro's copy), the
//             pane, program and task, and how it began (how: {start: "respawn", why})
//   user      a prompt, as sent: text, images (as references), files; steered for one that went
//             into a running turn
//   agent     the agent's message, its chunks joined
//   thought   the agent's thinking, joined likewise
//   tool      a tool call when it settles: title, toolKind, status, locations, rawInput, its
//             content (a diff whole, text to its last 200 lines) and rawOutput
//   plan      the plan's entries as the agent last sent them
//   permission a question for permission: the tool call and the options
//   choice    the option picked for it, or cancelled
//   turnEnd   the end of a prompt's turn: stopReason, ms, counts, and the session's choices
//             (mode, model, effort) then, which a resumed session is given again
//
// One writer per file (the host that has the session); a reader skips a line it cannot parse (a
// torn last line). Lines are only appended. A session from before the log gets one when it is
// first opened through its harness: the host writes what the agent replays (P4), once.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSharedAgentsHome } from "./paths.js";

export const SESSION_LOG_VERSION = 1;
/** Lines of a tool's output the log keeps: the end, where results and errors are. */
export const TOOL_OUTPUT_LINES = 200;
/** A tool's raw output kept whole up to this size; a larger one is kept as its last lines. */
const RAW_OUTPUT_BYTES = 32 * 1024;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const HARNESS = /^[a-z0-9-]{1,40}$/;

export type SessionLogKind = "start" | "user" | "agent" | "thought" | "tool" | "plan" | "permission" | "choice" | "turnEnd";

export interface SessionLogLine {
  v: number;
  n: number;
  at: string;
  kind: SessionLogKind;
  [field: string]: unknown;
}

/** Where the chain of a session goes on from, and how it began. */
export interface SessionLogOrigin {
  previous?: string;
  pane?: string;
  program?: string;
  task?: string;
  how?: { start: string; why?: string };
}

export function sessionLogsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_SESSIONS_DIR || join(getSharedAgentsHome(env), "sessions");
}

export function sessionLogPath(harness: string, sessionId: string, root = sessionLogsRoot()): string {
  if (!HARNESS.test(harness)) throw new Error(`not a harness name: ${harness}`);
  if (!SESSION_ID.test(sessionId) || sessionId.startsWith(".")) throw new Error(`not a session id: ${sessionId}`);
  return join(root, harness, `${sessionId}.jsonl`);
}

/** The folder of a log's pictures: `<session>.files/<sha256>.<ext>`. */
export function sessionLogFilesDir(logPath: string): string {
  return logPath.replace(/\.jsonl$/, ".files");
}

/** The lines of a log, those after `after` (an `n`) only; a line that does not parse is skipped. */
export function parseSessionLog(text: string, after = -1): SessionLogLine[] {
  const lines: SessionLogLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as SessionLogLine;
      if (value && typeof value === "object" && typeof value.kind === "string" && typeof value.n === "number" && value.n > after) lines.push(value);
    } catch {
      // A torn line (the writer stopped in it): the next line starts afresh.
    }
  }
  return lines;
}

/** The log of `sessionId` under any harness, if there is one. */
export function findSessionLog(sessionId: string, root = sessionLogsRoot()): { harness: string; path: string } | undefined {
  if (!SESSION_ID.test(sessionId) || sessionId.startsWith(".")) return undefined;
  let harnesses: string[];
  try {
    harnesses = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const harness of harnesses) {
    const path = join(root, harness, `${sessionId}.jsonl`);
    if (HARNESS.test(harness) && existsSync(path)) return { harness, path };
  }
  return undefined;
}

export function readSessionLog(sessionId: string, options: { after?: number; root?: string } = {}): { session: string; harness: string; path: string; lines: SessionLogLine[] } | undefined {
  const found = findSessionLog(sessionId, options.root);
  if (!found) return undefined;
  let text = "";
  try { text = readFileSync(found.path, "utf8"); } catch { /* gone since */ }
  return { session: sessionId, ...found, lines: parseSessionLog(text, options.after) };
}

/** The sessions a session goes on from, oldest first, ending with it: each log's start line
 *  names the one before it (`previous`). A session with no log ends the chain. */
export function sessionLogChain(sessionId: string, root = sessionLogsRoot()): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.unshift(current);
    const log = readSessionLog(current, { root });
    const start = log?.lines.find((line) => line.kind === "start");
    current = typeof start?.previous === "string" ? start.previous : undefined;
  }
  return chain;
}

/** The last `n` of a log, or -1 for none; and whether its end is torn (no newline). */
function lastNumber(path: string): { n: number; torn: boolean } {
  let text: string;
  try {
    const size = statSync(path).size;
    if (size === 0) return { n: -1, torn: false };
    text = readFileSync(path, "utf8");
  } catch {
    return { n: -1, torn: false };
  }
  const lines = parseSessionLog(text);
  return { n: lines.length > 0 ? lines[lines.length - 1].n : -1, torn: !text.endsWith("\n") };
}

/** The last `limit` lines of a text. */
export function lastLines(text: string, limit = TOOL_OUTPUT_LINES): string {
  const lines = text.split("\n");
  return lines.length <= limit ? text : [`… ${lines.length - limit} lines before`, ...lines.slice(-limit)].join("\n");
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };

/** One session's log, appended to by the host that has the session. */
export class SessionLogWriter {
  private n: number;

  constructor(readonly path: string, readonly sessionId: string, readonly harness: string) {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const last = lastNumber(path);
    this.n = last.n;
    // A line torn by a writer that stopped in it ends here; the next starts on a line of its own.
    if (last.torn) appendFileSync(path, "\n");
  }

  /** Whether the log has lines already (a session opened from the log rather than replayed). */
  get hasLines(): boolean {
    return this.n >= 0;
  }

  get lastN(): number {
    return this.n;
  }

  append(kind: SessionLogKind, fields: Record<string, unknown>, at = new Date()): SessionLogLine {
    this.n += 1;
    const line: SessionLogLine = { v: SESSION_LOG_VERSION, n: this.n, at: at.toISOString(), kind, ...fields };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return line;
  }

  /** An image as a reference to a file beside the log, written once by its content. */
  image(mimeType: unknown, data: unknown): Record<string, unknown> | undefined {
    if (typeof data !== "string" || !data) return undefined;
    const type = typeof mimeType === "string" ? mimeType : "image/png";
    const name = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${IMAGE_EXTENSIONS[type] ?? "bin"}`;
    const directory = sessionLogFilesDir(this.path);
    const file = join(directory, name);
    try {
      if (!existsSync(file)) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(file, Buffer.from(data, "base64"), { mode: 0o600 });
      }
    } catch {
      return { type: "image", mimeType: type, ref: null };
    }
    return { type: "image", mimeType: type, ref: name };
  }
}

/** What the log's lines go to: the file, or a buffer while an agent replays a session the log
 *  has already. */
interface LogSink {
  readonly lastN: number;
  append(kind: SessionLogKind, fields: Record<string, unknown>, at?: Date): unknown;
  image(mimeType: unknown, data: unknown): Record<string, unknown> | undefined;
}

class ReplayBuffer implements LogSink {
  readonly lines: Array<{ kind: SessionLogKind; fields: Record<string, unknown> }> = [];
  constructor(private readonly file: SessionLogWriter) {}
  get lastN(): number { return this.file.lastN; }
  append(kind: SessionLogKind, fields: Record<string, unknown>): void { this.lines.push({ kind, fields }); }
  image(mimeType: unknown, data: unknown): Record<string, unknown> | undefined { return this.file.image(mimeType, data); }
}

type Id = string | number;
interface Message {
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

function parse(line: string): Message | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Message : undefined;
  } catch {
    return undefined;
  }
}

interface PendingTool {
  id: string;
  title?: string;
  toolKind?: string;
  status?: string;
  locations?: unknown[];
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  startedAt: number;
}

interface OpenLog {
  file: SessionLogWriter;
  /** Where lines go now: the file, or the replay buffer. */
  writer: LogSink;
  /** The agent replays a session the log has already: what it replays is not written again. */
  replaying: "write" | "skip" | undefined;
  /** The message or thought being streamed, joined until something else comes. */
  text?: { kind: "agent" | "thought" | "user"; text: string; images: unknown[]; replay: boolean };
  tools: Map<string, PendingTool>;
  turn?: { startedAt: number; tools: number; edits: number; failed: number };
  /** The session's choices as the agent last said (config options, mode, model), for turnEnd. */
  config: Record<string, string>;
  lastPlan?: string;
  /** How the session began (a respawn and why), for its first turn's line. */
  how?: { start: string; why?: string };
}

export interface SessionLogTapOptions {
  harness: string;
  cwd?: string;
  root?: string;
  /** Where a session's chain goes on from, asked once when its log is first made. */
  origin?: (sessionId: string) => SessionLogOrigin;
  /** A log was made or opened for a session (the host keeps the pane's last session). */
  onSession?: (sessionId: string) => void;
  log?: (message: string) => void;
}

/**
 * Writes the session logs of what passes between clients and their agents in one host. A host
 * makes one tap and gives it every line, with the stream it is on (a view's bridge, or the host's
 * own session): request ids are per stream.
 */
export class SessionLogTap {
  private readonly logs = new Map<string, OpenLog>();
  /** Per stream: requests in flight that the log needs answered (prompts, loads, news, steers,
   *  and the agent's permission questions). */
  private readonly requests = new Map<string, { method: string; sessionId?: string; prompt?: unknown[]; toolCallId?: string; options?: unknown[] }>();

  /** Sessions being loaded that have no log yet: one is made when the agent shows it has them. */
  private readonly loading = new Set<string>();

  constructor(private readonly options: SessionLogTapOptions) {}

  private hasLog(sessionId: string): boolean {
    try {
      return existsSync(sessionLogPath(this.options.harness, sessionId, this.options.root));
    } catch {
      return false;
    }
  }

  /** The log of a session being loaded, made now that the agent shows it has the session. */
  private loaded(sessionId: string): OpenLog | undefined {
    if (!this.loading.delete(sessionId)) return this.logs.get(sessionId);
    const open = this.open(sessionId);
    if (open) open.replaying = "write";
    return open;
  }

  /** A line from a client to the agent. */
  clientLine(stream: string, line: string): void {
    const message = parse(line);
    if (!message) return;
    try { this.fromClient(stream, message); } catch (error) { this.fail(error); }
  }

  /** A line from the agent to a client. */
  agentLine(stream: string, line: string): void {
    const message = parse(line);
    if (!message) return;
    try { this.fromAgent(stream, message); } catch (error) { this.fail(error); }
  }

  /** A stream ended (its view closed, its agent exited): what it streamed is written. */
  streamGone(stream: string): void {
    for (const key of [...this.requests.keys()]) if (key.startsWith(`${stream}\u0000`)) this.requests.delete(key);
    for (const open of this.logs.values()) this.flushAll(open);
  }

  /** Everything still being streamed, written now (the host closes). */
  flush(): void {
    for (const open of this.logs.values()) this.flushAll(open);
  }

  /** The log of a session this tap writes, if it has opened one. */
  writerOf(sessionId: string): SessionLogWriter | undefined {
    return this.logs.get(sessionId)?.file;
  }

  private fail(error: unknown): void {
    this.options.log?.(`session log: ${error instanceof Error ? error.message : String(error)}`);
  }

  private key(stream: string, id: Id): string {
    return `${stream}\u0000${String(id)}`;
  }

  private open(sessionId: string): OpenLog | undefined {
    const known = this.logs.get(sessionId);
    if (known) return known;
    let path: string;
    try {
      path = sessionLogPath(this.options.harness, sessionId, this.options.root);
    } catch {
      return undefined;
    }
    const writer = new SessionLogWriter(path, sessionId, this.options.harness);
    let how: OpenLog["how"];
    if (!writer.hasLines) {
      const origin = this.options.origin?.(sessionId) ?? {};
      const previous = origin.previous && origin.previous !== sessionId ? origin.previous : undefined;
      writer.append("start", {
        session: sessionId,
        harness: this.options.harness,
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
        ...(previous ? { previous } : {}),
        ...(origin.pane ? { pane: origin.pane } : {}),
        ...(origin.program ? { program: origin.program } : {}),
        ...(origin.task ? { task: origin.task } : {}),
        ...(origin.how ? { how: origin.how } : {}),
      });
      how = origin.how;
    }
    const open: OpenLog = { file: writer, writer, replaying: undefined, tools: new Map(), config: {}, ...(how ? { how } : {}) };
    this.logs.set(sessionId, open);
    this.options.onSession?.(sessionId);
    return open;
  }

  private fromClient(stream: string, message: Message): void {
    const id = message.id;
    const params = message.params ?? {};
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (message.method === undefined) {
      // An answer from the client: to a permission question of the agent's.
      if (id === undefined || id === null) return;
      const asked = this.requests.get(this.key(stream, id));
      if (!asked || asked.method !== "session/request_permission") return;
      this.requests.delete(this.key(stream, id));
      const open = asked.sessionId ? this.logs.get(asked.sessionId) : undefined;
      if (!open) return;
      const outcome = (message.result as { outcome?: { outcome?: unknown; optionId?: unknown } } | undefined)?.outcome;
      const optionId = typeof outcome?.optionId === "string" ? outcome.optionId : undefined;
      const option = (asked.options as Array<{ optionId?: unknown; kind?: unknown }> | undefined)?.find((entry) => entry.optionId === optionId);
      this.flushText(open);
      open.writer.append("choice", {
        request: String(id),
        ...(asked.toolCallId ? { toolCallId: asked.toolCallId } : {}),
        outcome: outcome?.outcome === "selected" ? "selected" : "cancelled",
        ...(optionId ? { optionId } : {}),
        ...(typeof option?.kind === "string" ? { optionKind: option.kind } : {}),
      });
      return;
    }
    if (id === undefined || id === null) return;
    if (message.method === "session/new") {
      this.requests.set(this.key(stream, id), { method: "session/new" });
    } else if ((message.method === "session/load" || message.method === "session/resume") && sessionId) {
      this.requests.set(this.key(stream, id), { method: "session/load", sessionId });
      // A session the log has already: the agent's replay of it is not written twice. One with
      // no log gets one once the agent shows it has the session (its replay or its answer): a
      // load that fails (a session never written) leaves no log behind.
      const known = this.logs.get(sessionId) ?? (this.hasLog(sessionId) ? this.open(sessionId) : undefined);
      if (known) {
        known.replaying = known.file.lastN > 0 ? "skip" : "write";
        if (known.replaying === "skip") known.writer = new ReplayBuffer(known.file);
      } else {
        this.loading.add(sessionId);
      }
    } else if ((message.method === "session/prompt" || message.method === "_session/steering") && sessionId) {
      const prompt = Array.isArray(params.prompt) ? params.prompt as unknown[] : [];
      this.requests.set(this.key(stream, id), { method: message.method, sessionId, prompt });
      if (message.method === "session/prompt") {
        const open = this.open(sessionId);
        if (!open) return;
        this.flushAll(open);
        this.writeUser(open, prompt, false);
        open.turn = { startedAt: Date.now(), tools: 0, edits: 0, failed: 0 };
      }
    } else if (message.method === "session/set_config_option" && sessionId && typeof params.configId === "string" && typeof params.value === "string") {
      const open = this.logs.get(sessionId);
      if (open) open.config[params.configId] = params.value;
    } else if (message.method === "session/set_mode" && sessionId && typeof params.modeId === "string") {
      const open = this.logs.get(sessionId);
      if (open) open.config.mode = params.modeId;
    } else if (message.method === "session/set_model" && sessionId && typeof params.modelId === "string") {
      const open = this.logs.get(sessionId);
      if (open) open.config.model = params.modelId;
    }
  }

  private fromAgent(stream: string, message: Message): void {
    const id = message.id;
    if (message.method === "session/update") {
      const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;
      const open = sessionId ? this.loaded(sessionId) : undefined;
      if (!open) return;
      this.update(open, message.params?.update as Record<string, unknown> | undefined, open.replaying !== undefined);
      return;
    }
    if (message.method === "session/request_permission" && id !== undefined && id !== null) {
      const params = message.params ?? {};
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      const open = sessionId ? this.logs.get(sessionId) : undefined;
      if (!open) return;
      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
      const options = Array.isArray(params.options) ? params.options : [];
      this.requests.set(this.key(stream, id), {
        method: "session/request_permission",
        sessionId,
        toolCallId: typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined,
        options,
      });
      this.flushText(open);
      open.writer.append("permission", {
        request: String(id),
        ...(typeof toolCall.toolCallId === "string" ? { toolCallId: toolCall.toolCallId } : {}),
        ...(typeof toolCall.title === "string" ? { title: toolCall.title } : {}),
        ...(typeof toolCall.kind === "string" ? { toolKind: toolCall.kind } : {}),
        ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
        options: options.map((option) => {
          const { optionId, name, kind } = option as Record<string, unknown>;
          return { optionId, name, kind };
        }),
      });
      return;
    }
    if (message.method !== undefined || id === undefined || id === null) return;
    const key = this.key(stream, id);
    const asked = this.requests.get(key);
    if (!asked) return;
    this.requests.delete(key);
    if (asked.method === "session/new") {
      const sessionId = message.result?.sessionId;
      if (typeof sessionId !== "string") return;
      const open = this.open(sessionId);
      if (open) this.followOpened(open, message.result);
    } else if (asked.method === "session/load" && asked.sessionId) {
      if (message.error) this.loading.delete(asked.sessionId);
      const open = message.error ? this.logs.get(asked.sessionId) : this.loaded(asked.sessionId);
      if (!open) return;
      if (open.replaying) this.flushAll(open);
      if (open.writer instanceof ReplayBuffer) this.reconcile(open, open.writer);
      open.writer = open.file;
      open.replaying = undefined;
      if (!message.error) this.followOpened(open, message.result);
    } else if (asked.method === "_session/steering" && asked.sessionId) {
      const open = this.logs.get(asked.sessionId);
      const outcome = message.result?.outcome;
      if (!open || message.error || outcome === "promptRequired") return;
      this.flushAll(open);
      this.writeUser(open, asked.prompt ?? [], false, true);
    } else if (asked.method === "session/prompt" && asked.sessionId) {
      const open = this.logs.get(asked.sessionId);
      if (!open) return;
      this.flushAll(open, true);
      const turn = open.turn;
      open.turn = undefined;
      const stopReason = message.result?.stopReason;
      open.writer.append("turnEnd", {
        stopReason: typeof stopReason === "string" ? stopReason : message.error ? "error" : null,
        ...(message.error ? { error: errorText(message.error) } : {}),
        ...(turn ? { ms: Date.now() - turn.startedAt, tools: turn.tools, edits: turn.edits, failed: turn.failed } : {}),
        ...(Object.keys(open.config).length > 0 ? { config: { ...open.config } } : {}),
        ...(open.how ? { how: open.how } : {}),
      });
      open.how = undefined;
    }
  }

  /**
   * A replay of a session the log has already: the turns it has after the log's last prompt (the
   * pane's TUI had the session meanwhile) are written; the rest is in the log.
   */
  private reconcile(open: OpenLog, buffer: ReplayBuffer): void {
    let logged = 0;
    try {
      logged = parseSessionLog(readFileSync(open.file.path, "utf8")).filter((line) => line.kind === "user").length;
    } catch {
      return;
    }
    let users = 0;
    let from = -1;
    for (const [index, line] of buffer.lines.entries()) {
      if (line.kind !== "user") continue;
      users += 1;
      if (users === logged + 1) { from = index; break; }
    }
    if (from < 0) return;
    for (const line of buffer.lines.slice(from)) open.file.append(line.kind, line.fields);
  }

  /** The choices a session opened with (its config options, mode and model). */
  private followOpened(open: OpenLog, result: Record<string, unknown> | undefined): void {
    if (!result) return;
    for (const option of Array.isArray(result.configOptions) ? result.configOptions as Array<Record<string, unknown>> : []) {
      if (typeof option.id === "string" && typeof option.currentValue === "string") open.config[option.id] = option.currentValue;
    }
    const modes = result.modes as { currentModeId?: unknown } | undefined;
    if (typeof modes?.currentModeId === "string" && open.config.mode === undefined) open.config.mode = modes.currentModeId;
    const models = result.models as { currentModelId?: unknown } | undefined;
    if (typeof models?.currentModelId === "string" && open.config.model === undefined) open.config.model = models.currentModelId;
  }

  private followConfig(open: OpenLog, update: Record<string, unknown> | undefined): void {
    if (update?.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") open.config.mode = update.currentModeId;
    else if (update?.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) this.followOpened(open, { configOptions: update.configOptions });
  }

  private update(open: OpenLog, update: Record<string, unknown> | undefined, replay: boolean): void {
    const kind = update?.sessionUpdate;
    if (!update || typeof kind !== "string") return;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "user_message_chunk") {
      const textKind = kind === "agent_message_chunk" ? "agent" : kind === "agent_thought_chunk" ? "thought" : "user";
      // A live turn's own prompt is written as it was sent; an agent that echoes it adds nothing.
      if (textKind === "user" && !replay) return;
      if (open.text && open.text.kind !== textKind) this.flushText(open);
      const content = update.content as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown; uri?: unknown; name?: unknown } | undefined;
      open.text ??= { kind: textKind, text: "", images: [], replay };
      if (content?.type === "text" && typeof content.text === "string") open.text.text += content.text;
      else if (content?.type === "image") {
        const image = open.writer.image(content.mimeType, content.data);
        if (image) open.text.images.push(image);
      } else if ((content?.type === "resource_link" || content?.type === "resource") && textKind === "user") {
        const resource = (content as { resource?: { uri?: unknown } }).resource;
        const uri = typeof content.uri === "string" ? content.uri : typeof resource?.uri === "string" ? resource.uri : undefined;
        if (uri) open.text.images.push({ type: "file", uri, ...(typeof content.name === "string" ? { name: content.name } : {}) });
      }
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      this.flushText(open);
      const toolCallId = update.toolCallId;
      if (typeof toolCallId !== "string") return;
      let tool = open.tools.get(toolCallId);
      if (!tool) {
        tool = { id: toolCallId, startedAt: Date.now() };
        open.tools.set(toolCallId, tool);
        if (open.turn) open.turn.tools += 1;
      }
      if (typeof update.title === "string") tool.title = update.title;
      if (typeof update.kind === "string") tool.toolKind = update.kind;
      if (typeof update.status === "string") tool.status = update.status;
      if (Array.isArray(update.locations)) tool.locations = update.locations;
      if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
      if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput;
      if (Array.isArray(update.content)) tool.content = update.content;
      if (tool.status === "completed" || tool.status === "failed") this.writeTool(open, tool);
      return;
    }
    if (kind === "plan") {
      this.flushText(open);
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const text = JSON.stringify(entries);
      if (text === open.lastPlan) return;
      open.lastPlan = text;
      open.writer.append("plan", { entries });
      return;
    }
    this.followConfig(open, update);
  }

  private writeUser(open: OpenLog, prompt: unknown[], replay: boolean, steered = false): void {
    let text = "";
    const attachments: unknown[] = [];
    for (const block of prompt as Array<Record<string, unknown>>) {
      if (block?.type === "text" && typeof block.text === "string") text += text ? `\n${block.text}` : block.text;
      else if (block?.type === "image") {
        const image = open.writer.image(block.mimeType, block.data);
        if (image) attachments.push(image);
      } else if (block?.type === "resource_link" && typeof block.uri === "string") {
        attachments.push({ type: "file", uri: block.uri, ...(typeof block.name === "string" ? { name: block.name } : {}) });
      } else if (block?.type === "resource") {
        const resource = block.resource as { uri?: unknown; text?: unknown } | undefined;
        if (typeof resource?.uri === "string") attachments.push({ type: "file", uri: resource.uri });
      }
    }
    open.writer.append("user", {
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(steered ? { steered: true } : {}),
      ...(replay ? { replay: true } : {}),
    });
  }

  private flushText(open: OpenLog): void {
    const text = open.text;
    if (!text) return;
    open.text = undefined;
    if (!text.text && text.images.length === 0) return;
    if (text.kind === "user") {
      open.writer.append("user", { text: text.text, ...(text.images.length > 0 ? { attachments: text.images } : {}), replay: true });
      return;
    }
    open.writer.append(text.kind, { text: text.text, ...(text.images.length > 0 ? { images: text.images } : {}), ...(text.replay ? { replay: true } : {}) });
  }

  /** The text being streamed, and with `tools` the calls that never said they settled. */
  private flushAll(open: OpenLog, tools = false): void {
    this.flushText(open);
    if (!tools && !open.replaying) return;
    for (const tool of [...open.tools.values()]) this.writeTool(open, tool);
  }

  private writeTool(open: OpenLog, tool: PendingTool): void {
    open.tools.delete(tool.id);
    const content = (tool.content ?? []).map(trimContent);
    const edits = content.some((block) => (block as { type?: unknown }).type === "diff") || tool.toolKind === "edit";
    if (open.turn) {
      if (edits) open.turn.edits += 1;
      if (tool.status === "failed") open.turn.failed += 1;
    }
    open.writer.append("tool", {
      id: tool.id,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.toolKind !== undefined ? { toolKind: tool.toolKind } : {}),
      status: tool.status ?? "pending",
      ...(tool.locations && tool.locations.length > 0 ? { locations: tool.locations } : {}),
      ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
      ...(content.length > 0 ? { content } : {}),
      ...(tool.rawOutput !== undefined ? { rawOutput: trimRaw(tool.rawOutput) } : {}),
      ...(open.replaying ? { replay: true } : { ms: Date.now() - tool.startedAt }),
    });
  }
}

/** A tool's content block as the log keeps it: a diff whole, text to its last lines, a picture as
 *  a reference (no bytes), a terminal by its id. */
function trimContent(block: unknown): unknown {
  const value = block as { type?: unknown; content?: { type?: unknown; text?: unknown; mimeType?: unknown } };
  if (value?.type === "content" && value.content?.type === "text" && typeof value.content.text === "string") {
    return { ...value, content: { ...value.content, text: lastLines(value.content.text) } };
  }
  if (value?.type === "content" && value.content?.type === "image") {
    return { type: "content", content: { type: "image", mimeType: value.content.mimeType, ref: null } };
  }
  return block;
}

function trimRaw(raw: unknown): unknown {
  if (typeof raw === "string") return lastLines(raw);
  let text: string;
  try { text = JSON.stringify(raw); } catch { return null; }
  if (text.length <= RAW_OUTPUT_BYTES) return raw;
  return { truncated: true, tail: lastLines(text.slice(-RAW_OUTPUT_BYTES)) };
}

function errorText(error: unknown): string {
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message.slice(0, 500) : "error";
}

/** One session of a chain as `agents session-log` gives it. */
export interface SessionLogEntry {
  session: string;
  harness?: string;
  /** How the session joined its thread (sessions.jsonl: spawn, adopt, changed, respawn). */
  via?: string;
  /** No log: a session from before the log, or one only its TUI had. */
  missing?: true;
  lines: SessionLogLine[];
}

/** The logs of sessions in order, each with the sessions it goes on from first. */
export function sessionLogEntries(sessions: Array<{ session: string; via?: string }>, options: { after?: number; root?: string } = {}): SessionLogEntry[] {
  const entries: SessionLogEntry[] = [];
  const seen = new Set<string>();
  for (const { session, via } of sessions) {
    for (const id of sessionLogChain(session, options.root)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const log = readSessionLog(id, { root: options.root, after: id === session ? options.after : undefined });
      entries.push(log
        ? { session: id, harness: log.harness, ...(id === session && via ? { via } : {}), lines: log.lines }
        : { session: id, ...(id === session && via ? { via } : {}), missing: true, lines: [] });
    }
  }
  return entries;
}

/** A log line as one line of plain text. */
export function sessionLogText(line: SessionLogLine): string {
  const one = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
  switch (line.kind) {
    case "start": return `— session ${one(line.session)} (${one(line.harness)})${line.previous ? ` after ${one(line.previous)}` : ""}${(line.how as { why?: string } | undefined)?.why ? `: ${one((line.how as { why?: string }).why)}` : ""}`;
    case "user": return `> ${String(line.text ?? "")}`;
    case "agent": return String(line.text ?? "");
    case "thought": return `(thinking) ${one(line.text).slice(0, 200)}`;
    case "tool": return `  [${one(line.status)}] ${one(line.title ?? line.toolKind ?? "tool")}`;
    case "plan": return `  plan: ${(Array.isArray(line.entries) ? line.entries : []).map((entry) => `${(entry as { status?: string }).status === "completed" ? "✓" : "○"} ${one((entry as { content?: string }).content)}`).join("; ")}`;
    case "permission": return `  ? asks to ${one(line.title)}`;
    case "choice": return `  ${line.outcome === "selected" ? `→ ${one(line.optionKind ?? line.optionId)}` : "→ cancelled"}`;
    case "turnEnd": return `  · turn ended (${one(line.stopReason)}${typeof line.ms === "number" ? `, ${Math.round(line.ms / 1000)} s` : ""}${typeof line.tools === "number" ? `, ${line.tools} tools` : ""})`;
    default: return "";
  }
}
