#!/usr/bin/env bash
# tests/cockpit-lab.sh: the Cockpit page on a throwaway "host": a container with systemd, a real
# Cockpit, sudo and rootless Podman, where the bot is a stand-in (tests/cockpit-lab/fake-app.cjs in a
# small container) instead of the 7 GB image. The page is installed with scripts/cockpit-page.sh.
#
#   tests/cockpit-lab.sh up       create the lab and install the page (again, after a change)
#   tests/cockpit-lab.sh test     tests/cockpit-page.cjs (Playwright) against it
#   tests/cockpit-lab.sh down     remove the lab container and its volume
#
# Environment:
#   WTB_LAB_IMAGE   Ubuntu 24.04 with systemd as PID 1, Cockpit 362, sudo and rootless Podman (required)
#   WTB_LAB_PODMAN  the podman command for the lab (default podman; a separate storage is safer)
#   WTB_LAB_BASE    the stand-in bot's image, in that storage (default docker.io/library/ubuntu:24.04)
#   WTB_LAB_NODE    a Linux x86_64 node binary for the stand-in (default: node on PATH)
#   WTB_LAB_ADDON   the add-on modules for pair.cjs (default tests/fixtures/addon; the real ones draw real QR codes)
#   WTB_LAB_PORT    Cockpit's port on 127.0.0.1 (default 19131)
#   WTB_LAB_NAME    the container's name (default wtb-cockpit-lab)
#   WTB_LAB_STATE   the lab accounts' generated passwords (default ~/.local/state/wtb-cockpit-lab, 0700)
#   NODE_PATH, PLAYWRIGHT_CHROMIUM_EXECUTABLE   for the test: where playwright-core and Chromium are
#
# Accounts in the lab: labadmin (sudo), labviewer (not an administrator), botowner (runs the bot).
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
read -r -a LP <<< "${WTB_LAB_PODMAN:-podman}"
IMAGE=${WTB_LAB_IMAGE:-}
BASE=${WTB_LAB_BASE:-docker.io/library/ubuntu:24.04}
NODE=${WTB_LAB_NODE:-$(command -v node || true)}
ADDON=${WTB_LAB_ADDON:-$REPO/tests/fixtures/addon}
PORT=${WTB_LAB_PORT:-19131}
NAME=${WTB_LAB_NAME:-wtb-cockpit-lab}
STATE=${WTB_LAB_STATE:-$HOME/.local/state/wtb-cockpit-lab}
PUBLIC=https://bot.lab.example
OWNER_UID=1203

die() { printf 'cockpit-lab: %s\n' "$*" >&2; exit 1; }
log() { printf 'cockpit-lab: %s\n' "$*" >&2; }
lab() { "${LP[@]}" exec -i "$NAME" "$@"; }
as_bot() { lab runuser -u botowner -- env -i PATH=/usr/bin:/bin HOME=/home/botowner \
  XDG_RUNTIME_DIR=/run/user/$OWNER_UID DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$OWNER_UID/bus "$@"; }
wait_for() {
  local seconds=$1 what=$2; shift 2
  local end=$((SECONDS + seconds))
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < end)) || die "waited ${seconds}s for: $what"
    sleep 2
  done
}
booted() { case $(lab systemctl is-system-running 2>/dev/null || true) in running | degraded) return 0 ;; *) return 1 ;; esac; }

up() {
  [[ -n $IMAGE ]] || die "set WTB_LAB_IMAGE (see the header of this script)"
  "${LP[@]}" image exists "$IMAGE" || die "image $IMAGE not found"
  "${LP[@]}" image exists "$BASE" || die "image $BASE not found (pull it into the lab storage first)"
  [[ -x $NODE ]] || die "no node binary (set WTB_LAB_NODE)"
  install -d -m 0700 "$STATE"
  for account in labadmin labviewer; do
    [[ -s $STATE/$account.pass ]] || (umask 077 && openssl rand -hex 16 > "$STATE/$account.pass")
  done
  case $("${LP[@]}" container inspect --format '{{.State.Status}}' "$NAME" 2>/dev/null || echo absent) in
    running) log "$NAME is running" ;;
    absent)
      log "creating $NAME (Cockpit on https://127.0.0.1:$PORT)"
      "${LP[@]}" run -d --name "$NAME" --hostname "$NAME" --label wtb.lab=cockpit --systemd=always --privileged \
        --device /dev/fuse --memory 1200m --cpus 1.5 -p "127.0.0.1:$PORT:9090" -v "$NAME-home:/home" "$IMAGE" >/dev/null ;;
    *) "${LP[@]}" start "$NAME" >/dev/null ;;
  esac
  wait_for 240 "systemd in $NAME" booted

  # Accounts; the passwords go in on stdin, never on a command line.
  cat "$STATE/labadmin.pass" "$STATE/labviewer.pass" | lab bash -c "$(cat <<'SCRIPT'
