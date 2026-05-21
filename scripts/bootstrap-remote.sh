#!/usr/bin/env bash
set -euo pipefail

MODE="dry-run"
JSON_OUTPUT=0
WITH_TOOLS=1
MIN_TMUX_VERSION="${AGENTS_BOOTSTRAP_MIN_TMUX_VERSION:-3.3}"
MIN_AGENTS_VERSION="${AGENTS_BOOTSTRAP_MIN_AGENTS_VERSION:-1.0.0}"
EXPECTED_AGENTS_COMMIT="${AGENTS_BOOTSTRAP_EXPECTED_AGENTS_COMMIT:-}"
MIN_NODE_MAJOR="${AGENTS_BOOTSTRAP_MIN_NODE_MAJOR:-22}"
REPO_URL="${AGENTS_BOOTSTRAP_REPO_URL:-https://github.com/pewallin/agents.git}"
REPO_REF="${AGENTS_BOOTSTRAP_REF:-main}"
INSTALL_ROOT="${AGENTS_BOOTSTRAP_INSTALL_ROOT:-$HOME/.agents/agents-cli/source}"
WRAPPER_PATH="${AGENTS_BOOTSTRAP_BIN:-$HOME/.local/bin/agents}"
MANIFEST_PATH="${AGENTS_BOOTSTRAP_MANIFEST:-$HOME/.agents/agents-app/install.json}"

ACTION_IDS=()
ACTION_STATES=()
ACTION_SUMMARIES=()
ACTION_COMMANDS=()
ACTION_HANDLERS=()
ACTION_ARGS=()

usage() {
  cat <<'EOF'
Usage: bootstrap-remote.sh [--dry-run] [--yes] [--json] [--no-tools]

Prepares a remote host for Agents/AgentsNext.

Default mode is --dry-run. Use --yes to apply planned changes.

Options:
  --dry-run              Print the plan without changing the host (default)
  --yes                  Apply planned changes
  --json                 Print a machine-readable plan
  --with-tools           Include nvim, micro, lazygit, and yazi (default)
  --no-tools             Only manage tmux, node/git/npm, agents, and tmux startup
  --min-tmux-version V   Required tmux version (default: 3.3)
  --min-agents-version V Required agents version (default: 1.0.0)
  --expected-agents-commit SHA
                         Required agents git commit for app-managed installs
  --repo-url URL         Agents git repo (default: https://github.com/pewallin/agents.git)
  --ref REF              Git ref to checkout (default: main)
  --install-root PATH    Source checkout path (default: ~/.agents/agents-cli/source)
  --bin PATH             agents wrapper path (default: ~/.local/bin/agents)
  -h, --help             Show this help

Environment overrides use the AGENTS_BOOTSTRAP_* names shown in the script.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      MODE="dry-run"
      ;;
    --yes)
      MODE="apply"
      ;;
    --json)
      JSON_OUTPUT=1
      ;;
    --with-tools)
      WITH_TOOLS=1
      ;;
    --no-tools)
      WITH_TOOLS=0
      ;;
    --min-tmux-version)
      shift
      MIN_TMUX_VERSION="${1:?missing value for --min-tmux-version}"
      ;;
    --min-agents-version)
      shift
      MIN_AGENTS_VERSION="${1:?missing value for --min-agents-version}"
      ;;
    --expected-agents-commit)
      shift
      EXPECTED_AGENTS_COMMIT="${1:?missing value for --expected-agents-commit}"
      ;;
    --repo-url)
      shift
      REPO_URL="${1:?missing value for --repo-url}"
      ;;
    --ref)
      shift
      REPO_REF="${1:?missing value for --ref}"
      ;;
    --install-root)
      shift
      INSTALL_ROOT="${1:?missing value for --install-root}"
      ;;
    --bin)
      shift
      WRAPPER_PATH="${1:?missing value for --bin}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

shell_quote() {
  local value="$1"
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

json_escape() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf "%s" "$value"
}

normalize_version() {
  printf "%s" "$1" | sed -E 's/^[^0-9]*//; s/[^0-9.].*$//'
}

