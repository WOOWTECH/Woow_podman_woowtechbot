#!/usr/bin/env bash
# scripts/pair.sh: one-time pairing codes for woowtechbot, for the host administrator.
#
#   scripts/pair.sh browser            a browser code and link (10 minutes, works once)
#   scripts/pair.sh phone              the phone app's QR, server address and code (needs WTB_PUBLIC_URL)
#   scripts/pair.sh list               codes not used yet
#   scripts/pair.sh cancel browser|phone|all
#   add --json for machine-readable output
#
# Only someone who can run podman as this account can use it: on this edition that account is the
# administrator, as an HA administrator is on HA. A new code of a kind revokes this tool's earlier
# unused code of that kind; signed-in devices are never signed out by it. Codes are printed only to
# this terminal and never logged.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=common.sh
. "$REPO/scripts/common.sh"
case ${1:-} in
  browser | phone | list | cancel) ;;
  -h | --help | '') sed -n '2,15p' "$0"; exit 0 ;;
  *) ql_die "unknown command ${1} (see --help)" ;;
esac
ql_require_rootless
[[ $(podman inspect --format '{{.State.Running}}' woowtechbot 2>/dev/null) == true ]] \
  || ql_die "the woowtechbot container is not running (systemctl --user start woowtechbot.service)"
local_origin=''
if [[ -f $ENV_FILE ]]; then
  QL_ENV_MODE_CHECK=0 ql_env_load "$ENV_FILE"
  local_origin="http://$(app_local_host "$(ql_env_get WOOW_WTB_BIND)"):$(ql_env_get WOOW_WTB_PORT)"
fi
tty=()
[[ -t 1 ]] && tty=(-t)
exec podman exec -i "${tty[@]}" woowtechbot node /opt/woowtechbot-podman/pair.cjs "$@" --local-origin "$local_origin"
