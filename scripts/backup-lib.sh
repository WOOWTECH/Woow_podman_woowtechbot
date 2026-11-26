#!/usr/bin/env bash
# Shared, repo-owned cold backup format. Sourced after common.sh by backup.sh and restore.sh.
# Never source a backup's manifest: it is data, not shell code.
# shellcheck shell=bash
# shellcheck disable=SC2153 # WTB_* constants are set by common.sh before this file is sourced.

wtb_manifest_value() {
  local key=$1 file=$2
  sed -n "s/^${key}=//p" "$file"
}

wtb_manifest_load() {
  local dir=$1 allowed_name s actual expected known secret_list_pattern
  local -a expected_files=(manifest.txt)
  local -a backup_secrets=()
  [[ -f $dir/manifest.txt && -f $dir/SHA256SUMS ]] || ql_die "$dir is not a complete woowtechbot backup"
  WTB_B_FORMAT=$(wtb_manifest_value format "$dir/manifest.txt")
  WTB_B_VERSION=$(wtb_manifest_value version "$dir/manifest.txt")
  WTB_B_BASE=$(wtb_manifest_value base_image "$dir/manifest.txt")
  WTB_B_MODE=$(wtb_manifest_value mode "$dir/manifest.txt")
  WTB_B_RECIPIENT=$(wtb_manifest_value recipient "$dir/manifest.txt")
  WTB_B_SECRETS=$(wtb_manifest_value secrets "$dir/manifest.txt")
  [[ $WTB_B_FORMAT == woowtechbot-cold-v1 ]] || ql_die "unknown backup format in $dir"
  [[ $WTB_B_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?-[0-9]+$ ]] || ql_die "bad backup version"
  [[ $WTB_B_BASE =~ ^ghcr\.io/woowtech/amd64-woowtechbot@sha256:[0-9a-f]{64}$ ]] || ql_die "bad backup base image pin"
  [[ $WTB_B_MODE == plain || $WTB_B_MODE == age ]] || ql_die "bad backup mode"
  if [[ $WTB_B_MODE == age ]]; then
    [[ $WTB_B_RECIPIENT =~ ^age1[0-9a-z]+$ ]] || ql_die "bad backup recipient"
  else
    [[ -z $WTB_B_RECIPIENT && -z $WTB_B_SECRETS ]] || ql_die "plain backups cannot contain secrets"
  fi
  secret_list_pattern='^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*$'
  [[ -z $WTB_B_SECRETS || $WTB_B_SECRETS =~ $secret_list_pattern ]] \
    || ql_die "bad backup secret list"
  read -r -a backup_secrets <<<"$WTB_B_SECRETS"
  for s in "${backup_secrets[@]}"; do
    known=0
    for allowed_name in "${WTB_SECRETS[@]}" "${WTB_TUNNEL_SECRETS[@]}"; do
      if [[ $s == "$allowed_name" ]]; then known=1; break; fi
    done
    ((known)) || ql_die "unknown secret in backup manifest"
    [[ -f $dir/secrets/$s.age ]] || ql_die "missing encrypted secret $s"
  done
  if [[ $WTB_B_MODE == age ]]; then
    expected_files+=(data.tar.age woowtechbot.env.age)
    for s in "${backup_secrets[@]}"; do expected_files+=("secrets/$s.age"); done
  else
    expected_files+=(data.tar woowtechbot.env)
  fi
  [[ $(stat -c %a -- "$dir") == 700 ]] || ql_die "$dir must have mode 0700"
  if find "$dir" ! -type d ! -type f -print -quit | grep -q .; then
    ql_die "backup contains a link or special file"
  fi
  if find "$dir" -type d -perm /077 -print -quit | grep -q .; then
    ql_die "backup directories must have mode 0700"
  fi
  if find "$dir" -type f -perm /077 -print -quit | grep -q .; then
    ql_die "backup files must not be readable by group or others"
  fi
  # Check the checksum list before sha256sum opens any named path. It may come from another host.
  expected=$(printf '%s\n' "${expected_files[@]}" | LC_ALL=C sort)
  actual=$(sed -nE 's/^[0-9a-f]{64}  ([A-Za-z0-9_./-]+)$/\1/p' "$dir/SHA256SUMS" | LC_ALL=C sort)
  [[ $actual == "$expected" && $(wc -l <"$dir/SHA256SUMS") -eq ${#expected_files[@]} ]] \
    || ql_die "backup checksum list has missing or unexpected paths"
  expected=$(printf '%s\n' SHA256SUMS "${expected_files[@]}" | LC_ALL=C sort)
  actual=$(find "$dir" -type f -printf '%P\n' | LC_ALL=C sort)
  [[ $actual == "$expected" ]] || ql_die "backup has unexpected or missing files"
  (cd -- "$dir" && sha256sum --check --quiet --strict SHA256SUMS) || ql_die "backup checksum mismatch in $dir"
  if [[ $WTB_B_MODE == age ]]; then
    [[ -f $dir/data.tar.age && -f $dir/woowtechbot.env.age ]] || ql_die "encrypted backup is incomplete"
  else
    [[ -f $dir/data.tar && -f $dir/woowtechbot.env ]] || ql_die "backup is incomplete"
  fi
}

wtb_validate_archive() {
  local dir=$1 identity=${2:-}
  if [[ $WTB_B_MODE == age ]]; then
    [[ -n $identity && -f $identity ]] || ql_die "encrypted backup needs --identity FILE"
    age -d -i "$identity" "$dir/data.tar.age" | python3 -I "$REPO/scripts/validate-backup-tar.py" - \
      || ql_die "cannot decrypt or validate the volume archive"
  else
    python3 -I "$REPO/scripts/validate-backup-tar.py" "$dir/data.tar" \
      || ql_die "invalid volume archive"
  fi
}

wtb_export_volume() {
  local volume=$1 dir=$2 recipient=${3:-} output
  podman volume exists "$volume" || ql_die "volume $volume does not exist"
  output=$dir/data.tar
  if [[ -n $recipient ]]; then
    output+=.age
    (umask 077; podman volume export "$volume" | age -r "$recipient" >"$output.partial") \
      || ql_die "encrypted volume export failed; incomplete backup is in $dir"
  else
    (umask 077; podman volume export "$volume" -o "$output.partial") \
      || ql_die "volume export failed; incomplete backup is in $dir"
  fi
  [[ -s $output.partial ]] || ql_die "empty volume export"
  mv -- "$output.partial" "$output"
  chmod 600 -- "$output"
}

wtb_import_volume() {
  local volume=$1 dir=$2 identity=${3:-}
  if [[ $WTB_B_MODE == age ]]; then
    age -d -i "$identity" "$dir/data.tar.age" | podman volume import "$volume" - \
      || return 1
  else
    podman volume import "$volume" "$dir/data.tar" || return 1
  fi
}

wtb_empty_volume() {
  local volume=$1 mount users
  users=$(podman ps --filter "volume=$volume" --format '{{.Names}}') || return 1
  [[ -z $users ]] || { ql_warn "$volume is still in use by a running container"; return 1; }
  mount=$(podman volume inspect --format '{{.Mountpoint}}' "$volume") || return 1
  [[ $mount == /* && $mount != / && $mount == */volumes/"$volume"/_data ]] \
    || { ql_warn "unexpected mountpoint for $volume"; return 1; }
  podman unshare find "$mount" -mindepth 1 -delete
}

wtb_export_secrets() {
  local dir=$1 recipient=$2 s names=''
  [[ -n $recipient ]] || return 0
  mkdir -m 700 -- "$dir/secrets"
  for s in "${WTB_SECRETS[@]}" "${WTB_TUNNEL_SECRETS[@]}"; do
    podman secret exists "$s" || continue
    # The JSON form preserves trailing newlines, which command substitution would strip.
    (umask 077; podman secret inspect --showsecret --format '{{json .SecretData}}' "$s" \
      | python3 -I -c 'import json,sys; sys.stdout.buffer.write(json.load(sys.stdin).encode())' \
      | age -r "$recipient" >"$dir/secrets/$s.age.partial") \
      || ql_die "cannot encrypt secret $s"
    mv -- "$dir/secrets/$s.age.partial" "$dir/secrets/$s.age"
    names+="${names:+ }$s"
  done
  WTB_EXPORTED_SECRETS=$names
}

wtb_restore_secret_set() {
  local dir=$1 names=$2 identity=$3 s file
  for s in "${WTB_SECRETS[@]}" "${WTB_TUNNEL_SECRETS[@]}"; do
    file=$dir/secrets/$s.age
    if [[ " $names " == *" $s "* ]]; then
      age -d -i "$identity" "$file" | podman secret create --replace "$s" - >/dev/null || return 1
    elif podman secret exists "$s"; then
      podman secret rm "$s" >/dev/null || return 1
    fi
  done
}

wtb_capture() {
  local dir=$1 recipient=${2:-} mode=plain
  [[ ! -e $dir ]] || ql_die "$dir already exists"
  [[ -f $ENV_FILE ]] || ql_die "settings file is missing: $ENV_FILE"
  (umask 077; mkdir -p -- "$dir") || ql_die "cannot create $dir"
  chmod 700 -- "$dir"
  if [[ -n $recipient ]]; then
    mode=age
    (umask 077; age -r "$recipient" "$ENV_FILE" >"$dir/woowtechbot.env.age.partial") \
      || ql_die "cannot encrypt settings"
    mv -- "$dir/woowtechbot.env.age.partial" "$dir/woowtechbot.env.age"
  else
    install -m 600 -- "$ENV_FILE" "$dir/woowtechbot.env"
  fi
  wtb_export_volume woowtechbot-data "$dir" "$recipient"
  WTB_EXPORTED_SECRETS=''
  wtb_export_secrets "$dir" "$recipient"
  (umask 077; printf 'format=woowtechbot-cold-v1\nversion=%s\nbase_image=%s\nmode=%s\nrecipient=%s\nsecrets=%s\ncreated_utc=%s\n' \
    "$WTB_VERSION" "$WTB_BASE_IMAGE" "$mode" "$recipient" "$WTB_EXPORTED_SECRETS" "$(date -u +%FT%TZ)" \
    >"$dir/manifest.txt")
  app_checksums "$dir"
}
