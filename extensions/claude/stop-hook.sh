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
MODEL=$(printf '%s' "$INPUT" | jq -r '.model // empty' 2>/dev/null)
MODEL_ID=$(printf '%s' "$INPUT" | jq -r '.model_id // .modelId // empty' 2>/dev/null)
MODEL_LABEL=$(printf '%s' "$INPUT" | jq -r '.model_label // .modelLabel // empty' 2>/dev/null)
PROVIDER=$(printf '%s' "$INPUT" | jq -r '.provider // .model_provider // .modelProvider // empty' 2>/dev/null)
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

MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Check if the last 3 non-empty lines contain a question mark.
# Only the tail of the message matters — earlier questions in the
# conversation (code comments, URLs, explanations) are not relevant.
TAIL=$(printf '%s' "$MSG" | grep -v '^[[:space:]]*$' | tail -3)
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

if printf '%s' "$TAIL" | grep -Fq '?'; then
  agents report --agent claude --state question --session "$SESSION" $SESSION_ARGS $CTX_ARGS $MODEL_ARGS
else
  agents report --agent claude --state idle --session "$SESSION" $SESSION_ARGS $CTX_ARGS $MODEL_ARGS
fi
