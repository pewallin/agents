import { exec } from "./shell.js";

export const BACK_ENV = "AGENTS_BACK_PANE";

/**
 * Jump back to the last pane/window stored by switchToPane().
 * Kept intentionally lightweight so `agents back` can fast-path before
 * loading Ink/React/Commander.
 */
export function switchBack(): boolean {
  const raw = exec(`tmux show-environment -g ${BACK_ENV} 2>/dev/null`);
  const back = raw.replace(`${BACK_ENV}=`, "");
  if (!back) return false;

  exec(`tmux select-window -t ${JSON.stringify(back)} \\; switch-client -t ${JSON.stringify(back)}`);

  // Signal the dashboard to exit fullscreen by sending 's' to a narrow pane.
  const winRef = back.replace(/\.\d+$/, "");
  const panes = exec(`tmux list-panes -t ${JSON.stringify(winRef)} -F '#{pane_id}§#{pane_width}' 2>/dev/null`);
  if (!panes) return true;

  for (const line of panes.split("\n")) {
    const [paneId, width] = line.split("§");
    if (paneId && parseInt(width, 10) <= 5) {
      exec(`tmux send-keys -t ${paneId} s`);
      break;
    }
  }
  return true;
}
