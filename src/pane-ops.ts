import { exec } from "./shell.js";
import { BACK_ENV } from "./back.js";
import { appendRuntimeFocusRequest } from "./runtime-events.js";

/** Shows a pane to the user: through Agents Next when its control-mode client is the
 *  current client, else by switching this tmux client, remembering where it was for `agents back`. */
export function switchToPane(paneId: string, tmuxPaneId?: string): void {
  // Inside Agents Next the current client is the app's control-mode client: switching it
  // would take it away from the panes it shows. Ask the app to show the pane instead.
  if (tmuxPaneId && exec(`tmux display-message -p '#{client_control_mode}'`) === "1") {
    appendRuntimeFocusRequest(tmuxPaneId);
    return;
  }
  const current = exec(`tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`);
  if (current) {
    exec(`tmux set-environment -g ${BACK_ENV} ${JSON.stringify(current)}`);
  }
  exec(`tmux select-window -t ${JSON.stringify(paneId)}`);
  if (tmuxPaneId) exec(`tmux select-pane -t ${tmuxPaneId}`);
  exec(`tmux switch-client -t ${JSON.stringify(paneId)}`);
}
