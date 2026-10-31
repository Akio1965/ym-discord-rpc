#!/usr/bin/env bash
# Installs ym-discord-rpc as a systemd --user service.
#
# Fills the two placeholders of packaging/ym-discord-rpc.service with the absolute path of node and of
# this repository, writes the result to ~/.config/systemd/user/ym-discord-rpc.service, then runs
#   systemctl --user daemon-reload
#   systemctl --user enable ym-discord-rpc.service
#   systemctl --user restart ym-discord-rpc.service
#
# Usage:
#   scripts/install-service.sh              install (or update) and (re)start the service
#   scripts/install-service.sh --no-start   only write the unit file and print the systemctl commands
#   NODE=/usr/bin/node scripts/install-service.sh   use a specific node binary instead of `command -v node`
#
# Run it again after moving the repository or switching to another node version.
set -euo pipefail

readonly UNIT_NAME=ym-discord-rpc.service
readonly NODE_PLACEHOLDER='/ПУТЬ/К/node'
readonly REPO_PLACEHOLDER='/ПУТЬ/К/ym-discord-rpc'
readonly MIN_NODE_MAJOR=24

die() {
  printf 'install-service: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'install-service: warning: %s\n' "$*" >&2
}

# Paths go into a unit file; these characters would need escaping rules we do not want to guess at.
check_path() {
  case $1 in
    *[\"\\]* | *$'\n'*) die "unsupported character (\" \\ or newline) in path: $1 — edit the unit by hand, see README.md" ;;
  esac
}

# One whole double-quoted ExecStart= item: systemd expands %specifiers and $VARIABLES there.
exec_item() {
  local s=$1
  s=${s//[%]/%%}
  s=${s//[\$]/\$\$}
  printf '"%s"' "$s"
}

# render_unit TEMPLATE NODE REPO: prints the unit with both placeholders filled in.
render_unit() {
  local template=$1 node=$2 repo=$3 line
  local node_item repo_item workdir
  node_item=$(exec_item "$node")
  repo_item=$(exec_item "$repo/src/main.ts")
  workdir=${repo//[%]/%%}
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      ExecStart=*)
        line=${line//"$REPO_PLACEHOLDER/src/main.ts"/"$repo_item"}
        line=${line//"$NODE_PLACEHOLDER"/"$node_item"}
        ;;
      WorkingDirectory=*)
        line=${line//"$REPO_PLACEHOLDER"/"$workdir"}
        ;;
    esac
    printf '%s\n' "$line"
  done <"$template"
}

main() {
  local start=1
  case ${1:-} in
    '') ;;
    --no-start) start=0 ;;
    -h | --help)
      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      return 0
      ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac

  local repo template unit_dir unit node node_bin major
  repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
  template="$repo/packaging/$UNIT_NAME"
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  unit="$unit_dir/$UNIT_NAME"

  [[ -f $template ]] || die "template not found: $template"
  [[ -f $repo/src/main.ts ]] || die "src/main.ts not found in $repo"
  [[ -d $repo/node_modules/@jellybrick/dbus-next ]] || die "dependencies are missing: run 'npm ci' in $repo first"

  node=${NODE:-$(command -v node || true)}
  [[ -n $node ]] || die "node not found in PATH; install Node.js >= $MIN_NODE_MAJOR or set NODE=/path/to/node"
  # Resolves version-manager shims to the real binary, which works without a shell.
  node_bin=$("$node" -p 'process.execPath') || die "cannot run $node"
  major=$("$node_bin" -p 'process.versions.node.split(".")[0]')
  ((major >= MIN_NODE_MAJOR)) || die "Node.js >= $MIN_NODE_MAJOR is required, $node_bin is $("$node_bin" -v)"
  check_path "$node_bin"
  check_path "$repo"

  mkdir -p -- "$unit_dir"
  # Global on purpose: the EXIT trap must see it even when die() exits from a nested function.
  tmp=$(mktemp "$unit_dir/.$UNIT_NAME.XXXXXX")
  trap 'rm -f -- "$tmp"' EXIT
  render_unit "$template" "$node_bin" "$repo" >"$tmp"
  # The header comments name the placeholders on purpose and are kept as they are; only settings must be filled in.
  # No grep -q: an early exit could SIGPIPE the first grep and, with pipefail, hide a match.
  if grep -v '^[[:space:]]*[#;]' "$tmp" | grep 'ПУТЬ/К' >&2; then
    die "a placeholder is left in the rendered unit (see above); was $template edited?"
  fi
  chmod 644 -- "$tmp"
  mv -f -- "$tmp" "$unit"
  trap - EXIT
  printf 'wrote %s\n  node: %s\n  repo: %s\n' "$unit" "$node_bin" "$repo"

  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze --user verify "$unit" || warn "systemd-analyze reported problems with $unit (see above)"
  fi

  local config="${XDG_CONFIG_HOME:-$HOME/.config}/ym-discord-rpc/config.json"
  if [[ ! -f $config ]]; then
    warn "$config does not exist: without clientId the daemon runs in dry-run mode (README.md, 'Что нужно поменять')"
  fi
  if [[ $(systemctl --user is-active graphical-session.target 2>/dev/null || true) != active ]]; then
    warn "graphical-session.target is not active in this session, so the service will not start at login;" \
      "see README.md, 'Автозапуск', for using default.target instead"
  fi

  if ((start == 0)); then
    printf '\nNow run:\n  systemctl --user daemon-reload\n  systemctl --user enable --now %s\n' "$UNIT_NAME"
    return 0
  fi
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME"
  systemctl --user restart "$UNIT_NAME"
  printf '\n%s is enabled and running. Logs:\n  journalctl --user -u ym-discord-rpc -f\n' "$UNIT_NAME"
}

main "$@"
