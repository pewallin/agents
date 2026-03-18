import { exec } from "./shell.js";
import {
  swapPanes,
  showPlaceholder,
  killPane,
  ownPaneId,
} from "./scanner.js";
import { GRID_MAX_AGENTS, GRID_MIN_SIZE, GRID_FOCUS_FILE } from "./constants.js";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { dirname } from "path";

/**
 * Grid view layout calculations and pane management.
 *
 * Layouts by agent count:
 *   1 → no-op (use regular preview)
 *   2 → 1×2 (side by side)
 *   3 → 1 top + 2 bottom
 *   4 → 2×2
 *   5 → 3 top + 2 bottom
 *   6 → 3×2 (3 cols, 2 rows)
 *   7 → 3 top + 4 bottom (or 4+3)
 *   8 → 4×2
 *   9 → 3×3
 *  10 → 4 top + 3 mid + 3 bottom  (or 4+3+3)
 *  11 → 4+4+3
 *  12 → 4×3
 */

export interface GridCell {
  /** Row index (0-based from top) */
  row: number;
  /** Column index (0-based from left) */
  col: number;
  /** Total columns in this row */
  rowCols: number;
}

export interface GridLayout {
  /** Number of rows */
  rows: number;
  /** Columns per row (e.g. [3, 2] = 3 top, 2 bottom) */
  colsPerRow: number[];
  /** Cell assignments in order (first cell = first agent, etc.) */
  cells: GridCell[];
}

/**
 * Compute grid layout for N agents (1–12).
 * Returns null for 0 agents only. 1 agent = single full pane.
 */
export function computeLayout(count: number): GridLayout | null {
  if (count <= 0) return null;
  if (count > GRID_MAX_AGENTS) count = GRID_MAX_AGENTS;

  const colsPerRow = layoutRows(count);
  const rows = colsPerRow.length;
  const cells: GridCell[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < colsPerRow[r]; c++) {
      cells.push({ row: r, col: c, rowCols: colsPerRow[r] });
    }
  }

  return { rows, colsPerRow, cells };
}

/**
 * Returns columns-per-row array for a given agent count.
 * Optimized for terminal readability (wider > taller).
 */
function layoutRows(n: number): number[] {
  switch (n) {
    case 1: return [1];             // single pane (like preview)
    case 2: return [2];             // side by side
    case 3: return [1, 2];          // 1 top + 2 bottom
    case 4: return [2, 2];          // 2×2
    case 5: return [2, 3];          // 2 top + 3 bottom
    case 6: return [3, 3];          // 3×2
    case 7: return [3, 4];          // 3 top + 4 bottom
    case 8: return [4, 4];          // 4×2
    case 9: return [3, 3, 3];       // 3×3
    case 10: return [4, 3, 3];      // 4+3+3
    case 11: return [4, 4, 3];      // 4+4+3
    case 12: return [4, 4, 4];      // 4×3
    default: return [n];            // shouldn't happen
  }
}

export interface PaneGeometry {
  /** X offset in characters from left */
  x: number;
  /** Y offset in characters from top */
  y: number;
  /** Width in characters */
  width: number;
  /** Height in characters */
  height: number;
}

/**
 * Compute pixel-level (character-level) geometry for each grid cell.
 * Takes total available width/height and returns positions for each cell.
 * Accounts for tmux pane borders (1 char between panes).
 */
export function computeGeometry(
  layout: GridLayout,
  totalWidth: number,
  totalHeight: number
): PaneGeometry[] {
  const { rows, colsPerRow, cells } = layout;

  // Vertical: split height among rows, accounting for borders between rows
  const vBorders = rows - 1;
  const usableHeight = totalHeight - vBorders;
  const rowHeights = distributeEvenly(usableHeight, rows);

  // Compute Y offsets for each row
  const rowY: number[] = [];
  let y = 0;
  for (let r = 0; r < rows; r++) {
    rowY.push(y);
    y += rowHeights[r] + 1; // +1 for border
  }

  const geometries: PaneGeometry[] = [];

  for (const cell of cells) {
    const cols = colsPerRow[cell.row];
    const hBorders = cols - 1;
    const usableWidth = totalWidth - hBorders;
    const colWidths = distributeEvenly(usableWidth, cols);

    // Compute X offset for this column
    let x = 0;
    for (let c = 0; c < cell.col; c++) {
      x += colWidths[c] + 1; // +1 for border
    }

    geometries.push({
      x,
      y: rowY[cell.row],
      width: colWidths[cell.col],
      height: rowHeights[cell.row],
    });
  }

  return geometries;
}

