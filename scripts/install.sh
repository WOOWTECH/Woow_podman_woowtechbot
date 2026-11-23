#!/usr/bin/env bash
# scripts/install.sh: install or update woowtechbot as a rootless Quadlet unit (podman >= 4.9,
# systemd --user, linger). Idempotent: a re-run with nothing changed restarts nothing.
#
#   scripts/install.sh [options]
#
#   --set KEY=VALUE    store a per-host setting in ~/.config/woowtechbot/woowtechbot.env first
#                      (repeatable), e.g. --set WTB_PUBLIC_URL=https://bot.example.com.
#                      Only keys of the example file; never credentials (use scripts/secret.sh).
#   --gh-auth          pull the private base image with the gh CLI's token (kept in a tmpfs file
#                      for the pull only, never in argv or on disk); otherwise `podman login ghcr.io`
#   --rebuild          rebuild localhost/woowtechbot-podman:<VERSION> even when it exists
#   --accept-defaults  on the first run, continue with the example settings instead of stopping
#   --no-start         install the files and daemon-reload only
#   --dry-run          render and validate, report what would change, touch nothing
#
# Order: preflight -> settings -> guards -> render -> dry-run -> base image -> build -> settings
# check in a throwaway container -> install -> apply -> health.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=common.sh
. "$REPO/scripts/common.sh"

sets=() gh_auth=0 rebuild=0 accept=0 no_start=0
while (($#)); do
  case $1 in
    --set) (($# >= 2)) || ql_die "--set needs KEY=VALUE"; sets+=("$2"); shift ;;
    --set=*) sets+=("${1#--set=}") ;;
    --gh-auth) gh_auth=1 ;;
    --rebuild) rebuild=1 ;;
    --accept-defaults) accept=1 ;;
    --no-start) no_start=1 ;;
    --dry-run) export QL_DRY_RUN=1 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) ql_die "unknown option $1 (see --help)" ;;
  esac
  shift
done
dry=${QL_DRY_RUN:-0}

# wtb_pull_base: the HA add-on image is private on GHCR. Nothing is pulled when it is present.
wtb_pull_base() {
  local dir='' login graph free_kib
  if podman image exists "$WTB_BASE_IMAGE"; then return 0; fi
  if [[ $dry == 1 ]]; then ql_info "[dry-run] would pull $WTB_BASE_TAG ($WTB_BASE_IMAGE)"; return 0; fi
  graph=$(podman info --format '{{.Store.GraphRoot}}')
  free_kib=$(df -Pk -- "$graph" | awk 'NR == 2 { print $4 }')
  ((free_kib > 8 * 1024 * 1024)) || ql_die "less than 8 GiB free under $graph; the image needs about 6.6 GiB"
  local -a auth=()
  if ((gh_auth)); then
    command -v gh >/dev/null || ql_die "--gh-auth needs the gh CLI (gh auth login)"
    dir=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/$APP-pull.XXXXXX")
    chmod 700 "$dir"
    ql_cleanup pullauth rm -rf "$dir"
    login=$(gh api user --jq .login) || ql_die "gh is not logged in"
    gh auth token | podman login ghcr.io --authfile "$dir/auth.json" --username "$login" --password-stdin >/dev/null \
      || ql_die "podman login to ghcr.io with the gh token failed"
    auth=(--authfile "$dir/auth.json")
  fi
  ql_info "pulling $WTB_BASE_TAG (about 2.7 GB to download, 6.6 GiB on disk)"
  podman pull "${auth[@]}" "$WTB_BASE_IMAGE" >/dev/null \
    || ql_die "cannot pull $WTB_BASE_IMAGE: run 'podman login ghcr.io' with a read:packages token, or rerun with --gh-auth"
  [[ -z $dir ]] || rm -rf "$dir"
}

# wtb_build_image [--force]: build the local image; returns 0 when it built one.
wtb_build_image() {
  if [[ ${1:-} != --force ]] && podman image exists "$WTB_IMAGE"; then return 1; fi
  if [[ $dry == 1 ]]; then ql_info "[dry-run] would build $WTB_IMAGE"; return 1; fi
  ql_info "building $WTB_IMAGE on $WTB_BASE_TAG"
  podman build --pull=never --network=none -f "$REPO/image/Containerfile" \
    --build-arg "BASE_IMAGE=$WTB_BASE_IMAGE" --build-arg "WTB_VERSION=$WTB_VERSION" \
    -t "$WTB_IMAGE" "$REPO/image" >/dev/null || ql_die "building $WTB_IMAGE failed"
}

# wtb_check_settings: the container's own check (the HA Supervisor schema and the add-on's
# validators) in a throwaway container without network, before any unit changes.
wtb_check_settings() {
  local s
  local -a args=(--rm --network=none --env-file "$ENV_FILE" --tmpfs "/run/woowtechbot:rw,mode=0700,size=1m")
  for s in "${WTB_SECRETS[@]}"; do
    if podman secret exists "$s"; then args+=(--secret "$s,type=mount,uid=0,gid=0,mode=0400"); fi
  done
  podman run "${args[@]}" "$WTB_IMAGE" node /opt/woowtechbot-podman/entry.cjs --check >/dev/null \
    || ql_die "the settings were refused (see the lines above); nothing was installed"
}

