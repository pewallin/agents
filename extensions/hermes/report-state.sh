#!/bin/bash
# Hermes shell hook: report pane state to the agents dashboard.
# Hermes passes a normalized JSON payload on stdin. Keep stdout empty because
# pre_llm_call hooks can inject stdout JSON back into the model context.

if [ -n "$TMUX_PANE" ]; then
  SESSION="$TMUX_PANE"
elif [ -n "$ZELLIJ_PANE_ID" ]; then
  SESSION="terminal_${ZELLIJ_PANE_ID}"
else
  SESSION="default"
fi

INPUT=$(cat)

jq_read() {
  printf '%s' "$INPUT" | jq -r "$1" 2>/dev/null
}

EVENT=$(jq_read '.hook_event_name // empty')
SESSION_ID=$(jq_read '.session_id // empty')
TOOL_NAME=$(jq_read '.tool_name // empty')
MODEL=$(jq_read '.extra.model // empty')
PROVIDER=$(jq_read '.extra.provider // empty')
MODEL_ID=$(jq_read '.extra.model_id // .extra.modelId // .extra.response_model // .extra.responseModel // empty')
MODEL_LABEL=$(jq_read '.extra.model_label // .extra.modelLabel // empty')
CONTEXT_TOKENS=$(jq_read '.extra.approx_input_tokens // .extra.approxInputTokens // .extra.usage.input_tokens // .extra.usage.inputTokens // .extra.usage.prompt_tokens // .extra.usage.promptTokens // empty')
CONTEXT_MAX=$(jq_read '.extra.context_max // .extra.contextMax // .extra.context_window // .extra.contextWindow // empty')
PROMPT_RAW=$(jq_read '
def first_text:
  if type == "string" then .
  elif type == "array" then
    ([ .[] | if type == "string" then . elif type == "object" then (.text // .content // empty) else empty end ]
      | map(select(type == "string" and length > 0))
      | .[0]) // empty
  elif type == "object" then (.text // .content // empty)
  else empty
  end;
(.extra.user_message // .extra.userMessage // .extra.prompt // .extra.input // empty) | first_text
')
ASSISTANT_RAW=$(jq_read '
def first_text:
  if type == "string" then .
  elif type == "array" then
    ([ .[] | if type == "string" then . elif type == "object" then (.text // .content // empty) else empty end ]
      | map(select(type == "string" and length > 0))
      | join("\n"))
  elif type == "object" then (.text // .content // empty)
  else empty
  end;
(.extra.assistant_response // .extra.assistantResponse // .extra.response_text // .extra.responseText // empty) | first_text
')
APPROVAL_DETAIL=$(jq_read '.extra.description // .extra.command // .extra.pattern_key // .extra.patternKey // empty')
INTERRUPTED=$(jq_read '.extra.interrupted // false')

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

STATE=""
DETAIL=""
INTENT=""
CLEAR_DETAIL=false
CLEAR_INTENT=false

case "$EVENT" in
  on_session_start)
    STATE="idle"
    CLEAR_DETAIL=true
    CLEAR_INTENT=true
    ;;
  pre_llm_call|pre_api_request)
    STATE="working"
    INTENT="$PROMPT_RAW"
    ;;
  post_api_request)
    STATE="working"
    ;;
  pre_tool_call|post_tool_call)
    STATE="working"
    DETAIL="$TOOL_NAME"
    ;;
  pre_approval_request)
    STATE="approval"
    DETAIL="$APPROVAL_DETAIL"
    ;;
  post_approval_response)
    STATE="working"
    CLEAR_DETAIL=true
    ;;
  post_llm_call)
    TAIL=$(printf '%s' "$ASSISTANT_RAW" | grep -v '^[[:space:]]*$' | tail -3)
    if printf '%s' "$TAIL" | grep -Fq '?'; then
      STATE="question"
      DETAIL=$(printf '%s' "$ASSISTANT_RAW" | awk 'NF { print; exit }')
    else
      STATE="idle"
      CLEAR_DETAIL=true
    fi
    ;;
  on_session_end)
    if [ "$INTERRUPTED" = "true" ]; then
      STATE="idle"
      CLEAR_DETAIL=true
    else
      exit 0
    fi
    ;;
  on_session_finalize|on_session_reset)
    STATE="idle"
    CLEAR_DETAIL=true
    CLEAR_INTENT=true
    ;;
  *)
    exit 0
    ;;
esac

DETAIL=$(printf '%s' "$DETAIL" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | cut -c1-160)
INTENT=$(printf '%s' "$INTENT" | awk 'NF { print; exit }' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | cut -c1-160)

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
AGENTS_CMD=()
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_BIN="/usr/local/bin/node"
fi

if [ -n "$NODE_BIN" ] && [ -f "$REPO_DIR/dist/cli.js" ]; then
  AGENTS_CMD=("$NODE_BIN" "$REPO_DIR/dist/cli.js")
elif command -v agents >/dev/null 2>&1; then
  AGENTS_CMD=("$(command -v agents)")
elif [ -x "$HOME/.local/bin/agents" ]; then
  AGENTS_CMD=("$HOME/.local/bin/agents")
else
  exit 0
fi

ARGS=(report --agent hermes --state "$STATE" --session "$SESSION")
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
  ARGS+=(--external-session-id "$SESSION_ID")
fi
if [ -n "$DETAIL" ] && [ "$DETAIL" != "null" ]; then
  ARGS+=(--detail "$DETAIL")
elif [ "$CLEAR_DETAIL" = true ]; then
  ARGS+=(--clear-detail)
fi
if [ -n "$INTENT" ] && [ "$INTENT" != "null" ]; then
  ARGS+=(--intent "$INTENT")
elif [ "$CLEAR_INTENT" = true ]; then
  ARGS+=(--clear-intent)
fi
if [ -n "$MODEL" ] && [ "$MODEL" != "null" ]; then
  ARGS+=(--model "$MODEL")
fi
if [ -n "$PROVIDER" ] && [ "$PROVIDER" != "null" ]; then
  ARGS+=(--provider "$PROVIDER")
fi
if [ -n "$MODEL_ID" ] && [ "$MODEL_ID" != "null" ]; then
  ARGS+=(--model-id "$MODEL_ID")
fi
if [ -n "$MODEL_LABEL" ] && [ "$MODEL_LABEL" != "null" ]; then
  ARGS+=(--model-label "$MODEL_LABEL")
fi
if [ -n "$PROVIDER" ] || [ -n "$MODEL_ID" ] || [ -n "$MODEL_LABEL" ] || [ -n "$MODEL" ]; then
  ARGS+=(--model-source hook)
fi
if [ -n "$CONTEXT_TOKENS" ] && [ "$CONTEXT_TOKENS" != "null" ]; then
  ARGS+=(--context-tokens "$CONTEXT_TOKENS")
fi
if [ -n "$CONTEXT_MAX" ] && [ "$CONTEXT_MAX" != "null" ]; then
  ARGS+=(--context-max "$CONTEXT_MAX")
fi

"${AGENTS_CMD[@]}" "${ARGS[@]}" >/dev/null 2>&1
