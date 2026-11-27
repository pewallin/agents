// A project's thread lives in its own pane (Projects and Threads, R1): the app shows that pane's
// view as the thread's page (?presentation=thread) and has a question its terminal asks shown in
// the page with Answer in terminal (?questions=inline, P5) instead of switching to the terminal.
// Show Session drops presentation=thread, and the same view is then the session as any pane has it.
import { create } from "zustand";

export interface PageOptions {
  /** The thread page: its top line, its brief folded, one work line per turn, no Steps (P9). */
  threadPresentation: boolean;
  /** A question the pane's terminal asks shows in the page, answered with Answer in terminal. */
  inlineQuestions: boolean;
}

export function pageOptions(search: string): PageOptions {
  const params = new URLSearchParams(search);
  return {
    threadPresentation: params.get("presentation") === "thread",
    inlineQuestions: params.get("questions") === "inline",
  };
}

export const PAGE_OPTIONS: PageOptions = typeof location === "undefined"
  ? { threadPresentation: false, inlineQuestions: false }
  : pageOptions(location.search);

/**
 * A turn's work as one line (C1, P9): "Working 2m · writing the TEST stage" while the agent works,
 * the gist being its plan's current item or else what its current tool call does; "Worked 2m" once
 * the turn is over. A turn that took under a second says only "Worked"; one replayed without times
 * says nothing.
 */
export function workLine(turn: { startedAt?: number; endedAt?: number }, working: boolean, now: number, gist?: string): string | null {
  if (working) {
    const took = turn.startedAt !== undefined ? ` ${roundDuration(now - turn.startedAt)}` : "";
    const what = gist?.trim();
    return `Working${took}${what ? ` · ${what}` : ""}`;
  }
  if (turn.startedAt === undefined || turn.endedAt === undefined) return null;
  const ms = turn.endedAt - turn.startedAt;
  return ms >= 1000 ? `Worked ${roundDuration(ms)}` : "Worked";
}

/** A turn's length as the work line says it: seconds under a minute, else whole minutes, else hours
 *  and minutes ("45s", "2m", "1h 5m"). */
export function roundDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** What the thread's own page shows of it, from its host (GET /api/thread). */
export interface OwnThread {
  task: string;
  program: string;
  title?: string;
  brief?: string;
  proposedClose?: { why: string; at?: string; as?: string };
}

export const useOwnThread = create<{ thread: OwnThread | null; settled: string | null }>(() => ({ thread: null, settled: null }));

/** The proposed close the page shows: none once the user settled that one here. */
export function shownProposal(thread: OwnThread | null, settled: string | null): OwnThread["proposedClose"] | null {
  const proposed = thread?.proposedClose;
  if (!proposed) return null;
  return settled !== null && settled === proposalKey(proposed) ? null : proposed;
}

export function proposalKey(proposed: { why: string; at?: string }): string {
  return `${proposed.at ?? ""}|${proposed.why}`;
}

/** How often the page reads its thread again while it is seen. */
export const OWN_THREAD_POLL_MS = 5_000;

/** Follows the thread the pane is, while the page is seen, through `read` (the host's /api/thread). */
export function followOwnThread(read: () => Promise<{ thread: OwnThread | null }>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      const answer = await read().catch(() => null);
      if (stopped) return;
      if (answer) useOwnThread.setState({ thread: answer.thread });
    }
    timer = setTimeout(() => void tick(), OWN_THREAD_POLL_MS);
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
