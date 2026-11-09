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
  | { kind: "open"; sessionId: string };

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
 *  stays said: the connection's end that follows is no failure of its own. */
export function nextViewPhase(phase: ViewPhase, event: ViewEvent): ViewPhase {
  switch (event.type) {
    case "connect": return { kind: "connecting" };
    case "loaded": return phase.kind === "connecting" ? { kind: "open" } : phase;
    case "cannot-load": return { kind: "cannot-load", version: event.version };
    case "open-elsewhere": return { kind: "open-elsewhere" };
    case "taken-over": return phase.kind === "cannot-load" ? phase : { kind: "taken-over" };
    case "failed":
      return phase.kind === "taken-over" || phase.kind === "open-elsewhere" || phase.kind === "cannot-load"
        ? phase
        : { kind: "failed", failure: event.failure };
  }
}
