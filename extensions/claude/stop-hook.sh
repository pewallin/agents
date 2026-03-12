#!/bin/bash
# Claude Stop hook: detect if the agent asked a question.
# Reads JSON from stdin with last_assistant_message field.
# Reports "question" if the last text block contains ?, otherwise "idle".

SESSION="${TMUX_PANE:-default}"
INPUT=$(cat)

# Don't recurse if stop hook is already active
ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$ACTIVE" = "true" ]; then
  exit 0
fi

MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Check if the last block (last ~500 chars) contains a question mark
TAIL="${MSG: -500}"
if echo "$TAIL" | grep -q '?'; then
  agents report --agent claude --state question --session "$SESSION"
else
  agents report --agent claude --state idle --session "$SESSION"
fi
