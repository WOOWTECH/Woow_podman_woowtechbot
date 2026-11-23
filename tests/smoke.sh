#!/usr/bin/env bash
# tests/smoke.sh: live checks on a host where scripts/install.sh has run. Not for CI: it needs the
# real image and the running container. Prints no pairing code, cookie or credential.
#
#   tests/smoke.sh [--no-pairing]
#
# It mints one browser code, redeems it once over the local entrance, checks that the same code is
# refused the second time, signs that session out again and cancels what is left.
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016 # the single-quoted scripts run inside the container, not here
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=../scripts/lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=../scripts/common.sh
. "$REPO/scripts/common.sh"
export QL_LOG_PREFIX=smoke
pairing=1
[[ ${1:-} == --no-pairing ]] && pairing=0

QL_ENV_MODE_CHECK=0 ql_env_load "$ENV_FILE"
host=$(app_local_host "$(ql_env_get WOOW_WTB_BIND)")
base="http://$host:$(ql_env_get WOOW_WTB_PORT)"
published=$(ql_env_get WTB_PUBLISHED_URL "")
pass=0 fail=0
ok() { printf 'ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL %s\n' "$1"; fail=$((fail + 1)); }
check() { if "${@:2}" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
in_box() { podman exec woowtechbot "$@"; }
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

check "woowtechbot.service is active" systemctl --user is-active woowtechbot.service
check "the container is healthy" podman healthcheck run woowtechbot
want='8080/tcp'
[[ -z $published ]] || want='8080/tcp 8081/tcp'
got=$(podman port woowtechbot | sed -E 's/ ->.*//' | sort -u | tr '\n' ' ' | sed 's/ $//')
if [[ $got == "$want" ]]; then ok "published: only the entrance${published:+ and the published site} ($got)"; else bad "published ports are '$got', want '$want'"; fi
check "not host networking" test "$(podman inspect --format '{{.HostConfig.NetworkMode}}' woowtechbot)" != host
check "/data/options.json links into the private tmpfs" in_box sh -c \
  'test -L /data/options.json && test "$(readlink /data/options.json)" = /run/woowtechbot/options.json && grep -q " /run/woowtechbot tmpfs " /proc/self/mounts'
check "the options file is root-only (0600)" in_box sh -c 'test "$(stat -c %a:%U /run/woowtechbot/options.json)" = 600:root'
check "the bots' user cannot read the options" bash -c '! podman exec -u maus woowtechbot cat /data/options.json'
if in_box sh -c 'ls /run/secrets/woowtechbot-* >/dev/null 2>&1'; then
  check "the mounted secrets are root-only (0400)" in_box sh -c \
    'for f in /run/secrets/woowtechbot-*; do test "$(stat -c %a:%U "$f")" = 400:root || exit 1; done'
  check "the bots' user cannot read the secrets" bash -c '! podman exec -u maus woowtechbot sh -c "cat /run/secrets/woowtechbot-*"'
fi
# The checks below match whole argv entries and skip their own process: their script text names
# the server file too, so a substring match can find the check itself.
check "the app server runs as maus" in_box node -e '
  const fs = require("fs");
  const argv = p => { try { return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0"); } catch { return []; } };
  const pids = fs.readdirSync("/proc").filter(p => /^\d+$/.test(p) && p !== String(process.pid));
  const servers = pids.filter(p => argv(p).includes("/app/dist-server/server-launcher.js"));
  if (!servers.length) process.exit(1);
  const maus = fs.readFileSync("/etc/passwd", "utf8").split("\n").find(l => l.startsWith("maus:")).split(":")[2];
  const uid = p => fs.readFileSync(`/proc/${p}/status`, "utf8").match(/^Uid:\s+(\d+)/m)[1];
  process.exit(servers.every(p => uid(p) === maus) ? 0 : 1);'
# Read as maus: root in a rootless container has no CAP_SYS_PTRACE, so it cannot read the
# environment of maus's processes. Only the app's own processes count, not this exec session.
check "the app's processes got no WTB_ settings in their environment" podman exec -u maus woowtechbot node -e '
  const fs = require("fs");
  let server = false;
  for (const p of fs.readdirSync("/proc").filter(p => /^\d+$/.test(p) && p !== String(process.pid))) {
    let argv, env;
    try { argv = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0"); env = fs.readFileSync(`/proc/${p}/environ`, "utf8").split("\0"); } catch { continue; }
    if (!argv.some(a => a.startsWith("/app/") || a.startsWith("/opt/omb-addon/"))) continue;
    if (argv.includes("/app/dist-server/server-launcher.js")) server = true;
    if (env.some(e => /^(WTB_|WOOW_WTB_)/.test(e))) process.exit(1);
  }
  process.exit(server ? 0 : 1);'
check "document_read tools are present (pdftotext, openpyxl, prlimit)" in_box sh -c \
  'test -x /opt/woowtechbot/conda/bin/pdftotext && /opt/woowtechbot/conda/bin/python3 -I -c "import openpyxl" && test -x /usr/bin/prlimit'
check "the browser is present" in_box sh -c 'test -x "$AGENT_BROWSER_EXECUTABLE_PATH"'
check "GET /api/health is 200 on the entrance" test "$(status "$base/api/health")" = 200
headers=$(curl -s -D - -o /dev/null --max-time 10 "$base/api/auth/session" | tr -d '\r')
code=$(sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p' <<<"$headers")
if [[ $code == 401 || $code == 403 ]]; then ok "an unpaired session is refused ($code)"; else bad "an unpaired session answered $code"; fi
if grep -qi '^cache-control: no-store' <<<"$headers"; then ok "the auth route is no-store"; else bad "the auth route is not no-store"; fi
mint=$(status -H 'content-type: application/json' --data '{"label":"smoke-probe","ttlMs":60000,"scopes":["admin"]}' "$base/api/auth/pairing")
if [[ $mint == 401 || $mint == 403 ]]; then ok "codes cannot be made through the entrance ($mint)"; else bad "POST /api/auth/pairing on the entrance answered $mint"; fi
to_bytes() { local v=${1,,}; case $v in *g) echo $((${v%g} * 1024 ** 3)) ;; *m) echo $((${v%m} * 1024 ** 2)) ;; *k) echo $((${v%k} * 1024)) ;; *) echo "$v" ;; esac; }
want_limits="$(to_bytes "$(ql_env_get WOOW_WTB_MEMORY)") $(to_bytes "$(ql_env_get WOOW_WTB_MEMORY)") $(awk -v c="$(ql_env_get WOOW_WTB_CPUS)" 'BEGIN { printf "%d", c * 1e9 }') $(ql_env_get WOOW_WTB_PIDS_LIMIT)"
got_limits=$(podman inspect --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}' woowtechbot)
if [[ $got_limits == "$want_limits" ]]; then ok "memory, swap, CPU and process limits are in force"; else bad "limits are '$got_limits', want '$want_limits'"; fi
check "a settings error stops the container with 78" bash -c \
  "podman run --rm --network=none --tmpfs /run/woowtechbot:rw,mode=0700,size=1m -e WTB_LLM_GW_MAX_TOKENS=0 '$WTB_IMAGE' node /opt/woowtechbot-podman/entry.cjs --check; test \$? = 78"

if ((pairing)); then
  tmp=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/wtb-smoke.XXXXXX")
  chmod 700 "$tmp"
  ql_cleanup smoke rm -rf "$tmp"
  "$REPO/scripts/pair.sh" browser --json >"$tmp/code.json"
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); open(sys.argv[2],"w").write(json.dumps({"code": d["code"], "cookie": True, "label": "podman-smoke"}))' "$tmp/code.json" "$tmp/body.json"
  if "$REPO/scripts/pair.sh" list --json | grep -q '"Podman browser"'; then ok "the new code is pending"; else bad "the new code is not listed"; fi
  redeem() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 -c "$tmp/jar" -b "$tmp/jar" -H 'content-type: application/json' --data @"$tmp/body.json" "$base/api/auth/pair"; }
  first=$(redeem)
  if [[ $first == 200 ]]; then ok "the code signs a browser in once"; else bad "redeeming the code answered $first"; fi
  if [[ $(status -b "$tmp/jar" "$base/api/auth/session") == 200 ]]; then ok "the paired session is accepted"; else bad "the paired session is not accepted"; fi
  second=$(redeem)
  if [[ $second == 401 ]]; then ok "the same code is refused the second time (401)"; else bad "reusing the code answered $second"; fi
  pcode=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["code"])' "$tmp/code.json")
  if [[ -n $pcode ]] && ! podman logs woowtechbot 2>&1 | grep -qF -- "$pcode"; then ok "the code is in no container log"; else bad "the code shows up in the container log"; fi
  out=$(status -b "$tmp/jar" -H 'content-type: application/json' --data '{}' "$base/api/auth/logout")
  after=$(status -b "$tmp/jar" "$base/api/auth/session")
  if [[ $out == 200 && ($after == 401 || $after == 403) ]]; then ok "signing out ends that session"; else bad "logout $out, session after $after"; fi
  "$REPO/scripts/pair.sh" cancel all >/dev/null
  if "$REPO/scripts/pair.sh" list --json | grep -q '"Podman '; then bad "codes are left after cancel"; else ok "nothing of this tool is left pending"; fi
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
((fail == 0))
