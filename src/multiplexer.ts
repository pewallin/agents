/**
 * Multiplexer abstraction — shared interface for tmux and zellij backends.
 */

export interface MuxPaneInfo {
  id: string;           // "%5" (tmux) or "terminal_5" (zellij)
  title: string;
  command: string;      // foreground command (tmux) or initial command (zellij)
  pid: number | null;
  tab: string;          // window name (tmux) or tab name (zellij)
  tabIndex: number;     // window index (tmux) or tab position (zellij)
  tabId?: number;       // zellij stable tab ID (survives tab reordering)
  session: string;
  focused: boolean;
  tty: string;
  cwd?: string;
  geometry: { x: number; y: number; width: number; height: number };
}

export interface Multiplexer {
  readonly kind: "tmux" | "zellij";

  // Discovery
  listPanes(): MuxPaneInfo[];
  listPanesAsync(): Promise<MuxPaneInfo[]>;

  // Pane operations
  createSplit(targetPaneId: string, direction: "right" | "down", size?: string): string | null;
  closePane(paneId: string): void;
  focusPane(paneId: string): void;
  resizePaneWidth(paneId: string, width: number): void;
  getPaneWidth(paneId: string): number;

  // Preview — move pane(s) between tabs
  breakPaneToTab(paneId: string, tabIndex: number): boolean;
  breakPanesToNewTab(paneIds: string[], name?: string): boolean;

  // Tab/window management
  createTab(name: string, cmd: string, opts?: { cwd?: string; session?: string }): string | null;
  closeTab(tabId: string): void;

  // Self
  ownPaneId(): string;
  ownTabIndex(): number;
  listSessions(): string[];

  // Placeholder
  showPlaceholder(paneId: string, agentName: string, agentPane: string): void;

  // Floating panes (zellij: float/embed/position; tmux: no-op)
  floatPane(paneId: string, coords?: { x: number; y: number; width: string; height: string }): void;
  embedPane(paneId: string): void;
  isFloating(paneId: string): boolean;

  // Send keystrokes to a pane
  sendKeys(paneId: string, keys: string): void;
}

/** Detect which multiplexer we're running inside.
 *  Prefers zellij if available, falls back to tmux. */
export function detectMultiplexer(): "tmux" | "zellij" | null {
  if (process.env.ZELLIJ_SESSION_NAME) return "zellij";
  if (process.env.TMUX) return "tmux";
  return null;
}

let _mux: Multiplexer | null = null;
let _forceKind: "tmux" | "zellij" | null = null;

/** Force a specific multiplexer backend (e.g. via --tmux flag). */
export function setMultiplexer(kind: "tmux" | "zellij"): void {
  _forceKind = kind;
  _mux = null; // reset singleton
}

/** Get the singleton multiplexer instance, auto-detecting the backend. */
export async function initMux(): Promise<Multiplexer> {
  if (_mux) return _mux;
  const kind = _forceKind || detectMultiplexer();
  if (kind === "zellij") {
    const { ZellijMux } = await import("./mux-zellij.js");
    _mux = new ZellijMux();
  } else {
    const { TmuxMux } = await import("./mux-tmux.js");
    _mux = new TmuxMux();
  }
  return _mux;
}

/** Get the multiplexer instance (must call initMux() first). */
export function getMux(): Multiplexer {
  if (!_mux) {
    // Sync fallback — import tmux directly (always available)
    const { TmuxMux } = require("./mux-tmux.js") as typeof import("./mux-tmux.js");
    _mux = new TmuxMux();
  }
  return _mux;
}
