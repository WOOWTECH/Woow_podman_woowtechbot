# shellcheck shell=bash
# tests/dryrun.local.sh: woowtechbot assertions. Sourced at the end of tests/dryrun.sh (vendored),
# which provides run_variant, render_variant, $WORK, $REPO, $base, $failures.
# shellcheck disable=SC2154 # the variables above are defined by tests/dryrun.sh

check() { # check <description> <command...>
  if "${@:2}"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi
}
has_line() { grep -qxF -- "$3" "$WORK/$1/out/$2"; }
no_match() { ! grep -qE -- "$3" "$WORK/$1/out/$2"; }
unit=woowtechbot.container

check "example publishes only the entrance, on 127.0.0.1" has_line example $unit 'PublishPort=127.0.0.1:18799:8080'
check "example publishes no published-apps port" no_match example $unit '^PublishPort=.*:8081$'
check "HA Ingress (8099) and the owner API (8799) are never published" bash -c \
  "! grep -hE '^PublishPort=.*:(8099|8799)$' '$WORK'/*/out/$unit"
check "never host networking" bash -c "! grep -hE '^Network=(host|none)$' '$WORK'/*/out/$unit"
check "the private network is used" has_line example $unit 'Network=woowtechbot.network'
check "the options tmpfs is mounted" has_line example $unit 'Tmpfs=/run/woowtechbot:rw,mode=0700,size=1m'
check "example uses the default limits, without swap" has_line example $unit 'PodmanArgs=--memory=4g --memory-swap=4g --cpus=2'
check "the pids limit is rendered" has_line example $unit 'PidsLimit=4096'
check "a 512 MiB /dev/shm for Chromium" has_line example $unit 'PodmanArgs=--shm-size=512m'
existing=0
for s in signin-relay-token signin-access-client-secret apporo-odoo-mcp-url woow-prod-odoo-mcp-url android-push-credential; do
  if podman secret exists "woowtechbot-$s" 2>/dev/null; then existing=$((existing + 1)); fi
done
check "example mounts only the secrets this host has ($existing; none in CI)" test \
  "$(grep -c '^Secret=' "$WORK/example/out/$unit" || true)" = "$existing"
check "the image tag equals VERSION" has_line example $unit "Image=localhost/woowtechbot-podman:$(cat "$REPO/VERSION")"
check "a settings error (78) does not restart in a loop" has_line example $unit 'RestartPreventExitStatus=78'
check "BIND=all and the published-apps site are rendered" bash -c \
  "grep -qxF 'PublishPort=18799:8080' '$WORK/fixture-public/out/$unit' && grep -qxF 'PublishPort=18781:8081' '$WORK/fixture-public/out/$unit'"
check "per-host memory is rendered for both memory flags" has_line fixture-public $unit 'PodmanArgs=--memory=3g --memory-swap=3g --cpus=2'
check "the five optional secrets are root-only mounts" bash -c \
  "[[ \$(grep -cE '^Secret=woowtechbot-[a-z-]+,type=mount,uid=0,gid=0,mode=0400$' '$WORK/fixture-secrets/out/$unit') == 5 ]]"
check "the base image is pinned by digest" grep -qE '^WTB_BASE_IMAGE=ghcr\.io/woowtech/amd64-woowtechbot@sha256:[0-9a-f]{64}$' "$REPO/scripts/common.sh"

# The optional tunnel connectors (quadlet/optional, rendered in the example+optional variant).
opt=example+optional
for t in woowtechbot-tunnel woowtechbot-apps-tunnel; do
  check "$t: only its own token, readable by the image's user only" bash -c \
    "[[ \$(grep -c '^Secret=' '$WORK/$opt/out/$t.container') == 1 ]] && grep -qxF 'Secret=$t-token,type=mount,uid=65532,gid=65532,mode=0400' '$WORK/$opt/out/$t.container'"
  check "$t: publishes nothing and stays off the host network" no_match $opt $t.container '^(PublishPort=|Network=host)'
  check "$t: joins the bot's private network" has_line $opt $t.container 'Network=woowtechbot.network'
  check "$t: read-only, no new privileges, no capabilities" bash -c \
    "grep -qx 'ReadOnly=true' '$WORK/$opt/out/$t.container' && grep -qx 'NoNewPrivileges=true' '$WORK/$opt/out/$t.container' && grep -qx 'DropCapability=all' '$WORK/$opt/out/$t.container'"
  check "$t: the metrics port is loopback only" has_line $opt $t.container \
    "Exec=tunnel --metrics 127.0.0.1:20241 run --token-file /run/secrets/$t-token"
  check "$t: the image is pinned by digest" bash -c \
    "grep -qE '^Image=docker\.io/cloudflare/cloudflared:[0-9.]+@sha256:[0-9a-f]{64}$' '$WORK/$opt/out/$t.container'"
done
check "the bot's container never mounts a tunnel token" bash -c "! grep -hE 'tunnel-token' '$WORK'/*/out/$unit"
check "without a tunnel token no connector is rendered" bash -c "! ls '$WORK'/example/out/*tunnel* >/dev/null 2>&1"

# Invalid knobs must stop the render before any file is written.
bad_env() { # bad_env <name> <sed expression>
  sed -e "$2" "$REPO/config/woowtechbot.env.example" >"$WORK/bad-$1.env"
  if (render_variant "$WORK/example/src" "$WORK/bad-$1.env" "$WORK/bad-$1.out" >/dev/null 2>&1); then
    echo "FAIL a bad $1 is refused"; failures=$((failures + 1))
  else
    echo "ok   a bad $1 is refused"
  fi
}
mkdir -p "$WORK/bad-port.out" "$WORK/bad-same.out" "$WORK/bad-memory.out" "$WORK/bad-bind.out"
bad_env port 's/^WOOW_WTB_PORT=.*/WOOW_WTB_PORT=99999/'
bad_env same 's/^WOOW_WTB_PUBLISHED_PORT=.*/WOOW_WTB_PUBLISHED_PORT=18799/'
bad_env memory 's/^WOOW_WTB_MEMORY=.*/WOOW_WTB_MEMORY=lots/'
bad_env bind 's/^WOOW_WTB_BIND=.*/WOOW_WTB_BIND=localhost/'
