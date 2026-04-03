/** Minimum sidebar width in columns when collapsed. */
export const SIDEBAR_MIN_WIDTH = 5;

/** Debounce delay (ms) for preview/grid switching on j/k navigation. */
export const NAV_DEBOUNCE_MS = 400;

/** Dashboard width as a fraction of terminal width (for vertical preview/grid). */
export const DASHBOARD_WIDTH_RATIO = 0.28;

/** Min dashboard columns in vertical layout. */
export const DASHBOARD_MIN_COLS = 48;

/** Max dashboard columns in vertical layout. */
export const DASHBOARD_MAX_COLS = 65;

/** Compute dashboard column width for vertical preview/grid splits. */
export function calcDashboardCols(termCols: number): number {
  return Math.max(DASHBOARD_MIN_COLS, Math.min(DASHBOARD_MAX_COLS, Math.floor(termCols * DASHBOARD_WIDTH_RATIO)));
}

/** Max agents in a grid. */
export const GRID_MAX_AGENTS = 12;

/** Min rows/cols for a grid split pane. */
export const GRID_MIN_SIZE = 20;

/** State file max age in seconds before cleanup. */
export const STATE_MAX_AGE = 300;

/** Recheck Codex panes when a working hook state has gone stale. */
export const STALE_HOOK_WORKING_RECHECK_SEC = 300;

/** File where the tmux focus hook writes the currently focused pane ID. */
import { getGridFocusFile } from "./paths.js";
export const GRID_FOCUS_FILE = getGridFocusFile();

/** Agent name → display color. Single source of truth for Dashboard + AgentTable. */
export const AGENT_COLORS: Record<string, string> = {
  claude: "#d08770", copilot: "#81a1c1", opencode: "#4c566a", pi: "#b48ead",
};
export function agentColor(name: string): string { return AGENT_COLORS[name] || "#88c0d0"; }
