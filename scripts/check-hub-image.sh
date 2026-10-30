#!/usr/bin/env bash
# Builds the hub image and runs it for real: not as root, login gate shut, a token that works and survives a restart.
set -euo pipefail
cd "$(dirname "$0")/.."
image=crystal-bridge-hub-check
name=crystal-bridge-hub-check
volume=crystal-bridge-hub-check
port=7796
base=http://127.0.0.1:$port
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start() {
  docker run -d --name "$name" -p "127.0.0.1:$port:7700" -v "$volume:/data" "$image" >/dev/null
  for _ in $(seq 1 60); do curl -sf "$base/api/health" >/dev/null && return 0; sleep 0.5; done
  docker logs "$name" >&2
  echo 'check: the hub did not come up' >&2
  exit 1
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

docker build --quiet -t "$image" . >/dev/null
start
[[ $(docker exec "$name" id -u) != 0 ]] || { echo 'check: the hub runs as root' >&2; exit 1; }
[[ $(status "$base/") == 200 ]] || { echo 'check: the web app did not load' >&2; exit 1; }
[[ $(status "$base/api/sessions") == 403 ]] || { echo 'check: the API answered without a login' >&2; exit 1; }
token=$(docker exec "$name" crystal-bridge-airship token add ci | grep -E '^[A-Za-z0-9_-]{43}$')
[[ $(status -H "Authorization: Bearer $token" "$base/api/sessions") == 200 ]] ||
  { echo 'check: a good token was refused' >&2; exit 1; }

docker rm -f "$name" >/dev/null
start
[[ $(status -H "Authorization: Bearer $token" "$base/api/sessions") == 200 ]] ||
  { echo 'check: the token did not survive a restart' >&2; exit 1; }
echo 'check: the hub image builds and runs'
