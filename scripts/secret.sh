#!/usr/bin/env bash
# scripts/secret.sh: the optional woowtechbot credentials, kept as podman secrets (never in the env
# file, argv, logs or the data volume). Inside the container they are readable by root only, so the
# bots, which run as the image's maus user, cannot read them; the HA add-on keeps them away from
# the bots in the same way.
#
#   scripts/secret.sh list           which secrets exist (never their values)
#   scripts/secret.sh set <name>     read the value from stdin (hidden when typed on a terminal)
#   scripts/secret.sh clear <name>   remove it
#
#   names: signin-relay-token            the company sign-in mail relay token (wtbha1.<id>.<key>)
#          signin-access-client-secret   Cloudflare Access client secret for that relay (optional)
#          apporo-odoo-mcp-url           Apporo Odoo read-only MCP private URL (optional)
#          woow-prod-odoo-mcp-url        woow_prod Odoo read-only MCP private URL (optional)
#
# Then run scripts/install.sh again: it mounts the secrets that exist, checks them and restarts
# woowtechbot.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=common.sh
. "$REPO/scripts/common.sh"

usage() { sed -n '2,20p' "$0"; }
command=${1:-}
name=${2:-}
case $command in
  list | set | clear) ;;
  -h | --help | '') usage; exit 0 ;;
  *) ql_die "unknown command $command (see --help)" ;;
esac
ql_require_rootless

if [[ $command == list ]]; then
  for s in "${WTB_SECRETS[@]}"; do
    if podman secret exists "$s"; then printf 'set    %s\n' "${s#woowtechbot-}"; else printf 'unset  %s\n' "${s#woowtechbot-}"; fi
  done
  exit 0
fi

secret=woowtechbot-$name
printf '%s\n' "${WTB_SECRETS[@]}" | grep -qxF -- "$secret" || ql_die "unknown secret name '$name' (see --help)"
ql_lock "$APP"
if [[ $command == clear ]]; then
  if podman secret exists "$secret"; then
    podman secret rm "$secret" >/dev/null
    ql_info "removed $secret"
  else
    ql_info "$secret was not set"
  fi
else
  value=''
  if [[ -t 0 ]]; then
    read -r -s -p "value for $name (hidden): " value
    printf '\n' >&2
  else
    IFS= read -r value || [[ -n $value ]]
  fi
  [[ -n $value ]] || ql_die "empty value; nothing was changed"
  case $name in
    signin-relay-token)
      [[ $value =~ ^(wtb1|wtbha1)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$ ]] \
        || ql_die "that is not a sign-in relay token (expected wtbha1.<id>.<key>); nothing was changed" ;;
    *-odoo-mcp-url)
      [[ $value =~ ^https://[A-Za-z0-9.-]+/private_[A-Za-z0-9_-]+/mcp$ ]] \
        || ql_die "expected the dedicated https://<host>/private_.../mcp URL; nothing was changed" ;;
    signin-access-client-secret)
      [[ $value =~ ^[[:graph:]]{1,2048}$ ]] || ql_die "invalid Cloudflare Access client secret; nothing was changed" ;;
  esac
  # shellcheck disable=SC2034 # read by ql_secret_ensure through env:WTB_SECRET_VALUE
  WTB_SECRET_VALUE=$value
  unset value
  ql_secret_ensure "$secret" env:WTB_SECRET_VALUE --update
  unset WTB_SECRET_VALUE
fi
# The unit may not change (the Secret= line can already be there), so ask for the restart.
if [[ -d $(app_state_dir) ]]; then ql_mark_changed "$APP" woowtechbot.service; fi
ql_info "run scripts/install.sh to apply it"
