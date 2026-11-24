#!/usr/bin/env bash
# scripts/hermes.sh: give woowtechbot's Hermes engine a model account, for the host administrator.
#
#   scripts/hermes.sh status                  the model and the sign-ins Hermes has (never a key)
#   scripts/hermes.sh chatgpt [MODEL]         sign in with a ChatGPT account: shows an address and a
#                                             code to approve in a browser (15 minutes), then uses MODEL
#   scripts/hermes.sh key PROVIDER MODEL      an API key, asked for without showing it (openrouter, ...)
#   scripts/hermes.sh model PROVIDER MODEL    use another model
#   scripts/hermes.sh logout PROVIDER         forget a sign-in or key
#   scripts/hermes.sh run ARGUMENT...         any other hermes command, for example: run setup
#
# It runs Hermes' own commands in the container as the bots' account, so the account is kept where
# the engine reads it: ~/.hermes in the data volume. Until Hermes has a model, the app offers none.
# Hermes does not use the sign-ins of the Claude and Codex engines (/etc/hermes/config.yaml).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=common.sh
. "$REPO/scripts/common.sh"
CHATGPT_MODEL=gpt-6.2-sol # what a ChatGPT account was tested with; others may be refused (HTTP 400)

command=${1:-}
(($# == 0)) || shift
case $command in
  status | chatgpt | key | model | logout | run) ;;
  -h | --help | '') sed -n '2,14p' "$0"; exit 0 ;;
  *) ql_die "unknown command $command (see --help)" ;;
esac
ql_require_rootless
[[ $(podman inspect --format '{{.State.Running}}' woowtechbot 2>/dev/null) == true ]] \
  || ql_die "the woowtechbot container is not running (systemctl --user start woowtechbot.service)"
tty=()
[[ -t 0 && -t 1 ]] && tty=(-t)
bot() { podman exec -i "${tty[@]}" -u maus -e HOME=/data -w /data woowtechbot "$@"; }
name() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]] || ql_die "not a name: $1"; }
need() { (($1 == $2)) || ql_die "wrong number of arguments (see --help)"; }

# use PROVIDER MODEL: Hermes' default model, and the app's list of it
use() {
  name "$1"; name "$2"
  bot hermes config set model.provider "$1" >/dev/null
  bot hermes config set model.default "$2" >/dev/null
  refresh
  ql_info "Hermes uses $2 ($1); choose Hermes for a bot in the app"
}
refresh() {
  podman exec -i woowtechbot node - <<'NODE' || ql_warn "the app did not refresh its Hermes models yet; it does so by itself later"
fetch('http://127.0.0.1:8799/api/instances/hermes/refresh-models', { method: 'POST', body: '{}',
  headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(90000) })
  .then(res => process.exit(res.ok ? 0 : 1), () => process.exit(1));
NODE
}

case $command in
  status) need $# 0; bot hermes status; bot hermes auth list ;;
  chatgpt)
    (($# <= 1)) || need $# 1
    bot hermes auth add openai-codex --no-browser
    use openai-codex "${1:-$CHATGPT_MODEL}" ;;
  key)
    need $# 2; name "$1"; name "$2"
    [[ ${#tty[@]} != 0 ]] || ql_die "run this in a terminal; the key is asked for there"
    bot hermes auth add "$1" --type api-key
    use "$1" "$2" ;;
  model) need $# 2; use "$1" "$2" ;;
  logout)
    need $# 1; name "$1"
    bot hermes auth logout "$1"
    refresh ;;
  run) bot hermes "$@" ;;
esac
