#!/usr/bin/env bash
# tests/hermes.sh: the Hermes engine in the built image, with a scripted model service instead of a
# real one. Not for CI: it needs the built image. It touches nothing of the installed bot: a throwaway
# container without network and with its own tmpfs /data.
#
#   tests/hermes.sh [image]     default: localhost/woowtechbot-podman:<VERSION>
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=../scripts/lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=../scripts/common.sh
. "$REPO/scripts/common.sh"
export QL_LOG_PREFIX=hermes
image=${1:-$WTB_IMAGE}
podman image exists "$image" || ql_die "$image is not built (run scripts/install.sh first)"
name="woowtechbot-hermes-test-$$"
cleanup() { podman rm -f "$name" >/dev/null 2>&1 || :; }
trap cleanup EXIT

# The same memory and CPU limits as the unit's defaults; an HTTPS address so that published apps are on.
podman run -d --name "$name" --network none --cpus 2 --memory 4g --memory-swap 4g --shm-size 512m \
  --mount type=tmpfs,destination=/data,tmpfs-mode=0755,tmpfs-size=1g \
  --tmpfs /run/woowtechbot:rw,mode=0700,size=1m -e WTB_PUBLIC_URL=https://bot.example.com \
  -e OMB_CONTROL_PLANE_URL= -e OMB_DISABLE_MODEL_MANIFEST_FETCH=1 -e OMB_DISABLE_MODEL_CATALOG_FETCH=1 \
  "$image" >/dev/null
for ((i = 0; i < 120; i++)); do
  podman exec "$name" node -e 'fetch("http://127.0.0.1:8799/api/health").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
    >/dev/null 2>&1 && break
  sleep 2
done
((i < 120)) || ql_die "the bot in the test container did not become healthy"
podman exec -i -u maus -e HOME=/data -w /data "$name" node --input-type=module <"$REPO/tests/hermes-smoke.mjs"
podman exec -i -u maus -e HOME=/data -w /data "$name" node --input-type=module <"$REPO/tests/hermes-gateway.mjs"
podman exec "$name" sh -c 'printf "memory peak %s MiB, processes peak %s\n" "$(($(cat /sys/fs/cgroup/memory.peak) / 1048576))" "$(cat /sys/fs/cgroup/pids.peak)"' || true
podman inspect --format 'state={{.State.Status}} oom={{.State.OOMKilled}}' "$name"
ql_info "Hermes checks passed"
