#!/bin/bash
# Claude PostToolUse hook: hands steered messages to the turn in progress.
#
# A coordinator steers a message into a working agent with `agents-app-control agent send
# --mode steer`. For Claude Code it lands in this pane's steer inbox (docs/steer-inbox.md), and
# this hook, which runs after every tool call, takes it and returns it as additionalContext:
# Claude Code adds that to the conversation before the model's next step, inside the same turn.
# Nothing is typed into the terminal and nothing is interrupted.
#
# The hook also says that this pane's Claude takes steered messages (harness.json), so the CLI
# does not offer them to an agent that would never take them.
#
# Taking a message is a rename (<id>.msg -> <id>.taken), so a message the CLI withdraws at the
# same moment is either taken or withdrawn, never both. <id>.ack.json records what happened.
. "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/lib/agents-hook.sh"

[ -n "$TMUX_PANE" ] && [ -n "$TMUX" ] || exit 0
cat > /dev/null
SERVER_PID=$(printf '%s' "$TMUX" | cut -d, -f2)
[ -n "$SERVER_PID" ] || exit 0
DIR="${AGENTS_TMP_DIR:-$(agents_hook_home)/runtime/tmp}/steer/${SERVER_PID}-pane-${TMUX_PANE#%}"
mkdir -p "$DIR" 2>/dev/null || exit 0

# The Claude Code process: the first ancestor of this hook that is not a shell.
agent_pid() {
  local pid=$PPID comm i
  for i in 1 2 3 4 5 6; do
    comm=$(ps -o comm= -p "$pid" 2>/dev/null | sed 's#.*/##; s/^-//')
    case "$comm" in
      ""|sh|bash|zsh|dash|env) pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') ;;
      *) printf '%s\n' "$pid"; return 0 ;;
    esac
    [ -n "$pid" ] && [ "$pid" -gt 1 ] || return 1
  done
  return 1
}

HARNESS="$DIR/harness.json"
KNOWN_PID=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$HARNESS" 2>/dev/null)
if [ -z "$KNOWN_PID" ] || ! kill -0 "$KNOWN_PID" 2>/dev/null; then
  PID=$(agent_pid) || exit 0
  printf '{"harness":"claude","pid":%s,"at":"%s"}\n' "$PID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HARNESS.$$" && mv -f "$HARNESS.$$" "$HARNESS"
fi

TEXTS=()
for MSG in "$DIR"/*.msg; do
  [ -e "$MSG" ] || continue
  ID=$(basename "$MSG" .msg)
  mv "$MSG" "$DIR/$ID.taken" 2>/dev/null || continue
  TEXT=$(jq -r '.text // empty' "$DIR/$ID.taken" 2>/dev/null)
  if [ -z "$TEXT" ]; then
    printf '{"state":"rejected","detail":"no text","at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/$ID.ack.json"
    continue
  fi
  TEXTS+=("$TEXT")
  printf '{"state":"steered","detail":"returned to Claude Code as additionalContext after a tool call","at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/$ID.ack.json"
done
[ ${#TEXTS[@]} -gt 0 ] || exit 0

CONTEXT="The coordinator sent this while you were working. It is meant for the task you are working on now:"
for TEXT in "${TEXTS[@]}"; do
  CONTEXT="$CONTEXT

$TEXT"
done
jq -cn --arg context "$CONTEXT" '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $context}}'
