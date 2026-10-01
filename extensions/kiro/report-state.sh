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

# Kiro v3 also executes hooks embedded in a v2 agent config. Ignore those
# PascalCase compatibility events so the global v3 hook remains authoritative.
if [ "${AGENTS_KIRO_V2_HOOK:-}" = "1" ]; then
  case "$EVENT" in
    SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop)
      exit 0
      ;;
  esac
fi

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
if [ -z "$PROMPT_RAW" ] && [ -n "${USER_PROMPT:-}" ]; then
  PROMPT_RAW="${USER_PROMPT:-}"
fi
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
INTENT=""
CLEAR_DETAIL=false
case "$EVENT" in
  agentSpawn|SessionStart)
    STATE="idle"
    CLEAR_DETAIL=true
    ;;
  userPromptSubmit|UserPromptSubmit)
    STATE="working"
    INTENT=$(printf '%s' "$PROMPT_RAW" | awk 'NF { print; exit }')
    CLEAR_DETAIL=true
    ;;
  preToolUse|postToolUse|PreToolUse|PostToolUse)
    STATE="working"
    DETAIL="$TOOL_NAME"
    ;;
  stop|Stop)
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
INTENT=$(printf '%s' "$INTENT" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//' | cut -c1-160)

. "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/lib/agents-hook.sh"

ARGS=(report --agent kiro --state "$STATE" --session "$SESSION")
if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
  ARGS+=(--external-session-id "$SESSION_ID")
fi
if [ -n "$INTENT" ] && [ "$INTENT" != "null" ]; then
  ARGS+=(--intent "$INTENT" --clear-detail)
elif [ -n "$DETAIL" ] && [ "$DETAIL" != "null" ]; then
  ARGS+=(--detail "$DETAIL")
elif [ "$CLEAR_DETAIL" = true ]; then
  ARGS+=(--clear-detail)
fi

agents_hook_run kiro "${ARGS[@]}"
