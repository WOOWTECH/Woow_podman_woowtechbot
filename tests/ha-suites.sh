#!/usr/bin/env bash
# tests/ha-suites.sh: run the HA add-on's own acceptance suites on the Podman image, so "same as the
# HA edition" is checked with the HA edition's tests and not with a copy of them. The add-on repo is
# private; give the path of a checkout of the release this repo is pinned to. Not for CI.
#
#   tests/ha-suites.sh <ha-addon-checkout> [toolchain|published|signin|llm-gw ...] (default: all four)
#
#   toolchain   toolchain/tests: smoke, portability, sandbox-verify-tools
#   published   scripts/test-candidate-published-apps.mjs in both modes: one address (legacy) and a
#               separate WTB_PUBLISHED_URL (isolated), before and after a restart
#   signin      scripts/test-candidate-signin.mjs: the email code flow over HTTPS against an
#               in-container mail stand-in (four phases). Nothing is sent to anyone.
#   llm-gw      the HA gateway tests, plus Podman settings, loopback binding, streaming, restart
#               and failure propagation against a synthetic upstream with no external network
#
# Differences from the add-on's own runners, all on the Podman side: the settings go in as WTB_* and
# root-only secret files through entry.cjs (no Supervisor writes options.json), podman replaces
# docker, and there is no HA Ingress edge (8099), so that edge is only checked to refuse.
# Throwaway containers, data and networks; the installed bot is not touched.
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016 # the single-quoted scripts run inside the container, not here
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=../scripts/lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=../scripts/common.sh
. "$REPO/scripts/common.sh"
export QL_LOG_PREFIX=ha-suites
MEMORY=${WTB_TEST_MEMORY:-2g}

