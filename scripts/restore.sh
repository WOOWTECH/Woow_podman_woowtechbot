#!/usr/bin/env bash
# Restore a complete scripts/backup.sh directory over the installed bot. A pre-restore cold
# backup is retained; on failure, the script attempts to put it back and restart the old bot.
#   scripts/restore.sh BACKUP_DIR [--verify-only] [--identity AGE_KEY] [--with-secrets] [--yes]
# --with-secrets requires an encrypted backup and its private age identity. By default the
# current Podman secrets are kept, which is sufficient for same-host recovery.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=common.sh
. "$REPO/scripts/common.sh"
# shellcheck source=backup-lib.sh
. "$REPO/scripts/backup-lib.sh"

source_dir='' identity='' with_secrets=0 yes=0 verify_only=0
while (($#)); do
  case $1 in
    --verify-only) verify_only=1 ;;
    --identity) (($# >= 2)) || ql_die "--identity needs a private key file"; identity=$2; shift ;;
    --with-secrets) with_secrets=1 ;;
    --yes) yes=1 ;;
    -h | --help) sed -n '2,7p' "$0"; exit 0 ;;
    -*) ql_die "unknown option $1" ;;
    *) [[ -z $source_dir ]] || ql_die "only one backup directory is accepted"; source_dir=$1 ;;
  esac
  shift
done
[[ -n $source_dir ]] || ql_die "usage: scripts/restore.sh BACKUP_DIR [--identity AGE_KEY] [--with-secrets] [--yes]"
source_dir=$(realpath -e -- "$source_dir") || ql_die "backup directory not found"
ql_require_rootless
ql_require_user_systemd
ql_lock "$APP"
wtb_manifest_load "$source_dir"
[[ ${WTB_B_VERSION%-*} == "${WTB_VERSION%-*}" && $WTB_B_BASE == "$WTB_BASE_IMAGE" ]] \
  || ql_die "backup uses $WTB_B_VERSION or a different HA image; check out and install its matching HA version first"
[[ $WTB_B_MODE == plain || -n $identity ]] || ql_die "encrypted backup needs --identity AGE_KEY"
((with_secrets == 0)) || [[ $WTB_B_MODE == age ]] || ql_die "this backup has no encrypted secrets"
wtb_validate_archive "$source_dir" "$identity"
temp=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/wtb-restore.XXXXXX")
chmod 700 "$temp"
ql_cleanup temp rm -rf -- "$temp"
if [[ $WTB_B_MODE == age ]]; then
  (umask 077; age -d -i "$identity" -o "$temp/woowtechbot.env" "$source_dir/woowtechbot.env.age") \
    || ql_die "cannot decrypt the settings"
else
  install -m 600 -- "$source_dir/woowtechbot.env" "$temp/woowtechbot.env"
fi
QL_ENV_MODE_CHECK=0 ql_env_load "$temp/woowtechbot.env"
app_refuse_env_secrets
if ((verify_only)); then
  ql_info "backup verified: $source_dir (HA ${WTB_B_VERSION%-*}, $WTB_B_MODE)"
  exit 0
fi
[[ $(systemctl --user show -p LoadState --value woowtechbot.service) == loaded ]] \
  || ql_die "woowtechbot.service is not installed; run scripts/install.sh first"
podman volume exists woowtechbot-data || ql_die "woowtechbot-data volume is missing"
podman image exists "$WTB_IMAGE" || ql_die "the matching image $WTB_IMAGE is not installed"
[[ -f $ENV_FILE ]] || ql_die "the current settings file is missing"

app_confirm "$APP" "$yes" "restore replaces the current bot data and settings; a pre-restore copy is kept"
(umask 077; mkdir -p -- "$BACKUP_ROOT")
chmod 700 -- "$BACKUP_ROOT"
base=$BACKUP_ROOT/pre-restore-$(date -u +%Y%m%d-%H%M%S)
pre=$base
n=2
while [[ -e $pre ]]; do pre=$base-$n; n=$((n + 1)); done

was_active=0
systemctl --user is-active --quiet woowtechbot.service && was_active=1
active_connectors=()
if ((with_secrets)); then
  for unit in woowtechbot-tunnel.service woowtechbot-apps-tunnel.service; do
    systemctl --user is-active --quiet "$unit" && active_connectors+=("$unit")
  done
fi
source_secret_names=$WTB_B_SECRETS
recipient=''
[[ $WTB_B_MODE == plain ]] || recipient=$WTB_B_RECIPIENT
dirty=0
rollback() {
  local rc=$? failed=0
  ((rc != 0)) || return 0
  ql_warn "restore failed; a pre-restore copy was attempted at $pre"
  systemctl --user stop woowtechbot.service >/dev/null 2>&1 || failed=1
  if ((dirty)); then
    if wtb_empty_volume woowtechbot-data && wtb_import_volume woowtechbot-data "$pre" "$identity"; then
      ql_info "restored the previous volume from $pre"
    else
      failed=1
      ql_warn "automatic volume rollback failed; the pre-restore copy is $pre"
    fi
    if [[ -n $recipient ]]; then
      if (umask 077; age -d -i "$identity" -o "$temp/old.env" "$pre/woowtechbot.env.age"); then
        install -m 600 -- "$temp/old.env" "$ENV_FILE" || failed=1
      else
        failed=1
      fi
    else
      install -m 600 -- "$pre/woowtechbot.env" "$ENV_FILE" || failed=1
    fi
    if ((with_secrets)); then
      wtb_restore_secret_set "$pre" "$old_secret_names" "$identity" || failed=1
    fi
  fi
  if ((was_active)); then
    "$REPO/scripts/install.sh" >/dev/null 2>&1 || failed=1
  else
    "$REPO/scripts/install.sh" --no-start >/dev/null 2>&1 || failed=1
  fi
  if ((${#active_connectors[@]})); then
    systemctl --user start "${active_connectors[@]}" >/dev/null 2>&1 || failed=1
  fi
  if ((failed)); then
    ql_warn "automatic rollback was incomplete; inspect $pre before retrying"
  else
    ql_info "the old bot state was restarted after the failed restore"
  fi
  return 0
}
ql_cleanup rollback rollback
ql_info "stopping woowtechbot before the pre-restore copy"
systemctl --user stop woowtechbot.service || ql_die "could not stop woowtechbot"
if ((${#active_connectors[@]})); then
  systemctl --user stop "${active_connectors[@]}" || ql_die "could not stop the tunnel connectors"
fi
[[ -z $(podman ps --filter volume=woowtechbot-data --format '{{.Names}}') ]] \
  || ql_die "the data volume is still in use by a running container"
wtb_capture "$pre" "$recipient"
old_secret_names=$WTB_EXPORTED_SECRETS
wtb_manifest_load "$pre"
ql_info "pre-restore copy is $pre"

dirty=1
wtb_empty_volume woowtechbot-data || ql_die "cannot empty the stopped data volume"
wtb_import_volume woowtechbot-data "$source_dir" "$identity" || ql_die "cannot import the backup volume"
install -m 600 -- "$temp/woowtechbot.env" "$ENV_FILE"
if ((with_secrets)); then wtb_restore_secret_set "$source_dir" "$source_secret_names" "$identity" || ql_die "cannot restore the encrypted secrets"; fi

"$REPO/scripts/install.sh" || ql_die "the restored bot did not pass install and health checks"
"$REPO/tests/smoke.sh" --no-pairing || ql_die "the restored bot failed the smoke checks"
dirty=0
ql_cleanup_clear rollback
ql_info "restore complete; the prior state remains at $pre"
