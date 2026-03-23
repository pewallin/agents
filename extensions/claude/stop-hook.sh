#!/bin/bash
# Claude Stop hook: detect if the agent asked a question.
# Reads JSON from stdin with last_assistant_message field.
# Reports "question" if the last text block contains ?, otherwise "idle".

if [ -n "$TMUX_PANE" ]; then
  SESSION="$TMUX_PANE"
elif [ -n "$ZELLIJ_PANE_ID" ]; then
  SESSION="terminal_${ZELLIJ_PANE_ID}"
else
  SESSION="default"
fi
INPUT=$(cat)

# Don't recurse if stop hook is already active
ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$ACTIVE" = "true" ]; then
  exit 0
fi

MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Check if the last 3 non-empty lines contain a question mark.
# Only the tail of the message matters — earlier questions in the
# conversation (code comments, URLs, explanations) are not relevant.
TAIL=$(printf '%s' "$MSG" | grep -v '^[[:space:]]*$' | tail -3)
if printf '%s' "$TAIL" | grep -Fq '?'; then
  agents report --agent claude --state question --session "$SESSION"
else
  agents report --agent claude --state idle --session "$SESSION"
fi