version_ge() {
  local have required h1 h2 h3 r1 r2 r3
  have="$(normalize_version "$1")"
  required="$(normalize_version "$2")"
  IFS=. read -r h1 h2 h3 _ <<<"$have"
  IFS=. read -r r1 r2 r3 _ <<<"$required"
  h1="${h1:-0}"; h2="${h2:-0}"; h3="${h3:-0}"
  r1="${r1:-0}"; r2="${r2:-0}"; r3="${r3:-0}"
  if [ "$h1" -gt "$r1" ]; then return 0; fi
  if [ "$h1" -lt "$r1" ]; then return 1; fi
  if [ "$h2" -gt "$r2" ]; then return 0; fi
  if [ "$h2" -lt "$r2" ]; then return 1; fi
  [ "$h3" -ge "$r3" ]
}

node_major() {
  node --version 2>/dev/null | sed -E 's/^v?([0-9]+).*/\1/' || true
}

agents_bin() {
  if [ -x "$WRAPPER_PATH" ]; then
    printf "%s" "$WRAPPER_PATH"
    return
  fi
  command -v agents 2>/dev/null || true
}

agents_version() {
  local bin
  bin="$(agents_bin)"
  if [ -z "$bin" ]; then
    return 0
  fi
  "$bin" --version 2>/dev/null | head -n 1 | sed -E 's/^[^0-9]*//; s/[^0-9.].*$//' || true
}

agents_commit() {
  if [ -d "$INSTALL_ROOT/.git" ]; then
    git -C "$INSTALL_ROOT" rev-parse HEAD 2>/dev/null || true
    return
  fi
  if [ -r "$MANIFEST_PATH" ]; then
    sed -nE 's/.*"gitCommit"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$MANIFEST_PATH" | head -n 1
  fi
}

commit_matches() {
  local have="$1"
  local expected="$2"
  if [ -z "$expected" ]; then
    return 0
  fi
  if [ -z "$have" ]; then
    return 1
  fi
  case "$have" in
    "$expected"*) return 0 ;;
  esac
  case "$expected" in
    "$have"*) return 0 ;;
  esac
  return 1
}

agents_install_command() {
  local clone_action="git clone/pull $(shell_quote "$REPO_URL") $(shell_quote "$INSTALL_ROOT")"
  if [ -n "$EXPECTED_AGENTS_COMMIT" ]; then
    printf "%s && git checkout %s && npm install && npm run build && write %s" \
      "$clone_action" \
      "$(shell_quote "$EXPECTED_AGENTS_COMMIT")" \
      "$(shell_quote "$WRAPPER_PATH")"
    return
  fi
  printf "%s && npm install && npm run build && write %s" \
    "$clone_action" \
    "$(shell_quote "$WRAPPER_PATH")"
}

tmux_version() {
  tmux -V 2>/dev/null | head -n 1 | sed -E 's/^tmux[[:space:]]+//' || true
}

add_action() {
  ACTION_IDS+=("$1")
  ACTION_STATES+=("$2")
  ACTION_SUMMARIES+=("$3")
  ACTION_COMMANDS+=("$4")
  ACTION_HANDLERS+=("$5")
  ACTION_ARGS+=("${6:-}")
}

brew_command_for() {
  local formula="$1"
  if brew list --versions "$formula" >/dev/null 2>&1; then
    printf "brew upgrade %s" "$(shell_quote "$formula")"
  else
    printf "brew install %s" "$(shell_quote "$formula")"
  fi
}

plan_brew_formula() {
  local id="$1"
  local binary="$2"
  local formula="$3"
  local label="$4"

  if has_cmd "$binary"; then
    add_action "$id" "ok" "$label is installed." "command -v $(shell_quote "$binary")" "noop"
    return
  fi

  if ! has_cmd brew; then
    add_action "$id" "blocked" "$label is missing and Homebrew is not installed." "Install Homebrew or install $label manually." "noop"
    return
  fi

  add_action "$id" "planned" "Install $label with Homebrew." "$(brew_command_for "$formula")" "brew-formula" "$formula"
}

