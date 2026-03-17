#!/bin/bash
# Claude UserPromptSubmit hook: report working state.
# Works in both tmux ($TMUX_PANE) and zellij ($ZELLIJ_PANE_ID).

if [ -n "$TMUX_PANE" ]; then
  SESSION="$TMUX_PANE"
elif [ -n "$ZELLIJ_PANE_ID" ]; then
  SESSION="terminal_${ZELLIJ_PANE_ID}"
else
  SESSION="default"
fi

agents report --agent claude --state working --session "$SESSION"
