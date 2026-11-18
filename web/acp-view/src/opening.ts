// How the view opens a session, as two explicit states: which session the pane's host has for it
// (GatePhase), and how the connection to that session stands (ViewPhase). The components only
// draw the phase they are in.

/** What the host said of the pane's session (GET /api/session). */
export interface HostSession {
  sessionId: string | null;
  /** False while a Codex thread has no turn written yet. */
  persisted?: boolean;
  /** A turn runs, which codex-acp does not follow when it loads the thread. */
  busy?: boolean;
}

export type GatePhase =
  /** Asking the host which session the pane has ("current"). */
  | { kind: "finding" }
  /** The TUI had none: the view starts one. */
  | { kind: "starts-new" }
  | { kind: "no-session"; problem?: string }
  /** A turn runs: the view loads the session when it ends. */
  | { kind: "waiting-for-idle"; sessionId: string }
  /** Nothing written yet: the first prompt starts the session through the host. */
  | { kind: "first-prompt"; sessionId: string }
  | { kind: "open"; sessionId: string }
  /** The host stopped answering while the view waited for the session (it ended with its agent,
   *  or was stopped): the view says so and can ask again. */
  | { kind: "host-silent"; problem: string };

/** The gate of a view opened on `sessionId` ("current": the one the pane has now; none: an
 *  address that names no session). */
export function initialGate(sessionId: string | null): GatePhase {
  if (sessionId === null) return { kind: "no-session" };
  return sessionId === "current" ? { kind: "finding" } : { kind: "open", sessionId };
}

/** The gate once the host said which session the pane has. */
export function gateFromHost(answer: HostSession): GatePhase {
  if (answer.sessionId === null) return { kind: "starts-new" };
  if (answer.persisted === false) return { kind: "first-prompt", sessionId: answer.sessionId };
  if (answer.busy === true) return { kind: "waiting-for-idle", sessionId: answer.sessionId };
  return { kind: "open", sessionId: answer.sessionId };
}

/** How long the view goes on asking a host that does not answer at all before it says so. */
export const HOST_SILENT_AFTER_MS = 5_000;
/** How many error answers in a row (other than 404) the view takes before it gives up. */
export const HOST_ERRORS_BEFORE_GIVING_UP = 300;

/**
 * Whether the view asks the host for the pane's session again after an ask failed. A 404 says the
 * agent has no session yet (it may be held up by a question in its terminal for as long as anyone
 * takes to answer it): the view waits on. A host that answers with errors gets many tries. A host
 * that does not answer at all has ended (with its agent, or stopped): the view says so after a few
 * seconds, instead of its opening frame for half a minute and then a line with no way on.
 */
export class SessionWait {
  private silentSince: number | null = null;
  private errors = 0;

  /** `status`: the HTTP status the host answered with; null when it did not answer. */
  failed(status: number | null, now: number): "ask-again" | "host-silent" | "host-failing" {
    if (status === null) {
      this.silentSince ??= now;
      return now - this.silentSince >= HOST_SILENT_AFTER_MS ? "host-silent" : "ask-again";
    }
    this.silentSince = null;
    if (status === 404) {
      this.errors = 0;
      return "ask-again";
    }
    this.errors += 1;
    return this.errors >= HOST_ERRORS_BEFORE_GIVING_UP ? "host-failing" : "ask-again";
  }
}

/** How long the session's history stands still, while the agent still opens the session, before
 *  the view shows it: a replay comes in one burst (Claude's ~700 updates within 30 ms). */
export const HISTORY_SETTLED_MS = 200;

/** Whether some of the session's history has come in as its load replays it. */
export function historyArriving(state: { replaying: boolean; items: readonly unknown[]; toolCalls: Record<string, unknown> }): boolean {
  return state.replaying && (state.items.length > 0 || Object.keys(state.toolCalls).length > 0);
}

export interface FailureDetail {
  title: string;
  detail: { message: string; data?: string };
}

export type ViewPhase =
  | { kind: "connecting" }
  | { kind: "open" }
  /** The agent cannot load an existing session (ACP session/load). */
  | { kind: "cannot-load"; version?: string }
  | { kind: "taken-over" }
  | { kind: "open-elsewhere" }
  | { kind: "failed"; failure: FailureDetail };

export type ViewEvent =
  | { type: "connect" }
  | { type: "loaded" }
  | { type: "cannot-load"; version?: string }
  | { type: "open-elsewhere" }
  | { type: "taken-over" }
  | { type: "failed"; failure: FailureDetail };

/** The view's phase after `event`. A session another view took, or one this agent cannot load,
 *  stays said: the connection's end that follows is no failure of its own. So does the first
 *  failure: a session that did not open is why its connection then closed. */
export function nextViewPhase(phase: ViewPhase, event: ViewEvent): ViewPhase {
  switch (event.type) {
    case "connect": return { kind: "connecting" };
    case "loaded": return phase.kind === "connecting" ? { kind: "open" } : phase;
    case "cannot-load": return { kind: "cannot-load", version: event.version };
    case "open-elsewhere": return { kind: "open-elsewhere" };
    case "taken-over": return phase.kind === "cannot-load" ? phase : { kind: "taken-over" };
    case "failed":
      return phase.kind === "taken-over" || phase.kind === "open-elsewhere" || phase.kind === "cannot-load" || phase.kind === "failed"
        ? phase
        : { kind: "failed", failure: event.failure };
  }
}
