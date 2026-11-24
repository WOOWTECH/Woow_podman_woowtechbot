#!/usr/bin/env bash
# scripts/cockpit-page.sh: the woowtechbot page in Cockpit, for this host's administrators.
#
#   sudo scripts/cockpit-page.sh install [--owner ACCOUNT] [--group GROUP]
#   sudo scripts/cockpit-page.sh uninstall
#   scripts/cockpit-page.sh status
#   --dry-run (install, uninstall): say what would change and change nothing
#
# The page is listed under Tools for the members of GROUP (default sudo, or wheel where there is no
# sudo group) and works only while Cockpit's administrative access is on, as the HA page works only
# for HA administrators. Its root helper runs podman as ACCOUNT, the account that runs the bot
# (default: the owner of this checkout), and never restarts or changes the bot. Needs Cockpit 362
# or later and python3. Run without sudo, install and uninstall ask for it.
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
SRC=$REPO/cockpit
PAGES=/usr/local/share/cockpit
PAGE_DIR=$PAGES/woowtechbot
PAGE_FILES=(manifest.json index.html bot.css bot.js)
HELPER=/usr/local/libexec/woowtech-cockpit-woowtechbot
ETC=/etc/woowtech-cockpit/woowtechbot
CONFIG=$ETC/config.json
GATE_DIR=$ETC/admins
GATE=$GATE_DIR/visible
LOCKS=/run/woowtech-cockpit-woowtechbot
COCKPIT_MIN=362
ACCOUNT_RE='^[a-z_][a-z0-9_-]{0,31}$'

die() { printf 'cockpit-page：%s\n' "$*" >&2; exit 1; }
say() { printf 'cockpit-page：%s\n' "$*"; }

