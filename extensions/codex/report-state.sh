#!/bin/bash
# Codex hook: report pane state to the agents dashboard.
# Usage: report-state.sh <state>
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

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // .thread_id // .threadId // .agent_id // .agentId // empty' 2>/dev/null)
MODEL=$(printf '%s' "$INPUT" | jq -r '.model // empty' 2>/dev/null)
MODEL_ID=$(printf '%s' "$INPUT" | jq -r '.model_id // .modelId // empty' 2>/dev/null)
MODEL_LABEL=$(printf '%s' "$INPUT" | jq -r '.model_label // .modelLabel // empty' 2>/dev/null)
PROVIDER=$(printf '%s' "$INPUT" | jq -r '.provider // .model_provider // .modelProvider // empty' 2>/dev/null)
CONTEXT_TOKENS=$(printf '%s' "$INPUT" | jq -r '.context_tokens // .contextTokens // .token_usage.total // .tokenUsage.total // .usage.current_tokens // .usage.currentTokens // .usage.tokens // empty' 2>/dev/null)
CONTEXT_MAX=$(printf '%s' "$INPUT" | jq -r '.context_max // .contextMax // .context_window // .contextWindow // .token_usage.limit // .tokenUsage.limit // .usage.token_limit // .usage.tokenLimit // .usage.context_window // .usage.contextWindow // empty' 2>/dev/null)
DETAIL_RAW=$(printf '%s' "$INPUT" | jq -r '
def first_text:
  if type == "string" then .
  elif type == "array" then
    ([ .[] | if type == "string" then . elif type == "object" then (.text // .content // empty) else empty end ]
      | map(select(type == "string" and length > 0))
      | .[0]) // empty
  elif type == "object" then (.text // .content // empty)
  else empty
  end;
(.prompt // .user_prompt // .userPrompt // .input // .input_text // .inputText // .message // .text // .user_message // .userMessage // .hook_event.input // .hookEvent.input // empty) | first_text
' 2>/dev/null)
DETAIL=$(printf '%s' "$DETAIL_RAW" | awk 'NF { print; exit }' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | cut -c1-160)

agents_home() {
  if [ -n "${AGENTS_HOME:-}" ]; then
    printf '%s' "$AGENTS_HOME"
    return
  fi
  printf '%s/%s' "${AGENTS_SHARED_HOME:-$HOME/.agents}" "${AGENTS_PRODUCT_DIRNAME:-agents-app}"
}

runtime_tmp_dir() {
  if [ -n "${AGENTS_TMP_DIR:-}" ]; then
    printf '%s' "$AGENTS_TMP_DIR"
    return
  fi
  if [ -n "${AGENTS_RUNTIME_DIR:-}" ]; then
    printf '%s/tmp' "$AGENTS_RUNTIME_DIR"
    return
  fi
  printf '%s/runtime/tmp' "$(agents_home)"
}

internal_session_marker() {
  local session_id="$1"
  local safe_id
  safe_id=$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9._-' '_')
  printf '%s/codex-internal-%s' "$(runtime_tmp_dir)" "$safe_id"
}

is_internal_codex_prompt() {
  case "$1" in
    "## Memory Writing Agent:"*|"Memory Writing Agent:"*)
      return 0
      ;;
  esac
  return 1
}

mark_internal_session() {
  [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ] || return
  local marker_dir
  marker_dir=$(runtime_tmp_dir)
  mkdir -p "$marker_dir" 2>/dev/null || return
  {
    date +%s
    printf '%s\n' "$SESSION"
  } >"$(internal_session_marker "$SESSION_ID")" 2>/dev/null || true
}

if is_internal_codex_prompt "$DETAIL"; then
  mark_internal_session
  exit 0
fi

if [ -z "$MODEL_ID" ] && [ -n "$MODEL" ] && [ "$MODEL" != "null" ]; then
  case "$MODEL" in
    */*)
      [ -z "$PROVIDER" ] && PROVIDER="${MODEL%%/*}"
      MODEL_ID="${MODEL#*/}"
      ;;
    *)
      MODEL_ID="$MODEL"
      ;;
  esac
fi

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

ARGS=(report --agent codex --state "$STATE" --session "$SESSION")
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
if [ -n "$PROVIDER" ] || [ -n "$MODEL_ID" ] || [ -n "$MODEL_LABEL" ]; then
  ARGS+=(--model-source hook)
fi
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
  ARGS+=(--external-session-id "$SESSION_ID")
fi
if [ -n "$DETAIL" ] && [ "$DETAIL" != "null" ]; then
  ARGS+=(--intent "$DETAIL" --clear-detail)
else
  ARGS+=(--clear-detail)
fi
if [ -n "$CONTEXT_TOKENS" ] && [ "$CONTEXT_TOKENS" != "null" ]; then
  ARGS+=(--context-tokens "$CONTEXT_TOKENS")
fi
if [ -n "$CONTEXT_MAX" ] && [ "$CONTEXT_MAX" != "null" ]; then
  ARGS+=(--context-max "$CONTEXT_MAX")
fi

"${AGENTS_CMD[@]}" "${ARGS[@]}"
