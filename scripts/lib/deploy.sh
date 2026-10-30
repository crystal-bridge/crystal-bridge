# Shared by the deploy scripts (sourced, bash 3.2 compatible).
# Flags, anywhere among the arguments:
#   --branch    ship the checked-out commit even though it isn't the pushed main (for trying a branch on purpose)
#   --rollback  don't ship: switch the host to its most recent other kept release and restart (so a second
#               --rollback undoes the first)
#   --force     Crystal only: restart without waiting for sessions to finish their turn
cb_args=()
cb_branch=no
cb_rollback=no
cb_force=no

cb_parse() {
  local arg
  for arg in "$@"; do
    case $arg in
      --branch) cb_branch=yes ;;
      --rollback) cb_rollback=yes ;;
      --force) cb_force=yes ;;
      --*) echo "deploy: unknown flag $arg" >&2; exit 2 ;;
      *) cb_args+=("$arg") ;;
    esac
  done
}

# Production gets the pushed main and nothing else, unless --branch says otherwise on purpose.
cb_require_shippable() {
  cd "$(git rev-parse --show-toplevel)"
  if [[ -n $(git status --porcelain) ]]; then
    echo "deploy: commit or stash your changes first; only HEAD is shipped" >&2
    exit 1
  fi
  if [[ $cb_branch == yes ]]; then
    echo "deploy: --branch: shipping $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD), not main" >&2
    return
  fi
  git fetch -q origin main
  if [[ $(git rev-parse HEAD) != $(git rev-parse origin/main) ]]; then
    echo "deploy: HEAD isn't the pushed main (origin/main is $(git rev-parse --short origin/main))." >&2
    echo "deploy: check out main and pull, or pass --branch to ship this commit on purpose" >&2
    exit 1
  fi
}

# Remote helper, as text to paste into a remote script: prints the newest release other than the current one.
CB_PREVIOUS_RELEASE='previous_release() {
  local base=$1 current r
  current=$(readlink -f "$base/current")
  for r in $(ls -1dt "$base"/releases/*); do
    if [[ $(readlink -f "$r") != "$current" ]]; then echo "$r"; return 0; fi
  done
  return 1
}'
