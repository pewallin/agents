// The pane's earlier conversations with its agent, for /resume (and /chat): the host lists them
// (GET /api/history, what `agents history --pane` says, the same list as Agents Next's
// Conversations), the view filters them as you type, and Agents Next opens the one picked in the
// pane, which stays in the view.

/** Where a conversation is open other than in this pane (the CLI's session-holders.ts). */
export interface OpenIn {
  pane?: string;
  session?: string;
  window?: string;
  pid?: number;
}

export interface PaneConversation {
  sessionId: string;
  title: string;
  /** Seconds since 1970. */
  updatedAt: number;
  current?: boolean;
  resumeTarget?: string;
  resumeTargetKind?: string;
  openIn?: OpenIn;
}

export interface PaneHistory {
  agent: string;
  currentSessionId: string | null;
  hasMore: boolean;
  sessions: PaneConversation[];
}

/** Newest first, the conversations whose title (or id) has every word of `query`, any case. */
export function filterConversations(conversations: PaneConversation[], query: string): PaneConversation[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return conversations
    .filter((conversation) => {
      const text = `${conversation.title} ${conversation.sessionId}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 d ago", else the date. */
export function relativeTime(seconds: number, now: number = Date.now()): string {
  if (!seconds) return "";
  const elapsed = Math.max(0, Math.round(now / 1000 - seconds));
  if (elapsed < 60) return "just now";
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(days > 300 ? { year: "numeric" } : {}) });
}

/** Where another pane has the conversation: its window's name and the pane. */
export function openInLabel(openIn: OpenIn): string {
  const window = openIn.window?.trim();
  if (openIn.pane) return window ? `open in ${window} (${openIn.pane})` : `open in ${openIn.pane}`;
  return "open in another app";
}

/** What picking a conversation does: nothing for the open one, show the pane that has it, or
 *  open it here. */
export type ConversationPick =
  | { kind: "current" }
  | { kind: "show"; pane: string }
  | { kind: "elsewhere"; label: string }
  | { kind: "open"; conversation: PaneConversation };

export function pickConversation(conversation: PaneConversation): ConversationPick {
  if (conversation.current) return { kind: "current" };
  if (conversation.openIn?.pane) return { kind: "show", pane: conversation.openIn.pane };
  if (conversation.openIn) return { kind: "elsewhere", label: openInLabel(conversation.openIn) };
  return { kind: "open", conversation };
}
