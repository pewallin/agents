// The ACP view's state for one session, kept by a pure reducer: what the agent's session/update
// notifications and the view's own actions do to it. The view renders from this alone.
import type {
  AvailableCommand,
  ContentBlock,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import { planFromToolInput } from "./plan";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCall {
  id: string;
  title: string;
  kind?: ToolKind;
  status: ToolStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  /** When the view first heard of it and when it ended, for live calls (replayed ones have none). */
  startedAt?: number;
  endedAt?: number;
}

/** One entry of the conversation, in order. A tool call is kept by id in `toolCalls`. */
export type Item =
  | { type: "user"; id: string; text: string; local?: boolean; at?: number;
      /** The images and files sent with it, shown under its text. */
      attachments: SentAttachment[];
      /** Attachments of our own prompt the agent's echo of it has yet to repeat. */
      unechoed?: number;
      /** A prompt of ours the agent has answered, whether or not it echoed it. */
      answered?: boolean;
      /** A turn another client started (the pane's TUI): Codex does not pass its prompt on. */
      external?: boolean }
  | { type: "agent"; id: string; text: string; at?: number;
      /** Pictures the agent sent (ACP image blocks), shown under its text. */
      images?: Array<{ mimeType: string; data: string }> }
  | { type: "thought"; id: string; text: string; at?: number }
  | { type: "tool"; id: string; at?: number };

/** An image or file sent with a message: a picture by its bytes, a file by its path, or both. A
 *  pasted image the agent took as an image has no name. */
export interface SentAttachment {
  kind: "image" | "file";
  name: string;
  mimeType?: string;
  data?: string;
  path?: string;
}

type UserMessage = Extract<Item, { type: "user" }>;

export interface PermissionRequest {
  /** Our id for the pending request (the JSON-RPC id it came with). */
  id: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

export type Activity = "idle" | "working";

export interface SessionState {
  title?: string;
  items: Item[];
  toolCalls: Record<string, ToolCall>;
  plan: PlanEntry[];
  permissions: PermissionRequest[];
  usage?: Pick<UsageUpdate, "used" | "size" | "cost">;
  modes?: SessionModeState;
  configOptions: SessionConfigOption[];
  commands: AvailableCommand[];
  /** Whether the agent is in a turn: ours (a prompt in flight) or another client's (Codex reports it). */
  activity: Activity;
  /** A prompt of ours is in flight. */
  prompting: boolean;
  /** Counter for ids of items the view makes itself. */
  nextLocalId: number;
  /** Whether the session's history is still being replayed (session/load): no times then. */
  replaying: boolean;
  /** When the agent last reported anything, for the length of a live turn. */
  lastEventAt?: number;
  /** The agent's state as its hooks report it for the pane (the app shows the same): a turn the
   *  pane's TUI runs is work too, though no prompt of ours is in flight. */
  agentState?: string | null;
  /** A turn another client started (Codex said its thread is active) whose first event has not
   *  come yet: a prompt of its own starts it, else it gets a marker of where it began. */
  externalTurnPending?: boolean;
  /** Whether anything of a turn came live since the thread was last idle: Codex may say the
   *  thread is active after the turn's first events. */
  liveSinceIdle?: boolean;
  /** Turns the view stopped (by the id of their user item): they say so. */
  stoppedTurns?: string[];
  /** The last line the agents CLI typed into the pane's terminal, for the turn it starts. */
  typedInTerminal?: { text: string; at: number };
}

export const emptySession = (): SessionState => ({
  items: [],
  toolCalls: {},
  plan: [],
  permissions: [],
  configOptions: [],
  commands: [],
  activity: "idle",
  prompting: false,
  nextLocalId: 1,
  replaying: false,
});

export type SessionAction =
  | { type: "update"; update: SessionUpdate; at?: number }
  | { type: "loading" }
  | { type: "loaded"; modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }
  | { type: "promptSent"; blocks: ContentBlock[]; at?: number }
  | { type: "promptEnded" }
  | { type: "permissionRequested"; request: PermissionRequest }
  | { type: "permissionAnswered"; id: string }
  | { type: "agentState"; state: string | null }
  | { type: "typedInTerminal"; text: string; at: number }
  /** The view stops the turn in progress, its own or one the pane's TUI started. */
  | { type: "stopped" }
  | { type: "reset" };

function textOf(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  // A file or page the agent points at becomes a link in its text, which the view shows as a chip.
  if (block.type === "resource_link") return ` [${(block.title ?? block.name ?? block.uri).replace(/[[\]]/g, "")}](${block.uri}) `;
  return "";
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|tiff?)$/i;

/** Whether the message's text names the file as @path: the link that came with it is the
 *  mention's, which the text already shows. */
function mentions(text: string, path: string): boolean {
  for (const match of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const named = match[1].replace(/^\.\//, "");
    if (path === named || path.endsWith(`/${named}`)) return true;
  }
  return false;
}

/** What a block of a message of ours attaches: an image, or a file it links to or embeds. None for
 *  text, a page or a pane, and a link the text names as @path. */
export function sentAttachment(block: ContentBlock, text: string): SentAttachment | null {
  if (block.type === "image") {
    const path = block.uri?.startsWith("file://") ? plainPath(block.uri) : undefined;
    return { kind: "image", name: path?.split("/").pop() ?? "", mimeType: block.mimeType, data: block.data, ...(path ? { path } : {}) };
  }
  const uri = block.type === "resource_link" ? block.uri : block.type === "resource" ? block.resource.uri : "";
  const pasted = uri.startsWith("pasted:");
  if (!uri.startsWith("file://") && !pasted) return null;
  const path = pasted ? undefined : plainPath(uri);
  if (path && mentions(text, path)) return null;
  const name = block.type === "resource_link" ? block.name : path?.split("/").pop() ?? decodeURIComponent(uri.slice("pasted:".length));
  const mimeType = block.type === "resource_link" ? block.mimeType ?? undefined : block.type === "resource" ? block.resource.mimeType ?? undefined : undefined;
  const image = mimeType?.startsWith("image/") || IMAGE_NAME.test(path ?? name);
  return { kind: image ? "image" : "file", name, ...(mimeType ? { mimeType } : {}), ...(path ? { path } : {}) };
}

/** A message of ours as the view shows it: its text, and what it attaches. */
export function sentMessage(blocks: ContentBlock[]): { text: string; attachments: SentAttachment[] } {
  const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
  return { text, attachments: blocks.flatMap((block) => sentAttachment(block, text) ?? []) };
}

// A file link as an agent writes one into its history of a message of ours: Claude and Codex keep
// an attached file as `[@name](file://…)`, Codex an image as `[@image](data:…)`, and Codex an
// embedded file as its link and its text in a <context> block.
const LINKED = /[ \t]*\[@([^\]\n]*)\]\(((?:file:\/\/|data:image\/)[^)\s]+)\)(?:\n<context ref="[^"\n]*">\n[\s\S]*?\n<\/context>)?[ \t]*/g;

/** A message of ours as it shows: the files and images its text links to as an agent keeps them
 *  in its history are attachments under it, not links in the text, and a link to a file the text
 *  names as @path is the mention's. One the message already has is not shown twice. */
export function shownMessage(text: string, attachments: SentAttachment[]): { text: string; attachments: SentAttachment[] } {
  if (!text.includes("[@")) return { text, attachments };
  const links: SentAttachment[] = [];
  const rest = text.replace(LINKED, (_whole, name: string, uri: string) => {
    const data = uri.match(/^data:(image\/[\w.+-]+);base64,(.*)$/);
    if (data) links.push({ kind: "image", name: "", mimeType: data[1], data: data[2] });
    else {
      const path = plainPath(uri);
      links.push({ kind: IMAGE_NAME.test(path) ? "image" : "file", name: name || path.split("/").pop() || path, path });
    }
    return " ";
  }).replace(/[ \t]+(\n|$)/g, "$1").trim();
  const shown = [...attachments];
  for (const link of links) {
    if (link.path && mentions(rest, link.path)) continue;
    if (shown.some((entry) => (link.path && entry.path === link.path) || (link.data && entry.data === link.data))) continue;
    shown.push(link);
  }
  return { text: rest, attachments: shown };
}

/** Adds a chunk to the open message of its kind, or opens one. A chunk with another message id,
 *  or any other item in between, starts a new message. */
function appendChunk(
  state: SessionState,
  kind: "user" | "agent" | "thought",
  block: ContentBlock,
  messageId: string | null | undefined,
  at: number | undefined,
): SessionState {
  if (kind === "user") return appendUserChunk(state, block, messageId, at);
  const text = textOf(block);
  if (kind === "agent" && block.type === "image") return appendAgentImage(state, block, messageId, at);
  if (!text) return state;
  const items = state.items;
  const last = items.at(-1);
  if (last && last.type === kind && (!messageId || last.id === messageId)) {
    return { ...state, items: [...items.slice(0, -1), { ...last, text: last.text + text }] };
  }
  const id = messageId ?? `${kind}-${state.nextLocalId}`;
  return { ...state, items: [...items, { type: kind, id, text, at }], nextLocalId: state.nextLocalId + 1 };
}

/** A chunk of a user message: its text, or an image or file sent with it. The agent may echo our
 *  own prompt back (other clients' prompts it always reports); the echo confirms what the view
 *  already shows rather than adding it again. */
function appendUserChunk(state: SessionState, block: ContentBlock, messageId: string | null | undefined, at: number | undefined): SessionState {
  const items = state.items;
  const last = items.at(-1);
  const open = last && last.type === "user" && (!messageId || last.id === messageId) ? last : undefined;
  const pending = [...items].reverse().find((item): item is UserMessage => item.type === "user" && item.local === true);
  const confirm = (item: UserMessage, changes: Partial<UserMessage>) => ({
    ...state, items: items.map((entry) => (entry === item ? { ...item, ...changes } : entry)),
  });

  if (block.type === "text" || (block.type === "resource_link" && !block.uri.startsWith("file://"))) {
    const text = textOf(block);
    if (!text) return state;
    if (pending && pending.text.startsWith(text)) return confirm(pending, { local: false, id: messageId ?? pending.id });
    if (open) return { ...state, items: [...items.slice(0, -1), { ...open, text: open.text + text }] };
    const id = messageId ?? `user-${state.nextLocalId}`;
    return { ...state, items: [...items, { type: "user", id, text, attachments: [], at }], nextLocalId: state.nextLocalId + 1 };
  }

  const attachment = sentAttachment(block, open?.text ?? pending?.text ?? "");
  if (!attachment) return state;
  if (pending && (pending.unechoed ?? 0) > 0) {
    return confirm(pending, { local: false, id: messageId ?? pending.id, unechoed: (pending.unechoed ?? 0) - 1 });
  }
  if (open && (open.unechoed ?? 0) > 0) return confirm(open, { unechoed: (open.unechoed ?? 0) - 1 });
  if (open) return { ...state, items: [...items.slice(0, -1), { ...open, attachments: [...open.attachments, attachment] }] };
  const id = messageId ?? `user-${state.nextLocalId}`;
  return { ...state, items: [...items, { type: "user", id, text: "", attachments: [attachment], at }], nextLocalId: state.nextLocalId + 1 };
}

function appendAgentImage(state: SessionState, block: Extract<ContentBlock, { type: "image" }>, messageId: string | null | undefined, at: number | undefined): SessionState {
  const picture = { mimeType: block.mimeType, data: block.data };
  const last = state.items.at(-1);
  if (last && last.type === "agent" && (!messageId || last.id === messageId)) {
    return { ...state, items: [...state.items.slice(0, -1), { ...last, images: [...(last.images ?? []), picture] }] };
  }
  const id = messageId ?? `agent-${state.nextLocalId}`;
  return { ...state, items: [...state.items, { type: "agent", id, text: "", at, images: [picture] }], nextLocalId: state.nextLocalId + 1 };
}

/** A path as a plain path: Kiro names a diff's file by a file:// URI and its location by the
 *  path, which would make one file two. */
export function plainPath(path: string): string {
  if (!path.startsWith("file://")) return path;
  try {
    return decodeURIComponent(new URL(path).pathname);
  } catch {
    return path.slice("file://".length);
  }
}

function withPlainPath<T>(entry: T): T {
  const path = (entry as { path?: unknown }).path;
  return typeof path === "string" && path.startsWith("file://") ? { ...entry, path: plainPath(path) } : entry;
}

function mergeToolCall(previous: ToolCall | undefined, update: ToolCallUpdate & { title?: string | null }, at: number | undefined): ToolCall {
  const status = (update.status ?? previous?.status ?? "pending") as ToolStatus;
  const ended = status === "completed" || status === "failed";
  return {
    id: update.toolCallId,
    title: update.title ?? previous?.title ?? "Tool call",
    kind: update.kind ?? previous?.kind,
    status,
    content: update.content ? update.content.map(withPlainPath) : previous?.content ?? [],
    locations: update.locations ? update.locations.map(withPlainPath) : previous?.locations ?? [],
    rawInput: update.rawInput !== undefined ? update.rawInput : previous?.rawInput,
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : previous?.rawOutput,
    startedAt: previous ? previous.startedAt : at,
    endedAt: previous?.endedAt ?? (ended ? at : undefined),
  };
}

/** Codex reports its thread's state on session_info_update, so a turn another client started
 *  (the pane's TUI) shows as work too. */
function reportedActivity(update: SessionUpdate): Activity | undefined {
  const status = (update._meta as { codex?: { threadStatus?: { type?: string } } } | null | undefined)
    ?.codex?.threadStatus?.type;
  if (status === "active") return "working";
  if (status === "idle") return "idle";
  return undefined;
}

/** The first event of a turn the pane's TUI started: its own prompt clears the wait; any other
 *  event comes after a marker of where the turn began, since Codex did not pass its prompt on. */
function startsTurn(state: SessionState, update: SessionUpdate, at: number | undefined): SessionState {
  const work = update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk"
    || update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update" || update.sessionUpdate === "plan";
  const live = at !== undefined && (work || update.sessionUpdate === "user_message_chunk");
  if (live && !state.liveSinceIdle) state = { ...state, liveSinceIdle: true };
  if (!state.externalTurnPending) return state;
  if (update.sessionUpdate === "user_message_chunk") return { ...state, externalTurnPending: false };
  if (!work) return state;
  const id = `external-${state.nextLocalId}`;
  // The line the agents CLI just typed into the terminal is what started it.
  const typed = state.typedInTerminal && at !== undefined && at - state.typedInTerminal.at < 30_000 ? state.typedInTerminal.text : "";
  return {
    ...state,
    externalTurnPending: false,
    typedInTerminal: typed ? undefined : state.typedInTerminal,
    nextLocalId: state.nextLocalId + 1,
    items: [...state.items, { type: "user", id, text: typed, attachments: [], external: true, at }],
  };
}

export function applyUpdate(state: SessionState, update: SessionUpdate, eventAt?: number): SessionState {
  // A replayed history has no times: what it shows already happened.
  const at = state.replaying ? undefined : eventAt;
  if (at !== undefined) state = { ...state, lastEventAt: at };
  state = startsTurn(state, update, at);
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendChunk(state, "user", update.content, update.messageId, at);
    case "agent_message_chunk":
      return appendChunk(delivered(state), "agent", update.content, update.messageId, at);
    case "agent_thought_chunk":
      return appendChunk(delivered(state), "thought", update.content, update.messageId, at);
    case "tool_call":
    case "tool_call_update": {
      state = delivered(state);
      const previous = state.toolCalls[update.toolCallId];
      const toolCalls = { ...state.toolCalls, [update.toolCallId]: mergeToolCall(previous, update, at) };
      const items = previous ? state.items : [...state.items, { type: "tool" as const, id: update.toolCallId, at }];
      const plan = planFromToolInput(update.rawInput) ?? state.plan;
      return { ...state, toolCalls, items, plan };
    }
    case "plan":
      return { ...state, plan: update.entries };
    case "available_commands_update":
      return { ...state, commands: update.availableCommands };
    case "current_mode_update":
      return state.modes ? { ...state, modes: { ...state.modes, currentModeId: update.currentModeId } } : state;
    case "config_option_update":
      return { ...state, configOptions: update.configOptions };
    case "usage_update":
      // Claude reports its cost with a turn's result only: the updates between keep it.
      return { ...state, usage: { used: update.used, size: update.size, cost: update.cost ?? state.usage?.cost } };
    case "session_info_update": {
      const reported = reportedActivity(update);
      // A turn starts that no prompt of ours began: the pane's TUI sent it. Its prompt may come
      // before this, after it, or not at all; the turn's first other event decides (startsTurn).
      if (reported === "working" && state.activity !== "working" && !state.prompting && !state.replaying && !state.liveSinceIdle) {
        state = { ...state, externalTurnPending: true };
      }
      if (reported === "idle") state = { ...state, externalTurnPending: false, liveSinceIdle: false };
      const activity = reported ?? state.activity;
      const title = "title" in update && typeof update.title === "string" ? update.title : state.title;
      return { ...state, title, activity: state.prompting ? "working" : activity };
    }
    default:
      return state;
  }
}

