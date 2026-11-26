// Whether the page is seen. WebKit hides a page whose web view is not in a shown window: a pane
// in a tab not selected, in a workspace not shown, a pane showing its terminal, the app hidden or
// its window behind a locked screen. A hidden page draws nothing, so it should also do nothing
// it only does to be drawn: re-render streamed text, tick clocks, poll for chips.
import { useEffect, useState } from "react";
import type { SessionAction, SessionState } from "./session-state";

export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Whether the page is seen, as state: true again when it is shown. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !pageHidden());
  useEffect(() => {
    if (typeof document === "undefined") return;
    const changed = () => setVisible(!pageHidden());
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}

/** Whether an action, coming while the page is hidden, can wait to be shown: what an agent
 *  streams in a live turn. A session's history as it loads, and everything else (a permission it
 *  asks, a prompt, the turn's end), goes through at once, with whatever waited before it. */
export function waitsWhileHidden(state: SessionState, action: SessionAction): boolean {
  return action.type === "update" && !state.replaying;
}

/** When an action reaches the view: `now`; at the next `frame`, with everything else that came in
 *  that frame (what an agent streams, a session's history as it loads: one render a frame instead
 *  of one a chunk); or once the page is `shown` (a live turn while nobody sees the page). A
 *  history loading while the page is hidden goes through at once: no frame comes while it is
 *  hidden, and the view's opening waits for it. Anything else (a prompt, a permission, the turn's
 *  end) goes through at once, after what waited before it. */
export function whenShown(state: SessionState, action: SessionAction, hidden: boolean): "now" | "frame" | "shown" {
  if (action.type !== "update") return "now";
  if (!hidden) return "frame";
  return waitsWhileHidden(state, action) ? "shown" : "now";
}
