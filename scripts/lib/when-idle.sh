# Sourced by scripts/deploy-crystal-macos.sh for --when-idle (bash 3.2 compatible).
#
# A Quest on this Mac can't deploy this Mac's Crystal itself: the deploy waits for every session to be idle, and the
# Quest's own turn is a session. So --when-idle hands the deploy to a one-off launchd job instead. That job is
# separate from the Crystal job (launchd kills a job's whole process group when it restarts it), so it survives the
# restart it causes. It deploys the commit pinned when it was scheduled, from a temporary worktree, waiting up to an
# hour for sessions to go idle; then it removes its worktree, its plist and itself.

# cb_schedule_when_idle <node-id> <dry-run yes|no>
cb_schedule_when_idle() {
  local node=$1 dry_run=$2
  if [[ $cb_rollback == yes ]]; then
    echo "deploy: --when-idle doesn't take --rollback; run the rollback from a terminal" >&2
    exit 2
  fi
  # The pushed main (or, with --branch, the checked-out commit), pinned now so later checkouts don't change it.
  cb_require_shippable
  local repo pinned label agents logs work waiter plist log
  repo=$(pwd)
  pinned=$(git rev-parse HEAD)
  label=dev.crystal-bridge.deploy-when-idle
  [[ $dry_run == yes ]] && label=$label.dry-run
  agents=$HOME/Library/LaunchAgents
  logs=$HOME/Library/Logs/crystal-bridge
  work=$HOME/.local/share/crystal-bridge/when-idle
  waiter=$work/$label.sh
  plist=$agents/$label.plist
  log=$logs/deploy.log
  mkdir -p "$agents" "$logs" "$work"

  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    echo "deploy: a deploy is already scheduled ($label); watch $log, or cancel it with:" >&2
    echo "deploy:   launchctl bootout gui/$(id -u)/$label; rm -f $plist" >&2
    exit 1
  fi

  # The deploy it runs: the same arguments, pinned (--branch, since main may move on before it runs).
  local pass=("${cb_args[@]}" --branch)
  [[ $cb_force == yes ]] && pass+=(--force)

  {
    echo '#!/bin/bash'
    echo '# Written by deploy-crystal-macos.sh --when-idle; runs once under launchd, then removes itself.'
    printf 'repo=%q\npinned=%q\nlabel=%q\nplist=%q\nwaiter=%q\ndry_run=%q\n' \
      "$repo" "$pinned" "$label" "$plist" "$waiter" "$dry_run"
    printf 'pass=(%s)\n' "$(printf '%q ' "${pass[@]}")"
    cat <<'WAITER'
set -uo pipefail
echo "deploy: $(date '+%F %T') when-idle waiter started for ${pinned:0:12}"
tree=$(mktemp -d)/crystal-bridge
if git -C "$repo" worktree add -q --detach "$tree" "$pinned"; then
  if [[ $dry_run == yes ]]; then
    echo "deploy: dry run: would run in $tree: CRYSTAL_DRAIN_SECONDS=3600 scripts/deploy-crystal-macos.sh ${pass[*]}"
    status=0
  else
    (cd "$tree" && CRYSTAL_DRAIN_SECONDS=3600 scripts/deploy-crystal-macos.sh "${pass[@]}")
    status=$?
  fi
  git -C "$repo" worktree remove --force "$tree"
else
  status=1
fi
echo "deploy: $(date '+%F %T') when-idle waiter finished with status $status"
rm -f "$plist" "$waiter"
# Last: unloading this job ends this process too.
launchctl bootout "gui/$(id -u)/$label"
WAITER
  } >"$waiter"
  chmod 700 "$waiter"

  # launchd's environment plus this shell's PATH (node, pnpm, claude, git) and ssh agent, for reaching the Airship.
  # No CRYSTAL_* variables reach it, so the deploy doesn't mistake it for a Quest.
  local ssh_agent=''
  if [[ -n ${SSH_AUTH_SOCK:-} ]]; then
    ssh_agent="
    <key>SSH_AUTH_SOCK</key>
    <string>$SSH_AUTH_SOCK</string>"
  fi
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$waiter</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH</string>
    <key>HOME</key>
    <string>$HOME</string>$ssh_agent
  </dict>
  <key>StandardOutPath</key>
  <string>$log</string>
  <key>StandardErrorPath</key>
  <string>$log</string>
</dict>
</plist>
PLIST
  plutil -lint "$plist" >/dev/null
  launchctl bootstrap "gui/$(id -u)" "$plist"

  echo "deploy: scheduled ${pinned:0:12} for node \"$node\"$([[ $dry_run == yes ]] && echo ' (dry run)') as launchd job $label."
  echo "deploy: it waits until no session on this Mac is busy (up to an hour), deploys, then removes itself."
  echo "deploy: watch: tail -f $log"
}
