#!/usr/bin/env bash
# Cold backup of the bot's volume and settings. The service is stopped for a consistent export.
#   scripts/backup.sh [--dest NEW_DIR] [--age-recipient age1...]
# With a recipient, the volume, settings and all existing Podman secrets are encrypted. Without
# one, the private backup holds the volume and settings only; secrets stay in Podman on this host.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=common.sh
. "$REPO/scripts/common.sh"
# shellcheck source=backup-lib.sh
. "$REPO/scripts/backup-lib.sh"

dest='' recipient=''
while (($#)); do
  case $1 in
    --dest) (($# >= 2)) || ql_die "--dest needs a new directory"; dest=$2; shift ;;
    --age-recipient) (($# >= 2)) || ql_die "--age-recipient needs a public key"; recipient=$2; shift ;;
    -h | --help) sed -n '2,5p' "$0"; exit 0 ;;
    *) ql_die "unknown option $1" ;;
  esac
  shift
done
[[ -z $recipient || $recipient =~ ^age1[0-9a-z]+$ ]] || ql_die "--age-recipient needs an age public key"
if [[ -n $recipient ]]; then
  command -v age >/dev/null || ql_die "age is required for encrypted backups"
  printf '' | age -r "$recipient" >/dev/null || ql_die "invalid age recipient"
fi
ql_require_rootless
ql_require_user_systemd
ql_lock "$APP"
[[ -f $ENV_FILE ]] || ql_die "settings file is missing: $ENV_FILE"
podman volume exists woowtechbot-data || ql_die "woowtechbot-data volume is missing"
[[ $(systemctl --user show -p LoadState --value woowtechbot.service) == loaded ]] \
  || ql_die "woowtechbot.service is not installed"
if [[ -z $dest ]]; then
  (umask 077; mkdir -p -- "$BACKUP_ROOT")
  chmod 700 -- "$BACKUP_ROOT"
  base=$BACKUP_ROOT/backup-$(date -u +%Y%m%d-%H%M%S)
  dest=$base
  n=2
  while [[ -e $dest ]]; do dest=$base-$n; n=$((n + 1)); done
fi
[[ ! -e $dest ]] || ql_die "$dest already exists; choose a new directory"
parent=$(dirname -- "$dest")
(umask 077; mkdir -p -- "$parent")
need=$(podman unshare du -sk "$(podman volume inspect --format '{{.Mountpoint}}' woowtechbot-data)" | cut -f1)
free=$(df -Pk -- "$parent" | awk 'NR==2 {print $4}')
((free > need + 102400)) || ql_die "not enough free space for a cold backup"

was_active=0
systemctl --user is-active --quiet woowtechbot.service && was_active=1
restart_bot() {
  if ((was_active)); then
    ql_info "starting woowtechbot after the cold backup"
    systemctl --user start woowtechbot.service || return 1
    app_wait_healthy woowtechbot 300 woowtechbot.service
  fi
}
ql_cleanup restart_bot restart_bot
if ((was_active)); then
  ql_info "stopping woowtechbot for a consistent backup"
  systemctl --user stop woowtechbot.service || ql_die "could not stop woowtechbot"
fi
[[ -z $(podman ps --filter volume=woowtechbot-data --format '{{.Names}}') ]] \
  || ql_die "the data volume is still in use by a running container"
wtb_capture "$dest" "$recipient"
wtb_manifest_load "$dest"
if [[ $WTB_B_MODE == plain ]]; then wtb_validate_archive "$dest"; fi
restart_bot || ql_die "backup is complete at $dest, but the bot did not restart"
ql_cleanup_clear restart_bot
ql_info "cold backup complete: $dest"
if [[ $WTB_B_MODE == plain ]]; then
  ql_warn "this backup holds model logins and sessions; protect the 0700 directory. Podman secrets were not copied"
else
  ql_info "volume, settings and the existing Podman secrets are encrypted for the age recipient"
fi
printf '%s\n' "$dest"
