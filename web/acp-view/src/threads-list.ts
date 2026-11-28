// A project's Threads tab (Projects and Threads, P3 and C3): one row per thread, the same row as
// Needs you and ⌘K give it. The app hands the rows to the page whenever they change
// (`__agentsNextApplyThreads`, from its thread listing and its panes); a page the app does not
// feed (another browser, an older app) reads the host's listing once.
import { create } from "zustand";
import { PAGE_ENTRIES, definePageEntry } from "./bridge";

/** working, waits (for you), idle, or resolved (folded at the foot). */
export type RowMark = "working" | "waits" | "idle" | "resolved";

export interface ThreadRow {
  task: string;
  title: string;
  mark: RowMark;
  /** The open question while it waits on you; else what its agent last said; else its brief's first line. */
  line?: string;
  /** What its age counts from (ISO). */
  at?: string;
  pane?: string;
  /** Where its tab is: "here" in this workspace, else that workspace's name. */
  place?: string;
}

export interface ThreadsList {
  program: string;
  name: string;
  threads: ThreadRow[];
}

export const useThreadsList = create<{ list: ThreadsList | null; fromApp: boolean }>(() => ({ list: null, fromApp: false }));

if (typeof window !== "undefined") {
  definePageEntry(PAGE_ENTRIES.applyThreads, (value: ThreadsList) => {
    useThreadsList.setState({ list: { ...value, threads: value.threads ?? [] }, fromApp: true });
  });
}

/** The host's listing (GET /api/threads) in the rows' words, for a page the app does not feed. */
export function rowsFromListing(listing: { name: string; program?: string; threads: Array<{ task: string; title: string; state: string; updatedAt?: string | null; resolvedAt?: string | null; line?: string | null; pane?: string | null }> }, program: string): ThreadsList {
  const mark = (state: string): RowMark => state === "working" ? "working" : state === "needs-you" ? "waits" : state === "resolved" ? "resolved" : "idle";
  return {
    program,
    name: listing.name,
    threads: listing.threads.map((thread) => ({
      task: thread.task,
      title: thread.title || thread.task,
      mark: mark(thread.state),
      ...(thread.line ? { line: thread.line } : {}),
      ...((thread.state === "resolved" ? thread.resolvedAt : thread.updatedAt) ? { at: (thread.state === "resolved" ? thread.resolvedAt : thread.updatedAt) as string } : {}),
      ...(thread.pane && thread.state !== "resolved" ? { pane: thread.pane } : {}),
    })),
  };
}

/** The open rows in the order the app gives them (the order they started, so a row never
 *  moves), and the resolved ones apart. */
export function splitRows(threads: ThreadRow[]): { open: ThreadRow[]; resolved: ThreadRow[] } {
  return { open: threads.filter((row) => row.mark !== "resolved"), resolved: threads.filter((row) => row.mark === "resolved") };
}

/** How long ago, as the app's rows say it: "now", "5m", "3h", "2d". */
export function shortAge(at: string | null | undefined, now = Date.now()): string {
  const ms = at ? now - Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