plan_tmux() {
  local current
  if has_cmd tmux; then
    current="$(tmux_version)"
    if version_ge "$current" "$MIN_TMUX_VERSION"; then
      add_action "tmux" "ok" "tmux $current satisfies >= $MIN_TMUX_VERSION." "tmux -V" "noop"
      return
    fi

    if ! has_cmd brew; then
      add_action "tmux" "blocked" "tmux $current is older than required >= $MIN_TMUX_VERSION and Homebrew is not installed." "Install or upgrade tmux manually." "noop"
      return
    fi

    add_action "tmux" "planned" "Upgrade tmux from $current to >= $MIN_TMUX_VERSION." "$(brew_command_for tmux)" "brew-formula" "tmux"
    return
  fi

  if ! has_cmd brew; then
    add_action "tmux" "blocked" "tmux is missing and Homebrew is not installed." "Install Homebrew or install tmux manually." "noop"
    return
  fi

  add_action "tmux" "planned" "Install tmux >= $MIN_TMUX_VERSION." "$(brew_command_for tmux)" "brew-formula" "tmux"
}

plan_node() {
  local major
  if has_cmd node; then
    major="$(node_major)"
    if [ -n "$major" ] && [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      add_action "node" "ok" "node $(node --version) satisfies >= $MIN_NODE_MAJOR." "node --version" "noop"
      return
    fi
  fi

  if ! has_cmd brew; then
    add_action "node" "blocked" "node >= $MIN_NODE_MAJOR is missing and Homebrew is not installed." "Install Node.js >= $MIN_NODE_MAJOR manually." "noop"
    return
  fi

  add_action "node" "planned" "Install or upgrade Node.js for building agents." "$(brew_command_for node)" "brew-formula" "node"
}

plan_agents() {
  local current current_commit path_text
  current="$(agents_version)"
  current_commit="$(agents_commit)"
  if [ -n "$current" ] && version_ge "$current" "$MIN_AGENTS_VERSION"; then
    if ! commit_matches "$current_commit" "$EXPECTED_AGENTS_COMMIT"; then
      if ! has_cmd git && ! has_cmd brew; then
        add_action "agents" "blocked" "agents commit update needs git, and Homebrew is not installed to provide it." "Install git manually before updating agents." "noop"
        return
      fi
      if ! has_cmd npm && ! has_cmd brew; then
        add_action "agents" "blocked" "agents commit update needs npm, and Homebrew is not installed to provide Node.js/npm." "Install Node.js >= $MIN_NODE_MAJOR manually before updating agents." "noop"
        return
      fi
      add_action "agents" "planned" "Update agents commit from ${current_commit:-unknown} to $EXPECTED_AGENTS_COMMIT." "$(agents_install_command)" "install-agents"
      return
    fi
    path_text="$(agents_bin)"
    if [ -n "$EXPECTED_AGENTS_COMMIT" ]; then
      add_action "agents" "ok" "agents $current ($current_commit) is installed at $path_text." "agents --version" "noop"
    else
      add_action "agents" "ok" "agents $current is installed at $path_text." "agents --version" "noop"
    fi
    return
  fi

  if ! has_cmd git && ! has_cmd brew; then
    add_action "agents" "blocked" "agents install needs git, and Homebrew is not installed to provide it." "Install git manually before installing agents." "noop"
    return
  fi
  if ! has_cmd npm && ! has_cmd brew; then
    add_action "agents" "blocked" "agents install needs npm, and Homebrew is not installed to provide Node.js/npm." "Install Node.js >= $MIN_NODE_MAJOR manually before installing agents." "noop"
    return
  fi

  if [ -n "$current" ]; then
    if [ -n "$EXPECTED_AGENTS_COMMIT" ]; then
      add_action "agents" "planned" "Update agents from $current to >= $MIN_AGENTS_VERSION at commit $EXPECTED_AGENTS_COMMIT." "$(agents_install_command)" "install-agents"
    else
      add_action "agents" "planned" "Update agents from $current to >= $MIN_AGENTS_VERSION." "$(agents_install_command)" "install-agents"
    fi
  else
    if [ -n "$EXPECTED_AGENTS_COMMIT" ]; then
      add_action "agents" "planned" "Install agents >= $MIN_AGENTS_VERSION at commit $EXPECTED_AGENTS_COMMIT." "$(agents_install_command)" "install-agents"
    else
      add_action "agents" "planned" "Install agents >= $MIN_AGENTS_VERSION." "$(agents_install_command)" "install-agents"
    fi
  fi
}

plan_tmux_start() {
  if has_cmd tmux && tmux list-sessions >/dev/null 2>&1; then
    add_action "tmux-start" "ok" "tmux server is already running." "tmux list-sessions" "noop"
    return
  fi

  if ! has_cmd tmux && ! has_cmd brew; then
    add_action "tmux-start" "blocked" "tmux cannot be started until tmux is installed." "Install tmux manually, then run this script again." "noop"
    return
  fi

  add_action "tmux-start" "planned" "Start tmux with an agents session if no server is running." "tmux list-sessions >/dev/null 2>&1 || tmux new-session -d -s agents" "start-tmux"
}

plan_all() {
  plan_tmux
  plan_brew_formula "git" "git" "git" "git"
  plan_node
  if [ "$WITH_TOOLS" -eq 1 ]; then
    plan_brew_formula "nvim" "nvim" "neovim" "nvim"
    plan_brew_formula "micro" "micro" "micro" "micro"
    plan_brew_formula "lazygit" "lazygit" "lazygit" "lazygit"
    plan_brew_formula "yazi" "yazi" "yazi" "yazi"
  fi
  plan_agents
  plan_tmux_start
}

has_blockers() {
  local index
  for index in "${!ACTION_STATES[@]}"; do
    if [ "${ACTION_STATES[$index]}" = "blocked" ]; then
      return 0
    fi
  done
  return 1
}

has_planned_actions() {
  local index
  for index in "${!ACTION_STATES[@]}"; do
    if [ "${ACTION_STATES[$index]}" = "planned" ]; then
      return 0
    fi
  done
  return 1
}

print_human_plan() {
  echo "Agents remote bootstrap plan"
  echo
  local index
  for index in "${!ACTION_IDS[@]}"; do
    printf -- "- %s %s: %s\n" "${ACTION_STATES[$index]}" "${ACTION_IDS[$index]}" "${ACTION_SUMMARIES[$index]}"
    if [ "${ACTION_STATES[$index]}" != "ok" ]; then
      printf "  %s\n" "${ACTION_COMMANDS[$index]}"
    fi
  done
  echo
  if has_blockers; then
    echo "Blocked actions must be resolved manually before --yes can apply the full plan."
  elif has_planned_actions; then
    echo "Run again with --yes to apply this plan."
  else
    echo "Nothing to do."
  fi
}

print_json_plan() {
  local ok="true"
  if has_blockers; then
    ok="false"
  fi

  printf '{\n'
  printf '  "ok": %s,\n' "$ok"
  printf '  "mode": "%s",\n' "$(json_escape "$MODE")"
  printf '  "installRoot": "%s",\n' "$(json_escape "$INSTALL_ROOT")"
  printf '  "wrapperPath": "%s",\n' "$(json_escape "$WRAPPER_PATH")"
  printf '  "manifestPath": "%s",\n' "$(json_escape "$MANIFEST_PATH")"
  printf '  "actions": [\n'
  local index
  for index in "${!ACTION_IDS[@]}"; do
    printf '    { "id": "%s", "state": "%s", "summary": "%s", "command": "%s" }' \
      "$(json_escape "${ACTION_IDS[$index]}")" \
      "$(json_escape "${ACTION_STATES[$index]}")" \
      "$(json_escape "${ACTION_SUMMARIES[$index]}")" \
      "$(json_escape "${ACTION_COMMANDS[$index]}")"
    if [ "$index" -lt "$((${#ACTION_IDS[@]} - 1))" ]; then
      printf ','
    fi
    printf '\n'
  done
  printf '  ]\n'
  printf '}\n'
}

run_brew_formula() {
  local formula="$1"
  if brew list --versions "$formula" >/dev/null 2>&1; then
    brew upgrade "$formula"
  else
    brew install "$formula"
  fi
  hash -r
}

write_agents_wrapper() {
  mkdir -p "$(dirname "$WRAPPER_PATH")"
  {
    echo "#!/usr/bin/env sh"
    printf 'exec node %s "$@"\n' "$(shell_quote "$INSTALL_ROOT/dist/cli.js")"
  } >"$WRAPPER_PATH"
  chmod 755 "$WRAPPER_PATH"
}

write_agents_manifest() {
  local version installed_at git_commit
  version="$("$WRAPPER_PATH" --version 2>/dev/null | head -n 1 || true)"
  installed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  git_commit="$(git -C "$INSTALL_ROOT" rev-parse HEAD 2>/dev/null || true)"
  mkdir -p "$(dirname "$MANIFEST_PATH")"
  {
    printf '{\n'
    printf '  "manager": "agents-bootstrap",\n'
    printf '  "version": "%s",\n' "$(json_escape "$version")"
    printf '  "path": "%s",\n' "$(json_escape "$WRAPPER_PATH")"
    printf '  "sourceRoot": "%s",\n' "$(json_escape "$INSTALL_ROOT")"
    printf '  "repoUrl": "%s",\n' "$(json_escape "$REPO_URL")"
    printf '  "ref": "%s",\n' "$(json_escape "$REPO_REF")"
    printf '  "gitCommit": "%s",\n' "$(json_escape "$git_commit")"
    printf '  "installedAt": "%s"\n' "$(json_escape "$installed_at")"
    printf '}\n'
  } >"$MANIFEST_PATH"
}

install_agents() {
  if ! has_cmd git; then
    echo "git is required before installing agents." >&2
    return 1
  fi
  if ! has_cmd npm; then
    echo "npm is required before installing agents." >&2
    return 1
  fi

  if [ -d "$INSTALL_ROOT/.git" ]; then
    git -C "$INSTALL_ROOT" fetch origin --tags
  elif [ -e "$INSTALL_ROOT" ]; then
    echo "$INSTALL_ROOT exists but is not a git checkout." >&2
    return 1
  else
    mkdir -p "$(dirname "$INSTALL_ROOT")"
    git clone "$REPO_URL" "$INSTALL_ROOT"
  fi

  if git -C "$INSTALL_ROOT" show-ref --verify --quiet "refs/remotes/origin/$REPO_REF"; then
    git -C "$INSTALL_ROOT" checkout -B "$REPO_REF" "origin/$REPO_REF"
  else
    git -C "$INSTALL_ROOT" checkout "$REPO_REF"
  fi
  if [ -n "$EXPECTED_AGENTS_COMMIT" ]; then
    git -C "$INSTALL_ROOT" rev-parse --verify "$EXPECTED_AGENTS_COMMIT^{commit}" >/dev/null
    git -C "$INSTALL_ROOT" checkout "$EXPECTED_AGENTS_COMMIT"
  fi

  npm --prefix "$INSTALL_ROOT" install
  npm --prefix "$INSTALL_ROOT" run build
  write_agents_wrapper
  write_agents_manifest
}

start_tmux() {
  if tmux list-sessions >/dev/null 2>&1; then
    return 0
  fi
  tmux new-session -d -s agents
}

apply_plan() {
  if has_blockers; then
    print_human_plan >&2
    exit 2
  fi

  local index handler arg id
  for index in "${!ACTION_IDS[@]}"; do
    if [ "${ACTION_STATES[$index]}" != "planned" ]; then
      continue
    fi
    id="${ACTION_IDS[$index]}"
    handler="${ACTION_HANDLERS[$index]}"
    arg="${ACTION_ARGS[$index]}"
    printf "Applying %s...\n" "$id" >&2
    case "$handler" in
      brew-formula)
        run_brew_formula "$arg"
        ;;
      install-agents)
        install_agents
        ;;
      start-tmux)
        start_tmux
        ;;
      noop)
        ;;
      *)
        echo "Unknown action handler: $handler" >&2
        exit 2
        ;;
    esac
  done
}

plan_all

if [ "$MODE" = "dry-run" ]; then
  if [ "$JSON_OUTPUT" -eq 1 ]; then
    print_json_plan
  else
    print_human_plan
  fi
  exit 0
fi

apply_plan

if [ "$JSON_OUTPUT" -eq 1 ]; then
  ACTION_IDS=()
  ACTION_STATES=()
  ACTION_SUMMARIES=()
  ACTION_COMMANDS=()
  ACTION_HANDLERS=()
  ACTION_ARGS=()
  MODE="applied"
  plan_all
  print_json_plan
else
  echo "Agents remote bootstrap complete."
fi
