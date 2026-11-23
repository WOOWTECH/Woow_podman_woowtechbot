#!/usr/bin/env bash
# tests/public.sh: scripts/check-public.sh against a local stand-in for the tunnel, so the check itself
# is tested before any real address exists. Not for CI: it needs the built image. A throwaway bot with
# both addresses set, and a TLS proxy that does what the tunnel does: route by host name, keep the
# public Host header. Then the same check against a broken set-up, which it must reject.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=../scripts/lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=../scripts/common.sh
. "$REPO/scripts/common.sh"
export QL_LOG_PREFIX=public-test
podman image exists "$WTB_IMAGE" || ql_die "$WTB_IMAGE is not built (run scripts/install.sh first)"
work=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/wtb-pubtest.XXXXXX")
chmod 700 "$work"
id=${work##*.}
bot=wtb-pub-bot-$id proxy=wtb-pub-proxy-$id net=wtb-pub-$id
cleanup() {
  podman rm -f "$bot" "$proxy" >/dev/null 2>&1 || :
  podman network rm -f "$net" >/dev/null 2>&1 || :
  rm -rf "$work"
}
trap cleanup EXIT
port=$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days 1 -subj /CN=bot.example.test \
  -addext subjectAltName=DNS:bot.example.test,DNS:apps.example.test >/dev/null 2>&1
cat >"$work/proxy.cjs" <<'NODE'
const fs = require('node:fs'), http = require('node:http'), https = require('node:https');
// SWAP=1 is the broken set-up: the published address leads to the management port.
const port = host => (host === 'apps.example.test' && !process.env.SWAP ? 8081 : 8080);
https.createServer({ key: fs.readFileSync('/tls/key.pem'), cert: fs.readFileSync('/tls/cert.pem') }, (req, res) => {
  const up = http.request({ host: process.env.BOT, port: port(req.headers.host), method: req.method, path: req.url,
    headers: { ...req.headers, 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.7' } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(8443);
NODE
chmod 644 "$work/key.pem" "$work/cert.pem" "$work/proxy.cjs"
podman network create "$net" >/dev/null
podman run -d --name "$bot" --network "$net" --memory 2g --memory-swap 2g --cpus 2 --mount type=tmpfs,destination=/data,tmpfs-mode=0755,tmpfs-size=512m \
  --tmpfs /run/woowtechbot:rw,mode=0700,size=1m -e WTB_PUBLIC_URL=https://bot.example.test -e WTB_PUBLISHED_URL=https://apps.example.test \
  -e OMB_DISABLE_MODEL_MANIFEST_FETCH=1 -e OMB_DISABLE_MODEL_CATALOG_FETCH=1 "$WTB_IMAGE" >/dev/null
start_proxy() {
  podman rm -f "$proxy" >/dev/null 2>&1 || :
  podman run -d --name "$proxy" --network "$net" --memory 256m -p "127.0.0.1:$port:8443" -v "$work:/tls:ro" -e "BOT=$bot" "$@" \
    --entrypoint node "$WTB_IMAGE" /tls/proxy.cjs >/dev/null
}
for _ in $(seq 1 240); do
  podman exec "$bot" node /opt/woowtechbot-podman/healthcheck.cjs >/dev/null 2>&1 && break
  sleep .5
done
home=$work/home
mkdir -p "$home/.config/$APP"
printf 'WTB_PUBLIC_URL=https://bot.example.test\nWTB_PUBLISHED_URL=https://apps.example.test\n' >"$home/.config/$APP/$APP.env"
run_check() {
  HOME=$home WTB_CHECK_CURL_ARGS="--connect-to ::127.0.0.1:$port --cacert $work/cert.pem" "$REPO/scripts/check-public.sh" >"$work/out" 2>&1
}
start_proxy
sleep 2
rc=0
run_check || rc=$?
cat "$work/out"
((rc == 0)) || ql_die "check-public.sh rejects a correct set-up"
start_proxy -e SWAP=1
sleep 2
if run_check; then ql_die "check-public.sh accepts a published address that leads to the management port"; fi
printf 'the broken set-up is rejected: %s\n' "$(tail -1 "$work/out")"
