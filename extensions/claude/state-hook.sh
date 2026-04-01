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
MODEL=$(printf '%s' "$INPUT" | jq -r '.model // empty' 2>/dev/null)
MODEL_ID=$(printf '%s' "$INPUT" | jq -r '.model_id // .modelId // empty' 2>/dev/null)
MODEL_LABEL=$(printf '%s' "$INPUT" | jq -r '.model_label // .modelLabel // empty' 2>/dev/null)
PROVIDER=$(printf '%s' "$INPUT" | jq -r '.provider // .model_provider // .modelProvider // empty' 2>/dev/null)

if [ -z "$MODEL_ID" ] && [ -n "$MODEL" ] && [ "$MODEL" != "null" ]; then
  case "$MODEL" in
    */*)
      [ -z "$PROVIDER" ] && PROVIDER="${MODEL%%/*}"
      MODEL_ID="${MODEL#*/}"
      [ -z "$MODEL_LABEL" ] && MODEL_LABEL="$MODEL_ID"
      ;;
    *)
      MODEL_ID="$MODEL"
      [ -z "$MODEL_LABEL" ] && MODEL_LABEL="$MODEL"
      ;;
  esac
fi

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

MODEL_ARGS=""
if [ -n "$PROVIDER" ] && [ "$PROVIDER" != "null" ]; then
  MODEL_ARGS="$MODEL_ARGS --provider $PROVIDER"
fi
if [ -n "$MODEL_ID" ] && [ "$MODEL_ID" != "null" ]; then
  MODEL_ARGS="$MODEL_ARGS --model-id $MODEL_ID"
fi
if [ -n "$MODEL_LABEL" ] && [ "$MODEL_LABEL" != "null" ]; then
  MODEL_ARGS="$MODEL_ARGS --model-label $MODEL_LABEL"
fi
if [ -n "$PROVIDER" ] || [ -n "$MODEL_ID" ] || [ -n "$MODEL_LABEL" ]; then
  MODEL_ARGS="$MODEL_ARGS --model-source hook"
fi

agents report --agent claude --state "$STATE" --session "$SESSION" $SESSION_ARGS $CTX_ARGS $MODEL_ARGS
