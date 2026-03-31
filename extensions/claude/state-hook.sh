#!/bin/bash
# Claude state hook: reports agent state to agents dashboard.
# Reads bridge file from statusline for context window data.
# Usage: state-hook.sh <state>
#   state: working, idle, approval, question

STATE="$1"
[ -z "$STATE" ] && exit 0

if [ -n "$TMUX_PANE" ]; then
  SESSION="$TMUX_PANE"
elif [ -n "$ZELLIJ_PANE_ID" ]; then
  SESSION="terminal_${ZELLIJ_PANE_ID}"
else
  SESSION="default"
fi

# Read session_id from stdin (hooks pipe JSON)
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

# Try to read context data from statusline bridge file
CTX_ARGS=""
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

SESSION_ARGS=""
if [ -n "$SESSION_ID" ]; then
  SESSION_ARGS="--external-session-id $SESSION_ID"
fi

agents report --agent claude --state "$STATE" --session "$SESSION" $SESSION_ARGS $CTX_ARGS