args=("$@")
command=${1:-}
(($#)) && shift
owner='' group='' dry=0
while (($#)); do
  case $1 in
    --owner | --group)
      (($# >= 2)) || die "$1 後面要接名稱"
      if [[ $1 == --owner ]]; then owner=$2; else group=$2; fi
      shift ;;
    --dry-run) dry=1 ;;
    -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "不認得的選項 $1（看 --help）" ;;
  esac
  shift
done
case $command in
  install | uninstall | status) ;;
  -h | --help | '') sed -n '2,14p' "$0"; exit 0 ;;
  *) die "不認得的指令 $command（看 --help）" ;;
esac
if [[ $command != status ]] && ((EUID != 0 && !dry)); then
  say "需要管理員權限，接下來會用 sudo 執行。"
  exec sudo -- bash "$REPO/scripts/cockpit-page.sh" "${args[@]}"
fi
umask 022

# run: a change, or only its description under --dry-run
run() {
  if ((dry)); then printf '  [dry-run] %s\n' "$*"; else "$@"; fi
}

# as_owner CMD...: a command as the bot's account, with its user manager, the way the helper does it
as_owner() {
  local uid
  uid=$(id -u "$owner")
  runuser -u "$owner" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$(getent passwd "$owner" | cut -d: -f6)" \
    XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}

cockpit_version() { cockpit-bridge --version 2>/dev/null | sed -n 's/^Version: \([0-9]*\).*/\1/p'; }

check_owner() {
  owner=${owner:-$(stat -c %U -- "$REPO")}
  [[ $owner =~ $ACCOUNT_RE ]] || die "帳號名稱不正確：$owner"
  getent passwd "$owner" >/dev/null || die "找不到帳號 $owner"
  [[ $(id -u "$owner") != 0 ]] || die "woowtechbot 要用一般帳號的 rootless Podman 執行，不能是 root；請用 --owner 指定"
  if [[ ! -e /var/lib/systemd/linger/$owner ]]; then
    say "注意：$owner 沒有開 linger，沒登入時頁面可能讀不到 bot（loginctl enable-linger $owner）"
  fi
  if ((EUID == 0)) && ! as_owner podman container exists woowtechbot 2>/dev/null; then
    say "注意：$owner 目前沒有 woowtechbot 容器；頁面會顯示「尚未安裝」，裝好 bot 就會正常"
  fi
}

check_group() {
  if [[ -z $group ]]; then
    if getent group sudo >/dev/null; then group=sudo
    elif getent group wheel >/dev/null; then group=wheel
    else die "找不到管理員群組 sudo 或 wheel；請用 --group 指定"
    fi
  fi
  getent group "$group" >/dev/null || die "找不到群組 $group"
}

# swap_dir NEW DEST: put a staged directory in place; the old copy is removed after the swap
swap_dir() {
  local new=$1 dest=$2 old=''
  if [[ -e $dest ]]; then
    old=$(mktemp -d "${PAGES%/*}/.woowtechbot-cockpit-old.XXXXXX")
    mv -T -- "$dest" "$old/page"
  fi
  mv -T -- "$new" "$dest"
  [[ -z $old ]] || rm -rf -- "$old"
}

install_page() {
  local version stage f
  command -v cockpit-bridge >/dev/null || die "這台主機沒有安裝 Cockpit"
  version=$(cockpit_version)
  [[ -n $version ]] || die "讀不到 Cockpit 的版本"
  ((version >= COCKPIT_MIN)) || die "Cockpit $version 太舊，頁面需要 $COCKPIT_MIN 以上"
  [[ -x /usr/bin/python3 ]] || die "頁面元件需要 /usr/bin/python3"
  for f in "${PAGE_FILES[@]}" ../woowtech-cockpit-woowtechbot; do
    [[ -f $SRC/page/$f ]] || die "repo 裡少了 cockpit/page/$f"
  done
  check_owner
  check_group
  say "安裝 woowtechbot 頁面：bot 帳號 $owner，看得到頁面的群組 $group（Cockpit $version）"
  run install -d -o root -g root -m 0755 "$PAGES" /usr/local/libexec /etc/woowtech-cockpit "$ETC"
  if ((dry)); then
    printf '  [dry-run] %s\n' "copy cockpit/page to $PAGE_DIR" "install the helper as $HELPER" \
      "write $CONFIG (owner $owner)" "create $GATE_DIR (root:$group 0750) and $GATE"
  else
    stage=$(mktemp -d "${PAGES%/*}/.woowtechbot-cockpit-new.XXXXXX")
    for f in "${PAGE_FILES[@]}"; do install -o root -g root -m 0644 -- "$SRC/page/$f" "$stage/$f"; done
    chmod 0755 "$stage"
    swap_dir "$stage" "$PAGE_DIR"
    install -o root -g root -m 0755 -- "$SRC/woowtech-cockpit-woowtechbot" "$HELPER.new"
    mv -f -- "$HELPER.new" "$HELPER"
    printf '{"owner": "%s"}\n' "$owner" > "$CONFIG.new"
    chown root:root "$CONFIG.new"; chmod 0644 "$CONFIG.new"
    mv -f -- "$CONFIG.new" "$CONFIG"
    install -d -o root -g "$group" -m 0750 "$GATE_DIR"
    chown root:"$group" "$GATE_DIR"; chmod 0750 "$GATE_DIR"
    printf '%s\n' "This file shows the woowtechbot page in Cockpit to the members of $group." \
      "Remove the page with scripts/cockpit-page.sh uninstall." > "$GATE"
    chown root:root "$GATE"; chmod 0644 "$GATE"
    self_check
    say "完成。重新整理 Cockpit 的畫面，在左側「工具」找到 woowtechbot；使用時要開啟「管理員存取權限」。"
  fi
}

# self_check: the installed helper, run as root the way the page runs it (no codes are made)
self_check() {
  local out
  if out=$("$HELPER" state 2>/dev/null); then
    python3 -I -c '
import json, sys
d = json.loads(sys.argv[1]); box = d.get("container"); app = d.get("app")
if not box: print("cockpit-page：自我檢查：頁面元件正常；這個帳號還沒有 woowtechbot 容器")
elif app: print("cockpit-page：自我檢查：woowtechbot 運作中（%s，App %s）" % (box.get("version") or "?", app.get("version") or "?"))
else: print("cockpit-page：自我檢查：容器狀態 %s；%s" % (box.get("status"), d.get("appError") or "App 還沒準備好"))
' "$out"
  else
    say "自我檢查沒有通過：$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1]).get("error", "?"))' "$out" 2>/dev/null || echo "$out")"
    return 1
  fi
}

uninstall_page() {
  local f
  say "移除 woowtechbot 頁面（bot 本身不受影響）"
  for f in "$PAGE_DIR" "$HELPER" "$GATE" "$CONFIG" "$LOCKS"; do
    [[ -e $f ]] && run rm -rf -- "$f"
  done
  for f in "$GATE_DIR" "$ETC"; do
    [[ -d $f ]] && run rmdir --ignore-fail-on-non-empty -- "$f"
  done
  ((dry)) || say "完成。重新整理 Cockpit 的畫面後，選單裡就不會有 woowtechbot。"
}

status_page() {
  local f state
  for f in "${PAGE_FILES[@]}"; do
    if [[ ! -f $PAGE_DIR/$f ]]; then state="未安裝"
    elif cmp -s -- "$SRC/page/$f" "$PAGE_DIR/$f"; then state="和 repo 相同"
    else state="和 repo 不同（要更新就重新 install）"
    fi
    printf '頁面 %-13s %s\n' "$f" "$state"
  done
  if [[ ! -f $HELPER ]]; then state="未安裝"
  elif cmp -s -- "$SRC/woowtech-cockpit-woowtechbot" "$HELPER"; then state="和 repo 相同"
  else state="和 repo 不同（要更新就重新 install）"
  fi
  printf '後端元件      %s\n' "$state"
  if [[ -f $CONFIG ]]; then
    printf 'bot 帳號      %s\n' "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["owner"])' "$CONFIG" 2>/dev/null || echo '設定檔格式不正確')"
  else
    printf 'bot 帳號      未設定\n'
  fi
  if [[ -d $GATE_DIR ]]; then
    printf '看得到的群組  %s\n' "$(stat -c %G -- "$GATE_DIR")"
  else
    printf '看得到的群組  未設定（頁面不會出現在選單）\n'
  fi
  printf 'Cockpit       %s\n' "$(cockpit_version || true)"
  if ((EUID == 0)) && [[ -x $HELPER ]]; then self_check || true; fi
}

case $command in
  install) install_page ;;
  uninstall) uninstall_page ;;
  status) status_page ;;
esac