/**
 * Distribute `total` units evenly into `count` buckets.
 * Remainder is spread across the first buckets (each gets +1).
 */
export function distributeEvenly(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total % count;
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    result.push(base + (i < remainder ? 1 : 0));
  }
  return result;
}

// ── Grid pane management ────────────────────────────────────────────

export interface GridAgent {
  /** tmux pane ID (%N) of the agent */
  tmuxPaneId: string;
  /** Display label (e.g. "pi") */
  agent: string;
  /** Pane reference for display (e.g. "belgium:pi.0") */
  pane: string;
  /** Original window reference used for jump-to-agent */
  paneId?: string;
  /** Original window reference kept stable while swapped into grid */
  windowId?: string;
}

export interface GridState {
  /** Placeholder pane IDs created for the grid (to be killed on teardown) */
  placeholderIds: string[];
  /** Map from agent tmuxPaneId → placeholder pane it was swapped into */
  swappedAgents: Map<string, string>;
  /** Agents in the grid in order */
  agents: GridAgent[];
  /** The layout used */
  layout: GridLayout;
}

/**
 * Build the grid in tmux. The dashboard pane is embedded as cell[0] (top-left)
 * and agent panes are swapped into the remaining cells.
 *
 * Strategy: treat the dashboard pane as the first cell, split it to create
 * the rest of the grid, then swap agents into those placeholder cells.
 *
 * @param agents - Agents to show in the grid (1–11, capped by GRID_MAX_AGENTS-1)
 * @param dashboardPaneId - The dashboard's own pane ID (becomes cell[0])
 * @returns GridState for tracking, or null if no agents
 */
export function createGrid(
  agents: GridAgent[],
  dashboardPaneId: string,
): GridState | null {
  if (agents.length < 1) return null;

  // Layout includes the dashboard as cell 0
  const totalCells = Math.min(agents.length + 1, GRID_MAX_AGENTS);
  const layout = computeLayout(totalCells)!;
  const self = dashboardPaneId || ownPaneId();

  // Dashboard pane IS row 0's first cell. Split from it to build the grid.
  const rowPanes: string[] = [self];
  const placeholderIds: string[] = [];

  // Create additional rows by splitting the LAST row pane vertically.
  // Each split takes a fraction of the remaining space so all rows end up even.
  for (let r = 1; r < layout.rows; r++) {
    const remainingRows = layout.rows - r;
    const pct = Math.floor(100 * remainingRows / (remainingRows + 1));
    const newRow = exec(
      `tmux split-window -v -d -l ${pct}% -t ${rowPanes[r - 1]} -P -F '#{pane_id}' 'tail -f /dev/null'`
    );
    if (newRow) {
      rowPanes.push(newRow);
      placeholderIds.push(newRow);
    }
  }

  // Split each row into columns.
  // Key: always split the LAST created pane so each split subdivides the
  // remaining space evenly, rather than halving the first pane repeatedly.
  const cellPanes: string[] = [];
  for (let r = 0; r < layout.rows; r++) {
    const cols = layout.colsPerRow[r];
    let lastPane = rowPanes[r];
    cellPanes.push(lastPane); // first column is the row pane itself

    for (let c = 1; c < cols; c++) {
      const remainingCols = cols - c;
      const pct = Math.floor(100 * remainingCols / (remainingCols + 1));
      const newCol = exec(
        `tmux split-window -h -d -l ${pct}% -t ${lastPane} -P -F '#{pane_id}' 'tail -f /dev/null'`
      );
      if (newCol) {
        cellPanes.push(newCol);
        placeholderIds.push(newCol);
        lastPane = newCol;
      }
    }
  }

  // Cell 0 = dashboard (self); swap agents into cells 1..N
  const swappedAgents = new Map<string, string>();
  const agentSlots = cellPanes.length - 1; // available cells for agents
  const usedAgents = agents.slice(0, agentSlots);

  for (let i = 0; i < usedAgents.length; i++) {
    const agent = usedAgents[i];
    const placeholder = cellPanes[i + 1]; // +1 to skip dashboard cell
    if (!placeholder) break;
    swapPanes(agent.tmuxPaneId, placeholder);
    swappedAgents.set(agent.tmuxPaneId, placeholder);
    // Show placeholder message in the agent's original location
    showPlaceholder(placeholder, agent.agent, agent.pane);
  }

  installFocusHook();

  return {
    placeholderIds,
    swappedAgents,
    agents: usedAgents,
    layout,
  };
}

