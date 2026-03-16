/**
 * Helper zone lifecycle management.
 *
 * Zones are persistent tmux panes in the preview layout that show
 * companion tools (lazygit, yazi, etc.) from the agent's original window.
 * Zones are created once and helpers are swapped in/out on agent switch.
 */
import { createSplitPane, findSiblingPanes, swapPanes, paneExists, killPane, showPlaceholder, getPaneWidth, resizePaneWidth } from "./scanner.js";
import type { HelperDef } from "./config.js";

export interface HelperZone {
  zonePaneId: string;              // persistent pane in the preview layout
  process: string;                 // config process name to match
  occupantPaneId: string | null;   // helper pane currently swapped in
}

/** Create the helper zone layout around the agent preview pane.
 *  Zones are empty panes; call populateZones to swap helpers in. */
export function createZones(agentTmuxId: string, defs: HelperDef[]): HelperZone[] {
  const zones: HelperZone[] = [];
  const paneMap: Record<string, string> = { agent: agentTmuxId };

  for (const def of defs) {
    const targetId = paneMap[def.of || "agent"] || agentTmuxId;
    const size = def.size || "20%";
    const zonePaneId = createSplitPane(targetId, def.split, size);
    if (!zonePaneId) continue;
    paneMap[def.process] = zonePaneId;
    zones.push({ zonePaneId, process: def.process, occupantPaneId: null });
  }
  return zones;
}

/** Swap matching helper panes from the agent's window into zones. */
export function populateZones(zones: HelperZone[], windowId: string, agentTmuxId: string): void {
  if (!windowId) return;
  const siblings = findSiblingPanes(windowId, agentTmuxId);
  for (const zone of zones) {
    if (zone.occupantPaneId) continue;
    const sibling = siblings.find((s) =>
      s.command.toLowerCase() === zone.process.toLowerCase()
    );
    if (!sibling) continue;
    swapPanes(sibling.tmuxPaneId, zone.zonePaneId);
    zone.occupantPaneId = sibling.tmuxPaneId;
  }
}

/** Swap all helpers back out of zones to their original positions. */
export function depopulateZones(zones: HelperZone[]): void {
  for (const zone of [...zones].reverse()) {
    if (!zone.occupantPaneId) continue;
    if (paneExists(zone.occupantPaneId) && paneExists(zone.zonePaneId)) {
      swapPanes(zone.occupantPaneId, zone.zonePaneId);
    }
    zone.occupantPaneId = null;
  }
}

/** Label all zone placeholders after swaps are complete. */
export function labelZones(zones: HelperZone[]): void {
  for (const zone of zones) {
    if (!paneExists(zone.zonePaneId)) continue;
    if (zone.occupantPaneId) {
      showPlaceholder(zone.zonePaneId, zone.process, "(in preview)");
    } else {
      showPlaceholder(zone.zonePaneId, zone.process, "(not found)");
    }
  }
}

/** Swap helpers back and destroy all zone panes.
 *  If protectPaneId is given, its width is preserved after zone destruction. */
export function destroyZones(zones: HelperZone[], protectPaneId?: string): void {
  const savedWidth = protectPaneId ? getPaneWidth(protectPaneId) : 0;
  for (const zone of [...zones].reverse()) {
    if (zone.occupantPaneId) {
      if (paneExists(zone.occupantPaneId) && paneExists(zone.zonePaneId)) {
        swapPanes(zone.occupantPaneId, zone.zonePaneId);
      }
      zone.occupantPaneId = null;
    }
    if (paneExists(zone.zonePaneId)) killPane(zone.zonePaneId);
  }
  if (protectPaneId && savedWidth > 0) {
    resizePaneWidth(protectPaneId, savedWidth);
  }
}
