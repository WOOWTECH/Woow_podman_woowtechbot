#!/usr/bin/env bash
# Real Podman volume round trips for the repo's cold backup format; never touches woowtechbot-data.
# Tests plaintext and age-encrypted data, settings and a synthetic secret, plus bad archive paths.
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2034 # These arrays are read by the sourced backup-lib.sh.
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=../scripts/lib/quadlet-lib.sh
. "$REPO/scripts/lib/quadlet-lib.sh"
# shellcheck source=../scripts/common.sh
. "$REPO/scripts/common.sh"
# shellcheck source=../scripts/backup-lib.sh
. "$REPO/scripts/backup-lib.sh"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/wtb-backup-test.XXXXXX")
name=wtb-backup-test-${tmp##*.}
secret=$name-secret
clean() {
  podman volume rm "$name" >/dev/null 2>&1 || :
  podman secret rm "$secret" >/dev/null 2>&1 || :
  rm -rf -- "$tmp"
}
ql_cleanup clean clean
podman volume create --label io.woowtech.app=woowtechbot-test "$name" >/dev/null
mount=$(podman volume inspect --format '{{.Mountpoint}}' "$name")
podman unshare python3 -I - "$mount" <<'PY'
from pathlib import Path
import sqlite3, sys
root = Path(sys.argv[1]); (root / 'nested').mkdir()
(root / 'nested' / 'sentinel.txt').write_bytes(b'synthetic woowtechbot backup round trip\n')
(root / 'options.json').symlink_to('/run/woowtechbot/options.json')
db = sqlite3.connect(root / 'nested' / 'state.sqlite')
db.execute('create table items (value text)'); db.execute('insert into items values (?)', ('retained',))
db.commit(); db.close()
PY
expected=$(podman unshare sha256sum "$mount/nested/sentinel.txt" | cut -d' ' -f1)

mkdir -m 700 "$tmp/plain"
wtb_export_volume "$name" "$tmp/plain" ''
install -m 600 "$REPO/config/woowtechbot.env.example" "$tmp/plain/woowtechbot.env"
printf 'format=woowtechbot-cold-v1\nversion=%s\nbase_image=%s\nmode=plain\nrecipient=\nsecrets=\n' \
  "$WTB_VERSION" "$WTB_BASE_IMAGE" >"$tmp/plain/manifest.txt"
chmod 600 "$tmp/plain/manifest.txt"
app_checksums "$tmp/plain"
wtb_manifest_load "$tmp/plain"
wtb_validate_archive "$tmp/plain"
wtb_empty_volume "$name"
wtb_import_volume "$name" "$tmp/plain"
[[ $(podman unshare sha256sum "$mount/nested/sentinel.txt" | cut -d' ' -f1) == "$expected" ]]
[[ $(podman unshare readlink "$mount/options.json") == /run/woowtechbot/options.json ]]
[[ $(podman unshare python3 -I - "$mount/nested/state.sqlite" <<'PY'
import sqlite3, sys
db=sqlite3.connect(sys.argv[1]); print(db.execute('select value from items').fetchone()[0]); db.close()
PY
) == retained ]]
printf 'ok   plaintext backup and restore: files, symlink, SQLite row\n'

age-keygen -o "$tmp/identity" >/dev/null 2>&1
chmod 600 "$tmp/identity"
recipient=$(age-keygen -y "$tmp/identity")
mkdir -m 700 "$tmp/encrypted"
wtb_export_volume "$name" "$tmp/encrypted" "$recipient"
age -r "$recipient" "$REPO/config/woowtechbot.env.example" >"$tmp/encrypted/woowtechbot.env.age"
chmod 600 "$tmp/encrypted/woowtechbot.env.age"
printf 'synthetic-secret\n\n' | podman secret create "$secret" - >/dev/null
WTB_SECRETS=("$secret")
WTB_TUNNEL_SECRETS=()
wtb_export_secrets "$tmp/encrypted" "$recipient"
age -d -i "$tmp/identity" "$tmp/encrypted/secrets/$secret.age" \
  | python3 -I -c 'import sys; assert sys.stdin.buffer.read() == b"synthetic-secret\n\n"'
printf changed | podman secret create --replace "$secret" - >/dev/null
wtb_restore_secret_set "$tmp/encrypted" "$secret" "$tmp/identity"
podman secret inspect --showsecret --format '{{json .SecretData}}' "$secret" \
  | python3 -I -c 'import json,sys; assert json.load(sys.stdin) == "synthetic-secret\n\n"'
printf 'format=woowtechbot-cold-v1\nversion=%s\nbase_image=%s\nmode=age\nrecipient=%s\nsecrets=%s\n' \
  "$WTB_VERSION" "$WTB_BASE_IMAGE" "$recipient" "$secret" >"$tmp/encrypted/manifest.txt"
chmod 600 "$tmp/encrypted/manifest.txt"
app_checksums "$tmp/encrypted"
wtb_manifest_load "$tmp/encrypted"
wtb_validate_archive "$tmp/encrypted" "$tmp/identity"
wtb_empty_volume "$name"
wtb_import_volume "$name" "$tmp/encrypted" "$tmp/identity"
[[ $(podman unshare sha256sum "$mount/nested/sentinel.txt" | cut -d' ' -f1) == "$expected" ]]
printf 'ok   encrypted backup and restore: volume, settings, synthetic secret\n'

printf x >>"$tmp/encrypted/data.tar.age"
if (wtb_manifest_load "$tmp/encrypted" >/dev/null 2>&1); then
  echo 'FAIL encrypted archive tampering was accepted' >&2; exit 1
fi
printf 'outside the backup\n' >"$tmp/outside"
(cd "$tmp/plain" && sha256sum ../outside >>SHA256SUMS)
if (wtb_manifest_load "$tmp/plain" >/dev/null 2>&1); then
  echo 'FAIL checksum path outside the backup was accepted' >&2; exit 1
fi
python3 -I - "$tmp/plain" <<'PY'
import io, sys, tarfile
from pathlib import Path
root=Path(sys.argv[1])
for kind in ('parent', 'symlink'):
    with tarfile.open(root / f'bad-{kind}.tar', 'w') as archive:
        if kind == 'parent':
            data=b'x'; info=tarfile.TarInfo('../escape'); info.size=len(data)
            archive.addfile(info, io.BytesIO(data))
        else:
            link=tarfile.TarInfo('out'); link.type=tarfile.SYMTYPE; link.linkname='/tmp'
            archive.addfile(link)
            data=b'x'; info=tarfile.TarInfo('out/escape'); info.size=len(data)
            archive.addfile(info, io.BytesIO(data))
PY
for kind in parent symlink; do
  if python3 -I "$REPO/scripts/validate-backup-tar.py" "$tmp/plain/bad-$kind.tar" >/dev/null 2>&1; then
    echo "FAIL $kind archive path was accepted" >&2; exit 1
  fi
done
printf 'ok   checksum tampering and unsafe archive paths are refused\n'
