#!/bin/bash
# launchd entry point for Crystal on macOS (installed by scripts/deploy-crystal-macos.sh). launchd can't read an
# env file, so this loads ~/.config/crystal-bridge/crystal.env, then runs the current release.
set -euo pipefail
set -a
# shellcheck disable=SC1091
source "$HOME/.config/crystal-bridge/crystal.env"
set +a
cd "$HOME/.local/share/crystal-bridge/current/apps/crystal"
exec ../../node_modules/.bin/tsx src/main.ts
