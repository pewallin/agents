#!/bin/bash
# Claude Stop hook: detect if the agent asked a question.
# Reads JSON from stdin with last_assistant_message field.
# Reports "question" if the last text block contains ?, otherwise "idle".

SESSION="${TMUX_PANE:-default}"
INPUT=$(cat)

# Debug: capture hook input for troubleshooting
echo "$INPUT" > /tmp/claude-stop-hook-debug.json

# Don't recurse if stop hook is already active
ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$ACTIVE" = "true" ]; then
  exit 0
fi

MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Check if the last ~500 chars contain a question mark.
# Use tail -c for portability (bash 3.2 ${var: -N} fails when N > length).
# Use grep -F for literal '?' match (not regex).
TAIL=$(printf '%s' "$MSG" | tail -c 500)
HAS_Q=$(printf '%s' "$TAIL" | grep -Fc '?' || true)
echo "TAIL_LEN=${#TAIL} HAS_Q=${HAS_Q} SESSION=${SESSION}" > /tmp/claude-stop-hook-result.txt
echo "$TAIL" > /tmp/claude-stop-hook-tail.txt
if printf '%s' "$TAIL" | grep -Fq '?'; then
  agents report --agent claude --state question --session "$SESSION"
else
  agents report --agent claude --state idle --session "$SESSION"
fi
