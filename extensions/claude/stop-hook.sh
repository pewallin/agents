#!/bin/bash
# Claude Stop hook: detect if the agent asked a question.
# Reads JSON from stdin with last_assistant_message field.
# Reports "question" if the last text block contains ?, otherwise "idle".
# Also reads context window data from statusline bridge file.

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

# Read context data from statusline bridge file
CTX_ARGS=""
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
if [ -n "$SESSION_ID" ]; then
  BRIDGE="/tmp/claude-ctx-${SESSION_ID}.json"
  if [ -f "$BRIDGE" ]; then
    USED_TOKENS=$(jq -r '.used_tokens // empty' "$BRIDGE" 2>/dev/null)
    MAX_TOKENS=$(jq -r '.max_tokens // empty' "$BRIDGE" 2>/dev/null)
    if [ -n "$USED_TOKENS" ] && [ "$USED_TOKENS" != "null" ]; then
      CTX_ARGS="--context-tokens $USED_TOKENS"
      if [ -n "$MAX_TOKENS" ] && [ "$MAX_TOKENS" != "null" ]; then
        CTX_ARGS="$CTX_ARGS --context-max $MAX_TOKENS"
      fi
    fi
  fi
fi

MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Check if the last 3 non-empty lines contain a question mark.
# Only the tail of the message matters — earlier questions in the
# conversation (code comments, URLs, explanations) are not relevant.
TAIL=$(printf '%s' "$MSG" | grep -v '^[[:space:]]*$' | tail -3)
SESSION_ARGS=""
if [ -n "$SESSION_ID" ]; then
  SESSION_ARGS="--external-session-id $SESSION_ID"
fi

if printf '%s' "$TAIL" | grep -Fq '?'; then
  agents report --agent claude --state question --session "$SESSION" $SESSION_ARGS $CTX_ARGS
else
  agents report --agent claude --state idle --session "$SESSION" $SESSION_ARGS $CTX_ARGS
fi
