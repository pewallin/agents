#!/bin/bash
# Claude UserPromptSubmit hook: report working state.
. "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/lib/agents-hook.sh"

if [ -n "$TMUX_PANE" ]; then
  SESSION="$TMUX_PANE"
else
  SESSION="default"
fi

agents_hook_run claude report --agent claude --state working --session "$SESSION"
