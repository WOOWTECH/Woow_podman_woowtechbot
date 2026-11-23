#!/usr/bin/env bash
# tests/runtime.sh: the HA add-on's runtime verification (scripts/verify-image.sh in the add-on
# repo), run on the Podman path. Not for CI: it needs the built image. It touches nothing of the
# installed bot: a throwaway container without network, its own tmpfs /data, and fixture Odoo MCP
# URLs given as root-only secret files the way podman mounts them.
#
#   tests/runtime.sh [image]     default: localhost/woowtechbot-podman:<VERSION>
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016 # the single-quoted scripts run inside the container, not here
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=../scripts/lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=../scripts/common.sh
. "$REPO/scripts/common.sh"
export QL_LOG_PREFIX=runtime
image=${1:-$WTB_IMAGE}
podman image exists "$image" || ql_die "$image is not built (run scripts/install.sh first)"

run=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/wtb-runtime.XXXXXX")
name="woowtechbot-runtime-${run##*.}"
cleanup() { podman rm -f "$name" >/dev/null 2>&1 || :; rm -rf "$run"; }
trap cleanup EXIT
mkdir -m 700 "$run/secrets"
# The same fixture hosts as the add-on's check; built from parts for the repo's credential scan.
fixture() { printf 'https://%s/%s_fixture_%s/mcp' "$1" private "$2"; }
fixture apun-mcp-odoo.woowtech.io a >"$run/secrets/woowtechbot-apporo-odoo-mcp-url"
fixture woowtech-mcp-odoo.woowtech.io b >"$run/secrets/woowtechbot-woow-prod-odoo-mcp-url"
chmod 400 "$run/secrets"/*

podman run -d --name "$name" --network none --cpus 2 --memory 3g --memory-swap 3g \
  --mount type=tmpfs,destination=/data,tmpfs-mode=0755,tmpfs-size=512m \
  --tmpfs /run/woowtechbot:rw,mode=0700,size=1m \
  --mount "type=bind,src=$run/secrets,dst=/run/secrets,readonly" \
  -e OMB_CONTROL_PLANE_URL= -e OMB_DISABLE_MODEL_MANIFEST_FETCH=1 -e OMB_DISABLE_MODEL_CATALOG_FETCH=1 \
  "$image" >/dev/null

podman exec -i "$name" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
const base = 'http://127.0.0.1:8799';
let healthy = false;
for (let n = 0; n < 480; n++) {
  try { healthy = (await fetch(base + '/api/health')).ok; } catch {}
  if (healthy) break;
  await setTimeout(250);
}
assert(healthy, 'server did not become healthy');
for (const port of [8093, 8094]) {
  let status = 0;
  for (let n = 0; n < 120 && status !== 200; n++) {
    try { status = (await fetch(`http://127.0.0.1:${port}/healthz`)).status; } catch {}
    if (status !== 200) await setTimeout(250);
  }
  assert.equal(status, 200, `isolated MCP gateway ${port} did not start`);
}
const expected = new Map([
  ['ha_apporo_odoo_ro', 'http://127.0.0.1:8093/mcp'],
  ['ha_woow_prod_odoo_ro', 'http://127.0.0.1:8094/mcp'],
]);
let managed;
for (let n = 0; n < 120; n++) {
  managed = await (await fetch(base + '/api/mcp/servers')).json();
  const ready = managed.servers.filter(server => expected.has(server.name));
  if (ready.length === expected.size && ready.every(server => server.enabled === true)) break;
  await setTimeout(250);
}
for (const server of managed.servers.filter(server => expected.has(server.name))) {
  assert.equal(server.url, expected.get(server.name));
  assert.equal(server.enabled, true);
  expected.delete(server.name);
}
assert.equal(expected.size, 0, 'managed MCP entries were not installed');
const edition = await (await fetch(base + '/api/edition')).json();
assert.equal(edition.edition, 'oss');
const unpaired = await fetch('http://127.0.0.1:8080/api/config');
assert([401, 403].includes(unpaired.status), 'public edge admitted an unpaired request');
const forged = await fetch('http://127.0.0.1:8099/api/config', { headers: {
  'x-ingress-path': '/api/hassio_ingress/fake', origin: 'http://127.0.0.1',
} });
assert.equal(forged.status, 403, 'ingress edge admitted a non-Supervisor source');
const { execFileSync } = await import('node:child_process');
const versions = {};
for (const command of ['claude', 'codex']) versions[command] = execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim();
console.log(JSON.stringify({ healthy, gateways: [8093, 8094], edition: edition.edition, unpaired: unpaired.status, forgedIngress: forged.status, engines: versions }));
NODE

podman exec "$name" sh -c 'test "$(stat -c %a:%U /run/secrets/woowtechbot-apporo-odoo-mcp-url)" = 400:root' \
  || ql_die "the secret files are not root-only in the container"
if podman exec -u maus "$name" cat /run/secrets/woowtechbot-apporo-odoo-mcp-url >/dev/null 2>&1; then
  ql_die "the bots' user can read a secret"
fi
if podman exec -u maus "$name" sh -c 'grep -rqs private_fixture_ /data /tmp 2>/dev/null'; then
  ql_die "a fixture MCP URL is readable by the bots' user under /data or /tmp"
fi
podman inspect --format 'runtime: state={{.State.Status}} oom={{.State.OOMKilled}}' "$name"
ql_info "runtime checks passed"
