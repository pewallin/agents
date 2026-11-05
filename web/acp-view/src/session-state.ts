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
  | { type: "user"; id: string; text: string; images: number; local?: boolean; at?: number }
  | { type: "agent"; id: string; text: string; at?: number }
  | { type: "thought"; id: string; text: string; at?: number }
  | { type: "tool"; id: string; at?: number };

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
  | { type: "promptSent"; text: string; images?: number; at?: number }
  | { type: "promptEnded" }
  | { type: "permissionRequested"; request: PermissionRequest }
  | { type: "permissionAnswered"; id: string }
  | { type: "reset" };

function textOf(block: ContentBlock): string {
  return block.type === "text" ? block.text : "";
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
  const text = textOf(block);
  const image = block.type === "image" ? 1 : 0;
  if (!text && !image) return state;
  const items = state.items;
  const last = items.at(-1);

  if (kind === "user") {
    // Our own prompt, shown at once: the agent may echo it back (other clients' prompts it always
    // reports); the echo confirms it rather than adding it again.
    const pending = [...items].reverse().find((item) => item.type === "user" && item.local);
    if (pending && pending.type === "user" && pending.text.startsWith(text)) {
      return {
        ...state,
        items: items.map((item) => (item === pending ? { ...pending, local: false, id: messageId ?? pending.id } : item)),
      };
    }
  }

  if (last && last.type === kind && (!messageId || last.id === messageId)) {
    const merged = last.type === "user"
      ? { ...last, text: last.text + text, images: last.images + image }
      : { ...last, text: last.text + text };
    return { ...state, items: [...items.slice(0, -1), merged] };
  }
  const id = messageId ?? `${kind}-${state.nextLocalId}`;
  const item: Item = kind === "user"
    ? { type: "user", id, text, images: image, at }
    : { type: kind, id, text, at };
  return { ...state, items: [...items, item], nextLocalId: state.nextLocalId + 1 };
}

function mergeToolCall(previous: ToolCall | undefined, update: ToolCallUpdate & { title?: string | null }, at: number | undefined): ToolCall {
  const status = (update.status ?? previous?.status ?? "pending") as ToolStatus;
  const ended = status === "completed" || status === "failed";
  return {
    id: update.toolCallId,
    title: update.title ?? previous?.title ?? "Tool call",
    kind: update.kind ?? previous?.kind,
    status,
    content: update.content ?? previous?.content ?? [],
    locations: update.locations ?? previous?.locations ?? [],
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

export function applyUpdate(state: SessionState, update: SessionUpdate, eventAt?: number): SessionState {
  // A replayed history has no times: what it shows already happened.
  const at = state.replaying ? undefined : eventAt;
  if (at !== undefined) state = { ...state, lastEventAt: at };
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return appendChunk(state, "user", update.content, update.messageId, at);
    case "agent_message_chunk":
      return appendChunk(state, "agent", update.content, update.messageId, at);
    case "agent_thought_chunk":
      return appendChunk(state, "thought", update.content, update.messageId, at);
    case "tool_call":
    case "tool_call_update": {
      const previous = state.toolCalls[update.toolCallId];
      const toolCalls = { ...state.toolCalls, [update.toolCallId]: mergeToolCall(previous, update, at) };
      const items = previous ? state.items : [...state.items, { type: "tool" as const, id: update.toolCallId, at }];
      return { ...state, toolCalls, items };
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
      return { ...state, usage: { used: update.used, size: update.size, cost: update.cost } };
    case "session_info_update": {
      const activity = reportedActivity(update) ?? state.activity;
      const title = "title" in update && typeof update.title === "string" ? update.title : state.title;
      return { ...state, title, activity: state.prompting ? "working" : activity };
    }
    default:
      return state;
  }
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
      return {
        ...state,
        items: [...state.items, { type: "user", id, text: action.text, images: action.images ?? 0, local: true, at: action.at }],
        nextLocalId: state.nextLocalId + 1,
        prompting: true,
        activity: "working",
      };
    }
    case "promptEnded":
      return { ...state, prompting: false, activity: "idle", permissions: [] };
    case "permissionRequested":
      return { ...state, permissions: [...state.permissions, action.request] };
    case "permissionAnswered":
      return { ...state, permissions: state.permissions.filter((request) => request.id !== action.id) };
    case "reset":
      return emptySession();
  }
}

/** What the pane's app shows about the session: the agent needs you while it waits on a
 *  permission, works while in a turn, else is idle. */
export function attention(state: SessionState): "needs-you" | "working" | "idle" {
  if (state.permissions.length > 0) return "needs-you";
  return state.activity === "working" || state.prompting ? "working" : "idle";
}
