// The fold of a pane's top line and prompt (Thread links, L11): one control at the end of the
// line folds both, the line to its link and the prompt to a one-line field with its send button.
// Kept per pane (the page's host is the pane's: its storage is the pane's) or per thread beside
// you; a pane that starts small, as in a grid, starts folded. Nothing folds on hover or focus.
import { create } from "zustand";

/** A pane narrower or lower than this starts folded, until its fold is chosen. */
export const SMALL_PANE = { width: 460, height: 380 };

export function startsFolded(width: number, height: number): boolean {
  return (width > 0 && width < SMALL_PANE.width) || (height > 0 && height < SMALL_PANE.height);
}

function storedFold(key: string): boolean | null {
  try {
    const value = localStorage.getItem(key);
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

export interface PageFold { folded: boolean; toggle: () => void }

/** The fold of the page whose storage key is `key`. */
export function makeFold(key: string) {
  return create<PageFold>((set, get) => ({
    folded: storedFold(key) ?? (typeof window !== "undefined" && startsFolded(window.innerWidth, window.innerHeight)),
    toggle: () => {
      const folded = !get().folded;
      try { localStorage.setItem(key, folded ? "1" : "0"); } catch { /* no storage */ }
      set({ folded });
    },
  }));
}