/** Our prompt has reached the agent once it answers: Kiro never echoes it back, so without this
 *  it stayed dimmed as unsent. It stays local, so an echo that comes later still confirms it. */
function delivered(state: SessionState): SessionState {
  if (!state.items.some((item) => item.type === "user" && item.local && !item.answered)) return state;
  return { ...state, items: state.items.map((item) => (item.type === "user" && item.local && !item.answered ? { ...item, answered: true } : item)) };
}

export function reduce(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "update":
      return applyUpdate(state, action.update, action.at);
    case "loading":
      return { ...emptySession(), replaying: true };
    case "loaded":
      return {
        ...state,
        replaying: false,
        modes: action.modes ?? state.modes,
        configOptions: action.configOptions ?? state.configOptions,
      };
    case "promptSent": {
      const id = `local-${state.nextLocalId}`;
      const { text, attachments } = sentMessage(action.blocks);
      return {
        ...state,
        items: [...state.items, { type: "user", id, text, attachments, unechoed: attachments.length, local: true, at: action.at }],
        nextLocalId: state.nextLocalId + 1,
        prompting: true,
        activity: "working",
      };
    }
    case "promptEnded":
      return { ...delivered(state), prompting: false, activity: "idle", permissions: [], liveSinceIdle: false };
    case "permissionRequested":
      return { ...state, permissions: [...state.permissions, action.request] };
    case "permissionAnswered":
      return { ...state, permissions: state.permissions.filter((request) => request.id !== action.id) };
    case "stopped": {
      const last = [...state.items].reverse().find((item) => item.type === "user");
      if (!last || state.stoppedTurns?.includes(last.id)) return state;
      return { ...state, stoppedTurns: [...(state.stoppedTurns ?? []), last.id] };
    }
    case "agentState":
      return state.agentState === action.state ? state : { ...state, agentState: action.state };
    case "typedInTerminal":
      return { ...state, typedInTerminal: { text: action.text, at: action.at } };
    case "reset":
      return emptySession();
  }
}

/** What the pane's app shows about the session: the agent needs you while it waits on a
 *  permission, works while in a turn, else is idle. */
export function attention(state: SessionState): "needs-you" | "working" | "idle" {
  if (state.permissions.length > 0) return "needs-you";
  if (state.activity === "working" || state.prompting) return "working";
  // A turn the pane's TUI runs, as the agent's hooks report it (approval and question wait there).
  return state.agentState && AGENT_BUSY.has(state.agentState) ? "working" : "idle";
}

const AGENT_BUSY = new Set(["working", "approval", "question", "compacting"]);
