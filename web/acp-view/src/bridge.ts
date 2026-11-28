// The ACP view and Agents Next talk through these channels and no others. Agents Next has the
// same names in ACPViewBridge (AgentsNext/UI/ACPViewBridge.swift); a page tells the app which
// version it speaks (data-acp-bridge on <html>), so a view and an app of different releases are
// noticed in the pane's log instead of failing quietly. Bump BRIDGE_VERSION when a channel or its
// message changes.
export const BRIDGE_VERSION = 8;

/** The app's message handlers (window.webkit.messageHandlers.<name>.postMessage). */
export const APP_HANDLERS = {
  link: "agentsNextACPLink",
  resolve: "agentsNextACPResolve",
  quickLook: "agentsNextACPQuickLook",
  conversation: "agentsNextConversation",
  dictation: "agentsNextDictation",
  menu: "agentsNextACPMenu",
  /** The title of a ticket the view links, read by the app with the user's logins (a reply). */
  ticketTitle: "agentsNextACPTicketTitle",
  /** A thread's own page closes its thread or keeps it open (its coordinator proposed closing it),
   *  and the Threads list goes to a thread's tab (`go-to-pane`, with the row's task and program). */
  threadAction: "agentsNextThreadAction",
  /** The thread a coordinator's pane has open beside it (a reply: { task, title } or {}), named
   *  with what the user writes to the coordinator. */
  beside: "agentsNextBeside",
} as const;
export type AppHandler = (typeof APP_HANDLERS)[keyof typeof APP_HANDLERS];

/** What the app calls in the page (window.<name>(…)). */
export const PAGE_ENTRIES = {
  applyLook: "__agentsNextApplyLook",
  applyCoordination: "__agentsNextApplyCoordination",
  /** A project's Threads page: its rows (threads-list.ts). */
  applyThreads: "__agentsNextApplyThreads",
  openBeside: "__agentsNextOpenBeside",
  conversationFailed: "__agentsNextConversationFailed",
} as const;

/** Events the app dispatches on the page's window. */
export const PAGE_EVENTS = {
  quote: "agents-next-quote",
  dictation: "agents-next-dictation",
  reviewConversation: "agents-next-review-conversation",
  /** The app is about to take a picture of the window (app control's window.snapshot): a page it
   *  does not show draws what it holds back (visibility.ts), so the picture is current. */
  snapshot: "agents-next-snapshot",
} as const;

/** Actions the page asks of the app by navigating to agents-next-action://<action>. */
export const APP_ACTIONS = {
  backToTerminal: "agents-next-action://back-to-terminal",
  /** The pane's terminal asks something: the app shows it, and comes back once it is answered. */
  terminalQuestion: "agents-next-action://back-to-terminal?question=1",
  /** Answer in terminal, the user's click on a question a thread's terminal asks (P5): the app shows
   *  the terminal, and the thread page again once it is answered. */
  answerInTerminal: "agents-next-action://back-to-terminal?question=1&answer=1",
  restartViewHost: "agents-next-action://restart-view-host",
  /** The pane's agent starts again on its session, under the CLI's current host. */
  restartInACPMode: "agents-next-action://restart-acp",
  copyDiagnostics: "agents-next-action://copy-acp-diagnostics",
} as const;

/** The app's scheme for thumbnails of files it draws. */
export const THUMBNAIL_SCHEME = "agents-next-thumbnail";

/** A handler of the app, when the page runs in it. */
export function appHandler(name: AppHandler): { postMessage: (body: unknown) => unknown } | undefined {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: Record<string, { postMessage: (body: unknown) => unknown } | undefined> } }).webkit?.messageHandlers;
  return handlers?.[name];
}

/** Defines what the app calls in the page. */
export function definePageEntry<T>(name: (typeof PAGE_ENTRIES)[keyof typeof PAGE_ENTRIES], entry: T): void {
  (window as unknown as Record<string, unknown>)[name] = entry;
}

/** Says which bridge version this page speaks. */
export function announceBridge(): void {
  if (typeof document !== "undefined") document.documentElement.dataset.acpBridge = String(BRIDGE_VERSION);
}
