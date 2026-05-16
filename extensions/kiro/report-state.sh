#!/bin/bash
# Kiro CLI hook: report pane state to the agents dashboard.
# Hooks pass a JSON event via stdin. Keep stdout empty because Kiro may add
# successful hook output to agent context for some lifecycle events.

if [ -n "$TMUX_PANE" ]; then
  SESSION="$TMUX_PANE"
elif [ -n "$ZELLIJ_PANE_ID" ]; then
  SESSION="terminal_${ZELLIJ_PANE_ID}"
else
  SESSION="default"
fi

INPUT=$(cat)
EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // .hookEventName // empty' 2>/dev/null)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // .toolName // empty' 2>/dev/null)
PROMPT_RAW=$(printf '%s' "$INPUT" | jq -r '
def first_text:
  if type == "string" then .
  elif type == "array" then
    ([ .[] | if type == "string" then . elif type == "object" then (.data // .text // .content // empty) else empty end ]
      | map(select(type == "string" and length > 0))
      | .[0]) // empty
  elif type == "object" then (.data // .text // .content // empty)
  else empty
  end;
(.prompt // .user_prompt // .userPrompt // .input // .message // empty) | first_text
' 2>/dev/null)
ASSISTANT_RAW=$(printf '%s' "$INPUT" | jq -r '
def first_text:
  if type == "string" then .
  elif type == "array" then
    ([ .[] | if type == "string" then . elif type == "object" then (.data // .text // .content // empty) else empty end ]
      | map(select(type == "string" and length > 0))
      | join("\n"))
  elif type == "object" then (.data // .text // .content // empty)
  else empty
  end;
(.assistant_response // .assistantResponse // .last_assistant_message // .lastAssistantMessage // .response // empty) | first_text
' 2>/dev/null)

STATE="idle"
DETAIL=""
CLEAR_DETAIL=false
case "$EVENT" in
  agentSpawn)
    STATE="idle"
    CLEAR_DETAIL=true
    ;;
  userPromptSubmit)
    STATE="working"
    DETAIL=$(printf '%s' "$PROMPT_RAW" | awk 'NF { print; exit }')
    ;;
  preToolUse|postToolUse)
    STATE="working"
    DETAIL="$TOOL_NAME"
    ;;
  stop)
    TAIL=$(printf '%s' "$ASSISTANT_RAW" | grep -v '^[[:space:]]*$' | tail -3)
    if printf '%s' "$TAIL" | grep -Fq '?'; then
      STATE="question"
      DETAIL=$(printf '%s' "$ASSISTANT_RAW" | awk 'NF { print; exit }')
    else
      STATE="idle"
      CLEAR_DETAIL=true
    fi
    ;;
esac

DETAIL=$(printf '%s' "$DETAIL" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | cut -c1-160)

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

ARGS=(report --agent kiro --state "$STATE" --session "$SESSION")
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
  ARGS+=(--external-session-id "$SESSION_ID")
fi
if [ -n "$DETAIL" ] && [ "$DETAIL" != "null" ]; then
  ARGS+=(--detail "$DETAIL")
elif [ "$CLEAR_DETAIL" = true ]; then
  ARGS+=(--clear-detail)
fi

"${AGENTS_CMD[@]}" "${ARGS[@]}" >/dev/null 2>&1
