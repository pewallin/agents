import { execSync } from "child_process";
import {
  swapPanes,
  showPlaceholder,
  killPane,
  ownPaneId,
} from "./scanner.js";

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

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
  if (count > 12) count = 12; // cap

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
    case 5: return [3, 2];          // 3 top + 2 bottom
    case 6: return [3, 3];          // 3×2
    case 7: return [4, 3];          // 4 top + 3 bottom
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
 * Build the grid in tmux by creating placeholder panes and swapping agents in.
 *
 * Strategy: create a single placeholder via split, then subdivide it into
 * the grid layout using tmux splits. Finally swap each agent pane into
 * a grid cell.
 *
 * @param agents - Agents to show in the grid (2–12)
 * @param dashboardPaneId - The dashboard's own pane ID (used as split target)
 * @param vertical - If true, grid goes to the right of dashboard; otherwise below
 * @param dashboardSize - Cols (vertical) or rows (horizontal) reserved for dashboard
 * @returns GridState for tracking, or null if < 2 agents
 */
export function createGrid(
  agents: GridAgent[],
  dashboardPaneId: string,
  vertical: boolean,
  dashboardSize: number
): GridState | null {
  const count = Math.min(agents.length, 12);
  if (count < 1) return null;

  const layout = computeLayout(count)!;
  const self = dashboardPaneId || ownPaneId();

  // Create the first grid pane as a split of the dashboard
  const splitDir = vertical ? "-h" : "-v";
  const curSize = parseInt(
    exec(`tmux display-message -t ${self} -p '${vertical ? "#{pane_width}" : "#{pane_height}"}'`) || "80",
    10
  );
  const gridSize = Math.max(20, curSize - dashboardSize - 1);
  const sizeFlag = `-l ${gridSize}`;

  const firstPane = exec(
    `tmux split-window ${splitDir} -d ${sizeFlag} -t ${self} -P -F '#{pane_id}' 'tail -f /dev/null'`
  );
  if (!firstPane) return null;

  const placeholderIds: string[] = [firstPane];

  // Now subdivide the first pane into the grid.
  // Strategy: split into rows first, then split each row into columns.
  const rowPanes: string[] = [firstPane];

  // Create additional rows by splitting the first pane vertically
  for (let r = 1; r < layout.rows; r++) {
    // Split the last row pane to create a new row below
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

  // Split each row into columns
  const cellPanes: string[] = [];
  for (let r = 0; r < layout.rows; r++) {
    const cols = layout.colsPerRow[r];
    cellPanes.push(rowPanes[r]); // first column is the row pane itself

    for (let c = 1; c < cols; c++) {
      const remainingCols = cols - c;
      const pct = Math.floor(100 * remainingCols / (remainingCols + 1));
      const newCol = exec(
        `tmux split-window -h -d -l ${pct}% -t ${rowPanes[r]} -P -F '#{pane_id}' 'tail -f /dev/null'`
      );
      if (newCol) {
        cellPanes.push(newCol);
        placeholderIds.push(newCol);
      }
    }
  }

  // Swap agent panes into grid cells
  const swappedAgents = new Map<string, string>();
  const usedAgents = agents.slice(0, cellPanes.length);

  for (let i = 0; i < usedAgents.length && i < cellPanes.length; i++) {
    const agent = usedAgents[i];
    const placeholder = cellPanes[i];
    swapPanes(agent.tmuxPaneId, placeholder);
    swappedAgents.set(agent.tmuxPaneId, placeholder);
    // Show placeholder message in the agent's original location
    showPlaceholder(placeholder, agent.agent, agent.pane);
  }

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
  vertical: boolean,
  dashboardSize: number
): GridState | null {
  // Easiest approach: destroy and recreate with the new agent included
  const newAgents = [...state.agents, agent];
  destroyGrid(state);
  return createGrid(newAgents, dashboardPaneId, vertical, dashboardSize);
}

/**
 * Remove an agent from the grid. Re-layouts remaining agents.
 * Returns updated GridState, or null if < 2 agents remain (grid should close).
 */
export function removeFromGrid(
  state: GridState,
  agentPaneId: string,
  dashboardPaneId: string,
  vertical: boolean,
  dashboardSize: number
): GridState | null {
  const remaining = state.agents.filter((a) => a.tmuxPaneId !== agentPaneId);
  destroyGrid(state);
  if (remaining.length < 1) return null;
  return createGrid(remaining, dashboardPaneId, vertical, dashboardSize);
}