# ---- 1. host preflight ------------------------------------------------------------------------
ql_preflight "$PODMAN_MIN"
[[ $(uname -m) == x86_64 ]] || ql_die "the woowtechbot image exists for amd64 (x86_64) only"
ql_enable_linger
ql_lock "$APP"
# ---- 2. per-host settings ---------------------------------------------------------------------
sets_applied=0
if ((${#sets[@]})) && [[ -f $ENV_FILE && -O $ENV_FILE ]]; then
  app_apply_sets "${sets[@]}"
  sets_applied=1
fi
ql_env_ensure "$ENV_EXAMPLE" "$ENV_FILE"
if [[ $QL_ENV_CREATED == 1 && $accept == 0 && ${#sets[@]} == 0 ]]; then
  ql_info "review $ENV_FILE (at least WTB_PUBLIC_URL), then run $0 again (or pass --accept-defaults)"
  exit 0
fi
((${#sets[@]} == 0 || sets_applied)) || app_apply_sets "${sets[@]}"
app_env_load
app_env_overlay "${sets[@]}"
app_refuse_env_secrets
port=$(ql_env_get WOOW_WTB_PORT)
bind=$(ql_env_get WOOW_WTB_BIND)

# ---- 3. legacy guards -------------------------------------------------------------------------
app_guard_containers

# ---- 4. stage, render, validate -----------------------------------------------------------------
WORK=$(mktemp -d "${TMPDIR:-/tmp}/$APP-install.XXXXXX")
ql_cleanup work rm -rf "$WORK"
mkdir -p "$WORK/src" "$WORK/out"
cp -p "$REPO"/quadlet/*.container "$REPO"/quadlet/*.volume "$REPO"/quadlet/*.network "$WORK/src/"
tunnels=()
for t in "${WTB_TUNNELS[@]}"; do
  podman secret exists "$t-token" || continue
  cp -p "$REPO/quadlet/optional/$t.container" "$WORK/src/"
  tunnels+=("$t")
done
RENDER_ARGS=()
# shellcheck source=render-args.sh
. "$REPO/scripts/render-args.sh"
render_args "$RENDER_ENV"
ql_render "$WORK/src" "$RENDER_ENV" "$REPO/quadlet/render-vars" "$WORK/out" "${RENDER_ARGS[@]}"
ql_dryrun "$WORK/out" --verify --ref-dir "$HOME/.config/containers/systemd" \
  || ql_die "the rendered units failed the Quadlet dry-run; nothing was installed"
for f in "$WORK/out"/*; do
  u=$(ql_unit_for "$f")
  [[ -z $u ]] || ql_check_unit_shadow "$u" "$APP"
done

# ---- 5. images, then the settings check -------------------------------------------------------
wtb_pull_base
image_rebuilt=0
if ((rebuild)); then
  if wtb_build_image --force; then image_rebuilt=1; fi
elif wtb_build_image; then
  image_rebuilt=1
fi
if podman image exists "$WTB_IMAGE" && [[ -f $ENV_FILE ]]; then
  wtb_check_settings
elif [[ $dry == 1 ]]; then
  ql_info "[dry-run] the settings check needs the built image and the env file; skipped"
else
  ql_die "$WTB_IMAGE is missing after the build"
fi

if ((${#tunnels[@]})) && [[ $dry != 1 ]]; then ql_pull_images "$WORK/out"; fi

# ---- 6. install changed files, then start / restart only what changed --------------------------
changed=$(ql_install_files "$WORK/out" "$APP" --prune)
[[ -z $changed ]] || ql_info "changed: $(tr '\n' ' ' <<<"$changed")"
restart=0
app_env_changed && restart=1
((image_rebuilt == 0)) || restart=1
if [[ $dry == 1 ]]; then
  ((restart)) && ql_info "[dry-run] would restart woowtechbot.service (settings or image changed)"
  ql_info "dry-run complete; nothing was changed"
  exit 0
fi
((restart == 0)) || ql_mark_changed "$APP" woowtechbot.service
if ((no_start)); then
  systemctl --user daemon-reload
  ql_info "installed; not started (--no-start). Start with: systemctl --user start woowtechbot.service"
  exit 0
fi
ql_apply_units "$APP" woowtechbot.service "${tunnels[@]/%/.service}"

# ---- 7. health --------------------------------------------------------------------------------
app_wait_healthy woowtechbot 300 woowtechbot.service
host=$(app_local_host "$bind")
ql_wait_http "http://$host:$port/api/health" '200' 120 || ql_die "the entrance does not answer on $host:$port"
app_env_record
for t in "${tunnels[@]}"; do
  # A wrong or revoked token is the tunnel's problem, not the bot's: report it, keep the bot running.
  ql_wait_container_healthy "$t" 90 \
    || ql_warn "$t has no Cloudflare connection yet (check the token with scripts/secret.sh; journalctl --user -u $t.service -n 30)"
done

public=$(ql_env_get WTB_PUBLIC_URL)
cat >&2 <<EOF
$APP $WTB_VERSION is installed and healthy (image $WTB_BASE_TAG).
  Entrance   http://$host:$port/ ${public:+(public: $public)}
  Pairing    scripts/pair.sh browser   one-time browser code for an administrator
             scripts/pair.sh phone     phone app QR and code (needs WTB_PUBLIC_URL)
  Settings   $ENV_FILE (edit, then run scripts/install.sh again)
  Secrets    scripts/secret.sh list
EOF