/**
 * Tear down the grid: swap all agents back to their original positions,
 * then kill all placeholder panes.
 */
export function destroyGrid(state: GridState): void {
  removeFocusHook();

  // Swap agents back — each agent is currently in a grid cell,
  // and its placeholder is sitting in the agent's original window.
  for (const [agentPaneId, placeholderId] of state.swappedAgents) {
    swapPanes(agentPaneId, placeholderId);
  }

  // Kill all placeholder panes (they're now in the grid area)
  for (const id of state.placeholderIds) {
    killPane(id);
  }
}

/**
 * Add an agent to an existing grid. Re-layouts if needed.
 * Returns updated GridState or null if grid needs full rebuild.
 */
export function addToGrid(
  state: GridState,
  agent: GridAgent,
  dashboardPaneId: string,
): GridState | null {
  // Easiest approach: destroy and recreate with the new agent included
  const newAgents = [...state.agents, agent];
  destroyGrid(state);
  return createGrid(newAgents, dashboardPaneId);
}

/**
 * Remove an agent from the grid. Re-layouts remaining agents.
 * Returns updated GridState, or null if no agents remain (grid should close).
 */
export function removeFromGrid(
  state: GridState,
  agentPaneId: string,
  dashboardPaneId: string,
): GridState | null {
  const remaining = state.agents.filter((a) => a.tmuxPaneId !== agentPaneId);
  destroyGrid(state);
  if (remaining.length < 1) return null;
  return createGrid(remaining, dashboardPaneId);
}

// ── Grid focus tracking ─────────────────────────────────────────────
// A tmux pane-focus-in hook writes the focused pane ID to a state file.
// The dashboard watches this file and syncs its selected agent index.

const HOOK_INDEX = 99;

/** Install a tmux hook that writes the focused pane ID to the grid-focus file. */
export function installFocusHook(): void {
  mkdirSync(dirname(GRID_FOCUS_FILE), { recursive: true });
  // Create the file so fs.watch can attach immediately
  writeFileSync(GRID_FOCUS_FILE, "");
  // after-select-pane fires when any pane gets focus (click or keyboard).
  // tmux expands #{pane_id} when the hook fires, giving us the pane ID (e.g. %42).
  exec(
    `tmux set-hook -g "after-select-pane[${HOOK_INDEX}]" "run-shell 'printf %s #{pane_id} > ${GRID_FOCUS_FILE}'"`,
  );
}

/** Remove the focus tracking hook and clean up the state file. */
export function removeFocusHook(): void {
  exec(`tmux set-hook -gu "after-select-pane[${HOOK_INDEX}]"`);
  try { unlinkSync(GRID_FOCUS_FILE); } catch {}
}

/** Read the currently focused pane ID from the state file. */
export function readGridFocus(): string | null {
  try {
    const content = readFileSync(GRID_FOCUS_FILE, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
