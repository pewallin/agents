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
    USED_PCT=$(jq -r '.used_pct // empty' "$BRIDGE" 2>/dev/null)
    if [ -n "$USED_PCT" ] && [ "$USED_PCT" != "null" ]; then
      # Approximate raw tokens: used_pct% of 200k context window
      TOKENS=$(( USED_PCT * 2000 ))
      CTX_ARGS="--context-tokens $TOKENS --context-max 200000"
    fi
  fi
fi

agents report --agent claude --state "$STATE" --session "$SESSION" $CTX_ARGS
