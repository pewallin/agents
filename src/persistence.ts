/**
 * Preview state persistence — survives HMR and vite-node restarts.
 *
 * Saves preview state to a temp file keyed by the dashboard's tmux pane ID.
 * On restart, loads and validates the saved state (checks that key panes still exist).
 */
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { paneExists, ownPaneId } from "./scanner.js";
import type { HelperZone } from "./zones.js";

export interface PreviewState {
  splitPaneId: string;        // placeholder sitting in agent's original position
  agentTmuxId: string;        // agent pane (swapped into preview)
  agentName: string;
  agentPane: string;
  agentPaneId: string;
  vertical: boolean;
  windowId: string;
  zones: HelperZone[];        // persistent helper zones
  helperLayout: string | null; // active layout name, or null
  originalTabIndex?: number;  // zellij: agent's original tab (for restore)
}

// Lazy-init to avoid calling ownPaneId() (which may call tmux) at import time
let _stateFile: string | null = null;
function stateFile(): string {
  if (!_stateFile) {
    const selfPane = ownPaneId();
    _stateFile = join(tmpdir(), `agents-preview-${selfPane.replace("%", "")}.json`);
  }
  return _stateFile;
}

export function savePreviewState(pv: PreviewState | null): void {
  try {
    if (pv) writeFileSync(stateFile(), JSON.stringify(pv));
    else unlinkSync(stateFile());
  } catch {}
}

export function loadPreviewState(): PreviewState | null {
  try {
    const pv: PreviewState = JSON.parse(readFileSync(stateFile(), "utf-8"));
    if (!paneExists(pv.splitPaneId) || !paneExists(pv.agentTmuxId)) {
      unlinkSync(stateFile());
      return null;
    }
    pv.zones = (pv.zones || []).filter((z) => paneExists(z.zonePaneId));
    return pv;
  } catch {
    return null;
  }
}