set -euo pipefail
mount --make-rshared / 2>/dev/null || true
id labadmin >/dev/null 2>&1 || useradd -m -u 1201 -G sudo -s /bin/bash labadmin
id labviewer >/dev/null 2>&1 || useradd -m -u 1202 -s /bin/bash labviewer
id botowner >/dev/null 2>&1 || useradd -m -u 1203 -s /bin/bash botowner
for f in /etc/subuid /etc/subgid; do sed -i '/^botowner:/d' "$f"; echo 'botowner:10000:50000' >> "$f"; done
IFS= read -r admin; IFS= read -r viewer
printf 'labadmin:%s\nlabviewer:%s\n' "$admin" "$viewer" | chpasswd
loginctl enable-linger botowner
SCRIPT
)"
  wait_for 90 "botowner's user manager" lab test -S /run/user/$OWNER_UID/bus

  # The stand-in bot's files: this checkout (owned by botowner, like a real checkout of the bot's
  # account), node, the add-on modules and the options.
  tar -C "$REPO" -cf - cockpit scripts/cockpit-page.sh tests/cockpit-lab image/rootfs/opt/woowtechbot-podman VERSION |
    lab bash -c 'rm -rf /opt/wtb-lab/repo && install -d /opt/wtb-lab/repo && tar -C /opt/wtb-lab/repo -xf - &&
      chown -R botowner: /opt/wtb-lab/repo'
  tar -C "$ADDON" -cf - . | lab bash -c 'rm -rf /opt/wtb-lab/addon && install -d /opt/wtb-lab/addon && tar -C /opt/wtb-lab/addon -xf -'
  if ! lab test -x /opt/wtb-lab/node; then "${LP[@]}" cp "$NODE" "$NAME:/opt/wtb-lab/node"; fi
  printf '{"public_url":"%s","published_url":"","first_admin_email":""}\n' "$PUBLIC" |
    lab bash -c 'install -d /opt/wtb-lab/data && cat > /opt/wtb-lab/data/options.json && chmod -R a+rX /opt/wtb-lab'
  if ! as_bot podman image exists "$BASE"; then
    log "loading $BASE for botowner"
    "${LP[@]}" save "$BASE" | as_bot podman load >/dev/null
  fi
  as_bot bash -c "install -d ~/.config/containers/systemd && cat > ~/.config/containers/systemd/woowtechbot.container" <<UNIT
[Unit]
Description=woowtechbot stand-in for the Cockpit page lab
[Container]
ContainerName=woowtechbot
Image=$BASE
Pull=never
Label=io.woowtech.app=woowtechbot
Label=org.opencontainers.image.version=$(cat "$REPO/VERSION")
Volume=/opt/wtb-lab/node:/usr/local/bin/node:ro
Volume=/opt/wtb-lab/repo/image/rootfs/opt/woowtechbot-podman:/opt/woowtechbot-podman:ro
Volume=/opt/wtb-lab/repo/tests/cockpit-lab:/opt/wtb-lab:ro
Volume=/opt/wtb-lab/addon:/opt/omb-addon:ro
Volume=/opt/wtb-lab/data:/data:ro
Environment=WTB_SERVER_NAME=lab-bot WTB_FAKE_PUBLIC_URL=$PUBLIC WTB_FAKE_ENTRANCE_PORT=8080
PublishPort=127.0.0.1:18799:8080
Exec=/usr/local/bin/node /opt/wtb-lab/fake-app.cjs
[Service]
Restart=always
UNIT
  as_bot systemctl --user daemon-reload
  as_bot systemctl --user restart woowtechbot.service
  wait_for 120 "the stand-in bot" as_bot podman exec woowtechbot node -e \
    'fetch("http://127.0.0.1:8799/api/health").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))'

  log "installing the page as root with scripts/cockpit-page.sh"
  lab bash /opt/wtb-lab/repo/scripts/cockpit-page.sh install
  lab bash /opt/wtb-lab/repo/scripts/cockpit-page.sh status
  log "ready: https://127.0.0.1:$PORT (labadmin / labviewer, passwords in $STATE)"
}

case ${1:-} in
  up) up ;;
  test)
    LAB_URL=https://127.0.0.1:$PORT LAB_STATE=$STATE LAB_NAME=$NAME LAB_PODMAN="${LP[*]}" LAB_VERSION=$(cat "$REPO/VERSION") \
      node "$REPO/tests/cockpit-page.cjs" ;;
  down)
    "${LP[@]}" rm -f -t 30 "$NAME" >/dev/null 2>&1 || true
    "${LP[@]}" volume rm -f "$NAME-home" >/dev/null 2>&1 || true
    log "removed $NAME (the passwords in $STATE are kept)" ;;
  *) sed -n '2,23p' "$0"; exit 2 ;;
esac
