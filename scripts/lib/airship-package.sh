# Shared by scripts/deploy-airship-package.sh and its test (sourced, bash 3.2 compatible).

# cb_package_unit <file>: prints a hub unit from deploy/airship as it runs a package instead of a checkout, so the
# two can't drift apart on hardening.
cb_package_unit() {
  local bin=/opt/crystal-bridge/current/node_modules/.bin/crystal-bridge-airship
  sed -E \
    -e 's|^WorkingDirectory=.*|WorkingDirectory=/var/lib/airship|' \
    -e "s|^ExecStart=.*backup-cli.*|ExecStart=$bin backup|" \
    -e "s|^ExecStart=.*main\.ts.*|ExecStart=$bin|" \
    -e 's|^ExecStartPost=.*|ExecStartPost=/opt/crystal-bridge/current/push-backups.sh|' \
    "$1"
}
