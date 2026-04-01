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
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
MODEL=$(printf '%s' "$INPUT" | jq -r '.model // empty' 2>/dev/null)
MODEL_ID=$(printf '%s' "$INPUT" | jq -r '.model_id // .modelId // empty' 2>/dev/null)
MODEL_LABEL=$(printf '%s' "$INPUT" | jq -r '.model_label // .modelLabel // empty' 2>/dev/null)
PROVIDER=$(printf '%s' "$INPUT" | jq -r '.provider // .model_provider // .modelProvider // empty' 2>/dev/null)
CONTEXT_TOKENS=$(printf '%s' "$INPUT" | jq -r '.context_tokens // .contextTokens // .token_usage.total // .tokenUsage.total // .usage.current_tokens // .usage.currentTokens // .usage.tokens // empty' 2>/dev/null)
CONTEXT_MAX=$(printf '%s' "$INPUT" | jq -r '.context_max // .contextMax // .context_window // .contextWindow // .token_usage.limit // .tokenUsage.limit // .usage.token_limit // .usage.tokenLimit // .usage.context_window // .usage.contextWindow // empty' 2>/dev/null)

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
if [ -n "$CONTEXT_TOKENS" ] && [ "$CONTEXT_TOKENS" != "null" ]; then
  ARGS+=(--context-tokens "$CONTEXT_TOKENS")
fi
if [ -n "$CONTEXT_MAX" ] && [ "$CONTEXT_MAX" != "null" ]; then
  ARGS+=(--context-max "$CONTEXT_MAX")
fi

"${AGENTS_CMD[@]}" "${ARGS[@]}"
