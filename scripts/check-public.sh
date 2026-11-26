#!/usr/bin/env bash
# scripts/check-public.sh: check the public addresses from the outside, through DNS, TLS and the
# tunnel, after WTB_PUBLIC_URL (and WTB_PUBLISHED_URL) are live. Read-only unless --pairing is given.
#
#   scripts/check-public.sh             addresses, login boundary, published-site isolation
#   scripts/check-public.sh --pairing   also mint one browser code, sign in with it over the public
#                                       address, check that it works once, sign out and cancel
#
# Prints no code, cookie or credential. WTB_CHECK_CURL_ARGS adds curl arguments (tests only).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=common.sh
. "$REPO/scripts/common.sh"
export QL_LOG_PREFIX=check-public
pairing=0
case ${1:-} in
  '') ;;
  --pairing) pairing=1 ;;
  -h | --help) sed -n '2,10p' "$0"; exit 0 ;;
  *) ql_die "unknown option $1 (see --help)" ;;
esac
QL_ENV_MODE_CHECK=0 ql_env_load "$ENV_FILE"
bot=$(ql_env_get WTB_PUBLIC_URL "")
apps=$(ql_env_get WTB_PUBLISHED_URL "")
[[ $bot == https://* ]] || ql_die "WTB_PUBLIC_URL is not an https address in $ENV_FILE"
read -r -a extra <<<"${WTB_CHECK_CURL_ARGS:-}"
tmp=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/wtb-public.XXXXXX")
chmod 700 "$tmp"
ql_cleanup public rm -rf "$tmp"

pass=0 fail=0
ok() { printf 'ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }
# fetch <url> [curl args]: sets $code; headers in $tmp/h, body in $tmp/b. Never follows redirects.
fetch() {
  local url=$1
  shift
  code=$(curl -sS "${extra[@]}" -D "$tmp/h" -o "$tmp/b" -w '%{http_code}' --max-time 20 "$@" "$url" 2>"$tmp/err") || code=000
  tr -d '\r' <"$tmp/h" >"$tmp/h2" 2>/dev/null || : >"$tmp/h2"
}
header() { sed -n "s/^$1: *//Ip" "$tmp/h2" | head -1; }
# expect <description> <codes regex>: the last fetch answered one of the codes
expect() { if [[ $code =~ ^($2)$ ]]; then ok "$1 ($code)"; else bad "$1: answered $code, want $2 $(head -c 120 "$tmp/err" 2>/dev/null)"; fi; }
no_store() { if [[ $(header cache-control) == *no-store* ]]; then ok "$1 is no-store"; else bad "$1 is not no-store"; fi; }

fetch "$bot/api/health"
if [[ $(header location) == *cloudflareaccess.com* ]]; then bad "the bot address asks for a Cloudflare Access login; the phone app cannot pass that"; fi
expect "the bot address answers over valid TLS" 200
fetch "$bot/"
expect "the app page loads" 200
# Cloudflare's JavaScript Detections is a zone setting: it adds its own script to HTML that does not
# say no-transform, so the app page has it on HA and PaaS addresses too. Published pages send
# no-transform and must not have it.
if grep -qE 'cdn-cgi/challenge-platform' "$tmp/b"; then
  printf 'note Cloudflare adds its own script to the app page (a zone setting, the same on HA and PaaS)\n'
else
  ok "the app page is delivered unchanged"
fi
fetch "$bot/api/auth/session"
expect "a visitor without a session is refused" '401|403'
no_store "the session route"
fetch "$bot/api/config"
expect "the settings API is refused without a session" '401|403'
fetch "$bot/api/auth/pairing" -X POST -H 'content-type: application/json' --data '{"label":"probe","ttlMs":60000,"scopes":["admin"]}'
expect "pairing codes cannot be made from outside" '401|403'
fetch "$bot/_woowtechbot/"
expect "the Home Assistant admin page is not served" 404

if [[ -n $apps ]]; then
  fetch "$apps/woowtechbot-published-healthz"
  expect "the published address answers over valid TLS" 200
  for path in / /api/health /api/auth/session /api/config /_woowtechbot/; do
    fetch "$apps$path"
    expect "the published address serves no $path" 404
  done
  fetch "$apps/published/000000000000000000000000/" -X POST --data x
  expect "the published address is read-only" 405
  fetch "$apps/published/000000000000000000000000/"
  expect "an unknown published app is not found" 404
  if [[ -z $(header set-cookie) ]]; then ok "the published address sets no cookie"; else bad "the published address sets a cookie"; fi
  fetch "$bot/published/000000000000000000000000/"
  if [[ $code == 302 && $(header location) == "$apps/published/"* ]]; then ok "old /published/ links go to the published address"; else bad "/published/ on the bot address answered $code to $(header location)"; fi
  for origin in "$apps" null; do
    fetch "$bot/api/config" -H "origin: $origin"
    expect "the bot refuses requests from a published page (origin ${origin/#https:*/published})" 403
  done
fi

if ((pairing)); then
  "$REPO/scripts/pair.sh" browser --json >"$tmp/code.json"
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); open(sys.argv[2],"w").write(json.dumps({"code": d["code"], "cookie": True, "label": "public-check"}))' "$tmp/code.json" "$tmp/body.json"
  if [[ $(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"].split("/pair#")[0])' "$tmp/code.json") == "$bot" ]]; then ok "the pairing link uses the bot address"; else bad "the pairing link does not use the bot address"; fi
  fetch "$bot/api/auth/pair" -c "$tmp/jar" -H 'content-type: application/json' --data @"$tmp/body.json"
  expect "the code signs a browser in over the public address" 200
  cookie=$(header set-cookie)
  if [[ ${cookie,,} == *httponly* && ${cookie,,} == *secure* ]]; then ok "the session cookie is HttpOnly and Secure"; else bad "the session cookie is not HttpOnly and Secure"; fi
  if [[ ${cookie,,} == *domain=* ]]; then bad "the session cookie has a Domain"; else ok "the session cookie stays on the bot host"; fi
  fetch "$bot/api/auth/session" -b "$tmp/jar"
  expect "the session is accepted" 200
  fetch "$bot/api/auth/pair" -H 'content-type: application/json' --data @"$tmp/body.json"
  expect "the same code is refused the second time" 401
  fetch "$bot/api/auth/logout" -b "$tmp/jar" -H 'content-type: application/json' --data '{}'
  expect "signing out works" 200
  fetch "$bot/api/auth/session" -b "$tmp/jar"
  expect "the session ended" '401|403'
  "$REPO/scripts/pair.sh" cancel all >/dev/null
fi
printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))