ha=${1:-}
[[ -n $ha && -f $ha/source.lock.json ]] || ql_die "usage: tests/ha-suites.sh <ha-addon-checkout> [toolchain|published|signin|llm-gw ...]"
ha=$(cd "$ha" && pwd -P)
shift
suites=("$@")
((${#suites[@]})) || suites=(toolchain published signin llm-gw)
want=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$ha/source.lock.json")
[[ $WTB_BASE_TAG == *":$want" ]] || ql_die "the checkout is $want, this repo runs $WTB_BASE_TAG; check out the matching release"
podman image exists "$WTB_IMAGE" || ql_die "$WTB_IMAGE is not built (run scripts/install.sh first)"

work=$(mktemp -d "${TMPDIR:-/tmp}/wtb-ha.XXXXXX")
id=${work##*.}
box=woowtechbot-ha-$id
net=woowtechbot-ha-$id
cleanup() {
  podman rm -f "$box" >/dev/null 2>&1 || :
  podman network rm -f "$net" >/dev/null 2>&1 || :
  podman unshare rm -rf "$work"
}
trap cleanup EXIT
pass=0 fail=0
note() { if [[ $1 == 0 ]]; then printf 'ok   %s\n' "$2"; pass=$((pass + 1)); else printf 'FAIL %s\n' "$2"; fail=$((fail + 1)); fi; }

wait_ready() {
  local _
  for _ in $(seq 1 480); do
    if podman exec "$box" node -e "fetch('http://127.0.0.1:8799/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    [[ $(podman inspect --format '{{.State.Running}}' "$box" 2>/dev/null) == true ]] || { podman logs "$box" 2>&1 | tail -5 >&2; return 1; }
    sleep .25
  done
  return 1
}
# start_box <data-dir> <secrets-dir> <podman run args...>
start_box() {
  local data=$1 secrets=$2
  shift 2
  podman rm -f "$box" >/dev/null 2>&1 || :
  podman run -d --name "$box" --memory "$MEMORY" --memory-swap "$MEMORY" --cpus 2 \
    --mount "type=bind,src=$data,dst=/data" --tmpfs /run/woowtechbot:rw,mode=0700,size=1m \
    --mount "type=bind,src=$secrets,dst=/run/secrets,readonly" \
    --mount "type=bind,src=$ha/scripts,dst=/ha-scripts,readonly" \
    -e OMB_CONTROL_PLANE_URL= -e OMB_DISABLE_MODEL_MANIFEST_FETCH=1 -e OMB_DISABLE_MODEL_CATALOG_FETCH=1 \
    "$@" "$WTB_IMAGE" >/dev/null
  wait_ready
}

run_toolchain() {
  local s rc
  for s in smoke.sh portability.sh sandbox-verify-tools.sh; do
    rc=0
    podman run --rm --network none --cpus 2 --memory "$MEMORY" --memory-swap "$MEMORY" --user 1001 \
      --mount type=tmpfs,destination=/data,tmpfs-mode=0700,tmpfs-size=256m,U=true \
      --mount "type=bind,src=$ha/toolchain/tests,dst=/test,readonly" --entrypoint bash "$WTB_IMAGE" "/test/$s" \
      >"$work/tool-$s.log" 2>&1 || rc=$?
    note "$rc" "toolchain $s ($(grep -E 'RESULT:|passed' "$work/tool-$s.log" | tail -1 | cut -c1-60))"
  done
}

run_published() {
  local mode kind port rc ip after route key token
  local -a env
  local t=/ha-scripts/test-candidate-published-apps.mjs
  for mode in legacy isolated; do
    mkdir -p "$work/pub-$mode" "$work/nosecrets"
    env=(-e WTB_PUBLIC_URL=https://bot.example.test)
    [[ $mode == legacy ]] || env+=(-e WTB_PUBLISHED_URL=https://apps.example.test)
    podman network exists "$net" || podman network create --internal "$net" >/dev/null
    # SYS_PTRACE is for the white-box token check only (the test reads the relay's environment).
    if ! start_box "$work/pub-$mode" "$work/nosecrets" --network "$net" --cap-add SYS_PTRACE "${env[@]}"; then note 1 "published $mode: the container starts"; continue; fi
    rc=0; podman exec "$box" node "$t" publish >"$work/publish.json" 2>"$work/publish.err" || rc=$?
    note "$rc" "published $mode: publish_app stores the app, the one-time API token is not on /data"
    ((rc == 0)) || { tail -3 "$work/publish.err" >&2; continue; }
    route=$(python3 -I -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().splitlines()[-1])["route"])' "$work/publish.json")
    key=$(python3 -I -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().splitlines()[-1])["key"])' "$work/publish.json")
    token=$(python3 -I -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().splitlines()[-1])["tokenSha256"])' "$work/publish.json")
    for after in before after; do
      if [[ $after == after ]]; then
        if ! { podman restart --time 30 "$box" >/dev/null && wait_ready; }; then note 1 "published $mode: restart"; break; fi
        rc=0; podman exec "$box" node "$t" restart "$token" "$key" >/dev/null 2>"$work/r.err" || rc=$?
        note "$rc" "published $mode: after a restart the app is kept and the token is new"
      fi
      ip=$(podman inspect --format "{{(index .NetworkSettings.Networks \"$net\").IPAddress}}" "$box")
      for kind in public published; do
        port=8080
        [[ $kind == public ]] || port=8081
        [[ $kind == public || $mode == isolated ]] || continue
        rc=0
        podman run --rm --network "$net" --memory 512m --mount "type=bind,src=$ha/scripts,dst=/ha-scripts,readonly" --entrypoint node "$WTB_IMAGE" \
          "$t" edge "http://$ip:$port" "$route" "$kind" "$mode" >"$work/edge.json" 2>"$work/edge.err" || rc=$?
        note "$rc" "published $mode: the $kind edge ($port) $after the restart"
        ((rc == 0)) || tail -2 "$work/edge.err" >&2
      done
      rc=0
      podman run --rm --network "$net" --memory 512m --entrypoint node "$WTB_IMAGE" -e \
        "fetch('http://$ip:8099/', {headers:{'x-ingress-path':'/api/hassio_ingress/x'}}).then(r=>process.exit(r.status===403?0:1)).catch(()=>process.exit(1))" || rc=$?
      note "$rc" "published $mode: port 8099 (HA Ingress) refuses $after the restart"
    done
  done
}

run_signin() {
  local phase rc host
  mkdir -p "$work/signin/data" "$work/signin/fixture/tls" "$work/signin/secrets"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/signin/fixture/tls/key.pem" -out "$work/signin/fixture/tls/cert.pem" \
    -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost >/dev/null 2>&1
  # The add-on test's own synthetic credentials (they open nothing); parts, for the credential scan.
  printf '%s.11111111-1111-4111-8111-111111111111.%s' wtbha1 "$(printf 'A%.0s' {1..43})" >"$work/signin/secrets/woowtechbot-signin-relay-token"
  printf 'cfast_synthetic_fixture_only_not_a_real_service_token' >"$work/signin/secrets/woowtechbot-signin-access-client-secret"
  chmod 400 "$work/signin/secrets"/*
  podman unshare chown -R 1001:1001 "$work/signin/fixture"
  for phase in trusted restart untrusted wrong-hostname; do
    local -a args=(--network none -e WTB_FIRST_ADMIN_EMAIL=seed@fixture.example.invalid -e WTB_SIGNIN_ACCESS_CLIENT_ID=fixture-ha.access
      --mount "type=bind,src=$work/signin/fixture,dst=/fixture")
    host=localhost; [[ $phase != wrong-hostname ]] || host=127.0.0.1
    args+=(-e "WTB_SIGNIN_RELAY_URL=https://$host:8444/api/woowtechbot/signin-mail")
    [[ $phase == untrusted ]] || args+=(-e NODE_EXTRA_CA_CERTS=/fixture/tls/cert.pem)
    rc=0
    if [[ $phase == restart ]]; then
      if ! { podman restart --time 30 "$box" >/dev/null && wait_ready; }; then rc=1; fi
    else
      start_box "$work/signin/data" "$work/signin/secrets" "${args[@]}" || rc=1
    fi
    if ((rc == 0)); then timeout 120 podman exec --user 1001 "$box" node /ha-scripts/test-candidate-signin.mjs "$phase" >"$work/signin-$phase.json" 2>&1 || rc=$?; fi
    note "$rc" "signin $phase ($(python3 -I -c 'import json,sys
try: print(len(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])["checks"]), "checks")
except Exception: print("no result")' "$work/signin-$phase.json" 2>/dev/null || echo 'not started'))"
    ((rc == 0)) || tail -2 "$work/signin-$phase.json" >&2 2>/dev/null || :
  done
}

run_llm_gw() {
  local rc phase _
  local probe=/podman-tests/llm-gw.cjs
  local -a mount=(--mount "type=bind,src=$REPO/tests,dst=/podman-tests,readonly")
  # Check the actual image against the source used by HA's own tests; do not copy private code.
  podman rm -f "$box" >/dev/null 2>&1 || :
  rc=0
  timeout 60 podman run --rm --name "$box" --network none --memory "$MEMORY" --memory-swap "$MEMORY" --cpus 2 \
    --mount "type=bind,src=$ha/addon,dst=/ha-addon,readonly" --entrypoint sh "$WTB_IMAGE" \
    -c 'cmp /ha-addon/llm-gw.mjs /opt/omb-addon/llm-gw.mjs && node --test /ha-addon/test-gateway.mjs' \
    >"$work/llm-ha.log" 2>&1 || rc=$?
  note "$rc" "llm-gw: image matches HA source and HA gateway tests pass"
  ((rc == 0)) || { tail -5 "$work/llm-ha.log" >&2; return; }
  mkdir -p "$work/llm-data" "$work/nosecrets"
  if ! start_box "$work/llm-data" "$work/nosecrets" --network none "${mount[@]}"; then
    note 1 "llm-gw: default container starts"; return
  fi
  rc=0
  timeout 30 podman exec --user maus "$box" node "$probe" disabled >"$work/llm-disabled.log" 2>&1 || rc=$?
  note "$rc" "llm-gw: off by default, application output limit is 32000"
  ((rc == 0)) || { tail -5 "$work/llm-disabled.log" >&2; return; }
  if ! start_box "$work/llm-data" "$work/nosecrets" --network none "${mount[@]}" \
    -e WTB_LLM_GW_ENABLED=true -e WTB_LLM_GW_UPSTREAM=http://127.0.0.1:18092/prefix \
    -e WTB_LLM_GW_MAX_TOKENS=1234; then
    note 1 "llm-gw: enabled container starts"; return
  fi
  [[ -z $(podman port "$box") ]] && rc=0 || rc=1
  note "$rc" "llm-gw: no container ports are published"
  for phase in before after; do
    if [[ $phase == after ]]; then
      if ! { podman restart --time 30 "$box" >/dev/null && wait_ready; }; then
        note 1 "llm-gw: restart"; return
      fi
    fi
    rc=0
    timeout 60 podman exec --user maus "$box" node "$probe" enabled >"$work/llm-$phase.log" 2>&1 || rc=$?
    note "$rc" "llm-gw: limits, auth, paths, streaming, cancellation and errors ($phase restart)"
    ((rc == 0)) || { tail -5 "$work/llm-$phase.log" >&2; return; }
    tail -1 "$work/llm-$phase.log"
  done
  podman logs "$box" >"$work/llm-container.log" 2>&1
  if grep -qE 'synthetic-gw-(key|prompt|query)' "$work/llm-container.log"; then rc=1; else rc=0; fi
  note "$rc" "llm-gw: synthetic key, prompt and query are absent from container logs"
  rc=0
  timeout 10 podman exec --user maus "$box" node "$probe" kill || rc=$?
  if ((rc == 0)); then
    for _ in $(seq 1 35); do
      [[ $(podman inspect --format '{{.State.Running}}' "$box") == true ]] || break
      sleep 1
    done
    [[ $(podman inspect --format '{{.State.Running}} {{.State.ExitCode}}' "$box") == 'false 1' ]] || rc=1
  fi
  note "$rc" "llm-gw: gateway failure stops the container with exit 1"
}

for s in "${suites[@]}"; do
  case $s in
    toolchain) run_toolchain ;;
    published) run_published ;;
    signin) run_signin ;;
    llm-gw) run_llm_gw ;;
    *) ql_die "unknown suite $s" ;;
  esac
done
printf '%d passed, %d failed (HA add-on %s on %s)\n' "$pass" "$fail" "$want" "$WTB_IMAGE"
((fail == 0))
