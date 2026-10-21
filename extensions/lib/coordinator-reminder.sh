#!/bin/bash
# After a compaction, an agent that coordinates workers (agents-app-control) gets its coordinator
# protocol back as context; any other pane gets nothing. Prints the SessionStart hook output that
# Claude Code and Codex add to the conversation.
[ -n "${TMUX_PANE:-}" ] || exit 0
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v tmux >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || exit 0

FIELDS=$(tmux display-message -p -t "$TMUX_PANE" '#{@agents_role}|#{@agents_uuid}|#{@agents_program}' 2>/dev/null) || exit 0
IFS='|' read -r ROLE UUID PROGRAM <<<"$FIELDS"
[ "$ROLE" = "coordinator" ] && [ -n "$UUID" ] && [ -n "$PROGRAM" ] || exit 0

# The coordinator's own CLI, which agents-app-control writes when it promotes or spawns.
CLI="$PROGRAM/bin/coordinator-${UUID:0:8}"
[ -x "$CLI" ] || exit 0
TEXT=$("$CLI" agent protocol --json 2>/dev/null | jq -r '.result.text // empty' 2>/dev/null)
[ -n "$TEXT" ] || exit 0
jq -n --arg text "$TEXT" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $text}}'
