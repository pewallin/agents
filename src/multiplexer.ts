/**
 * Multiplexer abstraction — shared interface for tmux and zellij backends.
 */

export interface MuxPaneInfo {
  id: string;           // "%5" (tmux) or "terminal_5" (zellij)
  title: string;
  command: string;      // foreground command (tmux) or initial command (zellij)
  pid: number | null;
  tab: string;          // window name (tmux) or tab name (zellij)
  session: string;
  focused: boolean;
  tty: string;
  geometry: { x: number; y: number; width: number; height: number };
}

export interface Multiplexer {
  readonly kind: "tmux" | "zellij";

  // Discovery
  listPanes(): MuxPaneInfo[];
  listPanesAsync(): Promise<MuxPaneInfo[]>;
  getPaneContent(paneId: string, lines?: number): string;

  // Pane operations
  createSplit(targetPaneId: string, direction: "right" | "down", size?: string): string | null;
  closePane(paneId: string): void;
  focusPane(paneId: string): void;
  resizePaneWidth(paneId: string, width: number): void;
  getPaneWidth(paneId: string): number;

  // Preview — move pane to dashboard tab, restore later
  breakPaneToTab(paneId: string, tabIndex: number): boolean;

  // Tab/window management
  createTab(name: string, cmd: string, opts?: { cwd?: string; session?: string }): string | null;
  closeTab(tabId: string): void;

  // Self
  ownPaneId(): string;
  ownTabIndex(): number;
  listSessions(): string[];

  // Placeholder
  showPlaceholder(paneId: string, agentName: string, agentPane: string): void;
}

/** Detect which multiplexer we're running inside. */
export function detectMultiplexer(): "tmux" | "zellij" | null {
  if (process.env.ZELLIJ_SESSION_NAME) return "zellij";
  if (process.env.TMUX) return "tmux";
  return null;
}
