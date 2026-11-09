/** Whether this process runs inside a tmux pane (tmux sets $TMUX in every pane it starts). */
export function insideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.TMUX;
}
