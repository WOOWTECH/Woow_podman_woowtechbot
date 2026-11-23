# shellcheck shell=bash
# scripts/render-args.sh: values computed from ~/.config/woowtechbot/woowtechbot.env. Sourced by
# scripts/install.sh and tests/dryrun.sh, so CI renders exactly what a host gets.
#
# render_args <envfile>: QL_ENV is already loaded from <envfile>; sets RENDER_ARGS=(KEY=VALUE...) and
# validates the values that are rendered straight from the env file.
#
# Secret= lines are rendered for the optional credentials that exist as podman secrets on this
# host (mounted root-only: the bots run as the image's maus user and must not read them). The
# test-only knob WTB_RENDER_ASSUME_SECRETS=all renders every line without asking podman, so CI can
# check the syntax; on a host, a secret that does not exist would stop the container from starting.
render_args() {
  local bind port pport prefix version image published secret lines=''
  bind=$(ql_env_get WOOW_WTB_BIND)
  ql_assert_match WOOW_WTB_BIND "$bind" 'all|[0-9]{1,3}(\.[0-9]{1,3}){3}'
  port=$(ql_env_get WOOW_WTB_PORT)
  ql_assert_match WOOW_WTB_PORT "$port" '[1-9][0-9]{0,4}'
  ((port <= 65535)) || ql_die "WOOW_WTB_PORT: $port is not a TCP port"
  pport=$(ql_env_get WOOW_WTB_PUBLISHED_PORT 18781)
  ql_assert_match WOOW_WTB_PUBLISHED_PORT "$pport" '[1-9][0-9]{0,4}'
  ((pport <= 65535)) || ql_die "WOOW_WTB_PUBLISHED_PORT: $pport is not a TCP port"
  ((pport != port)) || ql_die "WOOW_WTB_PUBLISHED_PORT must differ from WOOW_WTB_PORT"
  ql_assert_match WOOW_WTB_MEMORY "$(ql_env_get WOOW_WTB_MEMORY)" '[0-9]+[bkmgBKMG]?'
  ql_assert_match WOOW_WTB_CPUS "$(ql_env_get WOOW_WTB_CPUS)" '[0-9]+(\.[0-9]+)?'
  ql_assert_match WOOW_WTB_PIDS_LIMIT "$(ql_env_get WOOW_WTB_PIDS_LIMIT)" '[1-9][0-9]{2,5}'
  # "all" publishes on every address family (IPv4 and IPv6): omit the host IP.
  if [[ $bind == all ]]; then prefix=''; else prefix="$bind:"; fi
  version=$(<"$REPO/VERSION")
  image=localhost/woowtechbot-podman:$version
  published=''
  [[ -z $(ql_env_get WTB_PUBLISHED_URL "") ]] || published="PublishPort=$prefix$pport:8081"
  for secret in woowtechbot-signin-relay-token woowtechbot-signin-access-client-secret \
    woowtechbot-apporo-odoo-mcp-url woowtechbot-woow-prod-odoo-mcp-url; do
    if [[ $(ql_env_get WTB_RENDER_ASSUME_SECRETS "") == all ]] || podman secret exists "$secret" 2>/dev/null; then
      lines+="Secret=$secret,type=mount,uid=0,gid=0,mode=0400"$'\n'
    fi
  done
  # shellcheck disable=SC2034 # RENDER_ARGS is read by the caller
  RENDER_ARGS=("WTB_IMAGE=$image" "WTB_PUBLISH=$prefix$port" "WTB_PUBLISH_PUBLISHED=$published"
    "WTB_SECRET_LINES=${lines%$'\n'}")
}
