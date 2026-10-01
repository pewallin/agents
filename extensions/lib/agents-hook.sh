# Shared by the shell hook scripts (source it; needs bash).
#
# Hooks run with whatever environment the agent gives them, often not the shell's: a PATH
# without nvm, or a node that cannot start (for example Homebrew's node after a missing
# library). So the CLI is not found through PATH alone and failures are not thrown away:
#
#   - `agents setup` records the node it ran with and its cli.js in hook-runtime.env. That
#     node is only the first choice: if it is gone (a removed nvm version) or crashes, the
#     next candidate is tried (PATH, nvm's newest install, Homebrew, /usr/local).
#   - stdout is discarded (some agents add hook output to the conversation); stderr and the
#     exit code of a failed report go to <agents home>/logs/hooks.log.

agents_hook_home() {
  if [ -n "${AGENTS_HOME:-}" ]; then
    printf '%s\n' "$AGENTS_HOME"
  else
    printf '%s/%s\n' "${AGENTS_SHARED_HOME:-$HOME/.agents}" "${AGENTS_PRODUCT_DIRNAME:-agents-app}"
  fi
}

agents_hook_log() {
  local dir file
  dir="${AGENTS_LOG_DIR:-$(agents_hook_home)/logs}"
  mkdir -p "$dir" 2>/dev/null || return 0
  file="$dir/hooks.log"
  if [ -f "$file" ] && [ "$(wc -c < "$file" | tr -d ' ')" -gt 262144 ]; then
    mv -f "$file" "$file.1" 2>/dev/null || true
  fi
  printf '%s %s exit=%s cmd=%s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" \
    "$(printf '%s' "$4" | tr '\n' ' ' | cut -c1-600)" >> "$file" 2>/dev/null || true
}

# Candidate node binaries, best first, one per line, without duplicates.
agents_hook_node_candidates() {
  local seen="" candidate newest
  {
    [ -n "${AGENTS_HOOK_NODE:-}" ] && printf '%s\n' "$AGENTS_HOOK_NODE"
    command -v node 2>/dev/null || true
    newest="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V 2>/dev/null | tail -n 1)"
    [ -n "$newest" ] && printf '%s\n' "$newest"
    printf '%s\n' /opt/homebrew/bin/node /usr/local/bin/node
  } | while IFS= read -r candidate; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    case " $seen " in *" $candidate "*) continue ;; esac
    seen="$seen $candidate"
    printf '%s\n' "$candidate"
  done
}

agents_hook_cli_path() {
  if [ -n "${AGENTS_HOOK_CLI:-}" ] && [ -f "$AGENTS_HOOK_CLI" ]; then
    printf '%s\n' "$AGENTS_HOOK_CLI"
    return 0
  fi
  local repo_dir
  repo_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
  [ -f "$repo_dir/dist/cli.js" ] && printf '%s\n' "$repo_dir/dist/cli.js"
}

# A failure that says nothing about the report itself: the program could not run.
agents_hook_could_not_run() {
  [ "$1" -eq 126 ] || [ "$1" -eq 127 ] || [ "$1" -ge 128 ]
}

# The CLI runs tmux to verify the reporting pane; a bare PATH would not find it.
agents_hook_extend_path() {
  local dir
  for dir in /opt/homebrew/bin /usr/local/bin; do
    case ":$PATH:" in *":$dir:"*) ;; *) [ -d "$dir" ] && PATH="$PATH:$dir" ;; esac
  done
  export PATH
}

# agents_hook_run <agent> <agents CLI arguments...>
agents_hook_run() {
  local agent="$1" runtime cli node err status tried=0
  shift
  agents_hook_extend_path
  runtime="$(agents_hook_home)/hook-runtime.env"
  # shellcheck disable=SC1090
  [ -r "$runtime" ] && . "$runtime"
  cli="$(agents_hook_cli_path)"
  if [ -n "$cli" ]; then
    while IFS= read -r node; do
      tried=1
      err="$("$node" "$cli" "$@" 2>&1 >/dev/null)"
      status=$?
      [ "$status" -eq 0 ] && return 0
      agents_hook_log "$agent" "$status" "$node $cli" "$err"
      agents_hook_could_not_run "$status" || return 0
    done < <(agents_hook_node_candidates)
  fi
  # Last resort: an `agents` wrapper on PATH.
  local wrapper
  wrapper="$(command -v agents 2>/dev/null || true)"
  [ -z "$wrapper" ] && [ -x "$HOME/.local/bin/agents" ] && wrapper="$HOME/.local/bin/agents"
  if [ -n "$wrapper" ]; then
    err="$("$wrapper" "$@" 2>&1 >/dev/null)"
    status=$?
    [ "$status" -ne 0 ] && agents_hook_log "$agent" "$status" "$wrapper" "$err"
    return 0
  fi
  [ "$tried" -eq 0 ] && agents_hook_log "$agent" 127 "-" "agents CLI not found (no cli.js and no agents on PATH)"
  return 0
}

# Checks what a report would run, for `agents doctor`: one line per node tried,
# "ok <node> <cli>" or "fail <node> <first line of the error>". Exits 0 when one starts.
agents_hook_probe() {
  local runtime cli node err
  agents_hook_extend_path
  runtime="$(agents_hook_home)/hook-runtime.env"
  # shellcheck disable=SC1090
  [ -r "$runtime" ] && . "$runtime"
  cli="$(agents_hook_cli_path)"
  if [ -z "$cli" ]; then
    printf 'fail - no cli.js (run agents setup)\n'
    return 1
  fi
  while IFS= read -r node; do
    if err="$("$node" "$cli" --version 2>&1)"; then
      printf 'ok %s %s\n' "$node" "$cli"
      return 0
    fi
    printf 'fail %s %s\n' "$node" "$(printf '%s' "$err" | head -n 1 | cut -c1-200)"
  done < <(agents_hook_node_candidates)
  printf 'fail - no node starts\n'
  return 1
}
