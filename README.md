# woowtechbot for Podman

woowtechbot 是 WOOWTECH 的團隊 AI 助理，基於 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 開源專案（Apache-2.0）。這個 repo 讓它以 rootless Podman（Quadlet、systemd --user）在自己的 Linux 主機上執行。功能以 woowtechbot 的 Home Assistant 外掛版與 WOOW PaaS 雲端服務版為準，三個版本要一致。

> **狀態：第 1 階段（核心）開發中，尚未完成實機驗收。** 容器映像目前不公開，安裝時需要 GHCR 讀取權限。

## 它怎麼運作

Podman 版直接執行 HA 外掛的映像（`ghcr.io/woowtech/amd64-woowtechbot:0.1.7-rc.14`，以 digest 固定），外面只加一層 Podman 啟動程式。在 HA 上，Supervisor 會把外掛設定寫成 `/data/options.json` 並先檢查一遍；Podman 沒有 Supervisor，所以這一層做同樣的事：

1. 讀 `~/.config/woowtechbot/woowtechbot.env` 的 `WTB_*` 設定，以及選用的 podman secret；
2. 照 HA 外掛 `config.yaml` 的規則檢查，再用外掛自己的檢查程式檢查；有錯就停下，並指出是哪個設定（結束碼 78）；
3. 把設定寫到容器內的私有 tmpfs，`/data/options.json` 只是連結，所以帳密不會留在資料磁碟或它的備份裡；
4. 執行 HA 外掛原本的程式，程式不做任何修改。

## 需求

- x86_64 主機（映像只有 amd64）、rootless Podman 4.9 以上（Ubuntu 24.04）、systemd user 與 linger。
- 映像約 6.6 GiB，資料建議至少留 20 GB；容器預設上限 4 GiB 記憶體、2 核。
- GHCR 讀取權限：先 `podman login ghcr.io`（read:packages 權杖），或安裝時加 `--gh-auth` 使用 gh CLI 的登入。

## 安裝

```bash
git clone https://github.com/WOOWTECH/Woow_podman_woowtechbot.git
cd Woow_podman_woowtechbot
scripts/install.sh            # 第一次只會建立設定檔 ~/.config/woowtechbot/woowtechbot.env
scripts/install.sh --gh-auth  # 看過設定後再執行一次：拉映像、建置、檢查設定、啟動
```

`install.sh` 可以重複執行，沒有變更就不會重啟。改了設定或密鑰後，再執行一次即可套用。

## 設定

設定檔每一行都是 `KEY=VALUE`。下表的 `WTB_*` 設定和 HA 外掛的選項同名同義：

| 設定 | HA 外掛選項 | 說明 |
|---|---|---|
| `WTB_PUBLIC_URL` | `public_url` | 手機與其他瀏覽器使用的網址，例如 `https://bot.example.com`。設為 HTTPS 才會啟用「發布網站」 |
| `WTB_PUBLISHED_URL` | `published_url` | 選填。發布網站專用的另一個 HTTPS 網址，要用不同的網域 |
| `WTB_FIRST_ADMIN_EMAIL` | `first_admin_email` | 選填。系統還沒有管理員時，用這個信箱建立第一位管理員，只套用一次 |
| `WTB_SIGNIN_RELAY_URL` | `signin_relay_url` | 選填。公司代寄登入信的網址；權杖放在密鑰 `signin-relay-token` |
| `WTB_SIGNIN_ACCESS_CLIENT_ID` | `signin_access_client_id` | 選填。代寄網址前若有 Cloudflare Access，填它的 client id；secret 放在密鑰裡 |
| `WTB_LLM_GW_MAX_TOKENS` | `llm_gw_max_tokens` | OpenAI 相容模型的輸出上限，預設 32000 |
| `WTB_LLM_GW_ENABLED`、`WTB_LLM_GW_UPSTREAM` | `llm_gw_enabled`、`llm_gw_upstream` | 選配的模型請求閘道（`http://127.0.0.1:8092/v1`） |
| `WTB_TURNS_MAX_RUNNING` | （HA 為 auto） | 同時執行的對話數，預設 3；PaaS 是 5 |

`WOOW_WTB_*` 是安裝參數：開放的位址與埠（預設 `127.0.0.1:18799`，發布網站用 `18781`），以及記憶體、CPU、程序數的上限。

## 密鑰

帳密一律存成 podman secret，不寫進設定檔。容器內只有 root 讀得到；bot 以 `maus` 身分執行，讀不到。

```bash
scripts/secret.sh list
scripts/secret.sh set signin-relay-token        # 公司代寄登入信的權杖（wtbha1.…）
scripts/secret.sh set signin-access-client-secret
scripts/secret.sh set apporo-odoo-mcp-url        # 選填：Odoo MCP 唯讀
scripts/secret.sh set woow-prod-odoo-mcp-url
scripts/install.sh                               # 套用
```

## 配對

```bash
scripts/pair.sh browser   # 瀏覽器一次性配對碼與連結
scripts/pair.sh phone     # 手機 App：終端機顯示 QR，另附伺服器網址與配對碼（需要 WTB_PUBLIC_URL）
scripts/pair.sh list
scripts/pair.sh cancel browser|phone|all
```

規則和 HA 管理員配對頁相同：配對碼 10 分鐘內有效、只能用一次，取得管理員權限；同一類重新產生時，舊的那組會作廢；取消不會讓已登入的裝置登出。配對碼只顯示在你的終端機，不會寫進日誌。

**誰算管理員**：能在這台主機用這個帳號執行 podman 的人，就能產生配對碼，等於 HA 上的管理員。之後的 Cockpit 管理頁也會限定只有管理員能用。

## 對外網址

容器只在主機的 `127.0.0.1:18799` 開入口；有設定發布網址時，另開 `127.0.0.1:18781`。對外網址由同一台主機上的 Cloudflare Tunnel（PaaS Security Access）轉進來。8099（HA Ingress）和 8799（應用程式的擁有者 API）永遠不會對外開放，也不可以改用主機網路模式。

## 更新與移除

- 更新：拉新版本的 repo 後執行 `scripts/install.sh`。舊版的本機映像會保留，方便退回。
- 移除：執行 `scripts/uninstall.sh`，資料磁碟、密鑰與設定都會保留；加 `--purge` 才會刪除，刪除前會先做一份最後備份。

## 已知限制

- 沒有 HA 側邊欄，也沒有 HA 管理員驗證，改由主機（以及之後的 Cockpit）權限決定誰是管理員。
- 沒有 HA Supervisor 備份；備份與還原腳本在後續階段提供。
- 外掛程式目前要求一定要有 `ingress_origin`，Podman 會自動用 bot 自己的網址代入。
- Chromium 的沙盒是關閉的，改靠容器隔離，和 HA、PaaS 相同。
- 沒有 FCM 遠端推播；App 開著或「保持連線」時才收得到通知。
- 官方 App 2.0.0 從檔案選擇器選 CSV 會被拒，可以改成 .txt 或壓成 ZIP（上游 #7084）。配對連結沒有確認畫面。
- Codex 的工具範圍一定要保留 `native:*`。
- 模型帳號的用量由各帳號自己負責。

## 與其他版本對照

| | HA 外掛 | PaaS | Podman（本 repo） |
|---|---|---|---|
| 執行位置 | Home Assistant 主機 | WOOW PaaS 工作區 | 自己的 Linux 主機 |
| 管理入口 | HA 側邊欄 | PaaS 服務設定頁 | 主機指令；Cockpit 管理頁規劃中 |
| 對外網址 | CF Web GUI＋Security Access | 平台自動建立 | 主機上的 Cloudflare Tunnel＋Security Access |
| 資源 | 共用主機，不設上限 | 4 CPU／8 GiB，5 個對話 | 預設 2 核／4 GiB，3 個對話 |
| 備份 | HA 冷備份 | 刪除後保留 7 天 | 套件備份與還原（後續階段） |

## 授權

本 repo 的封裝程式以 Apache License 2.0 授權，見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。容器映像內附各元件自己的授權，以及上游 OpenMausBot 的 NOTICE。本專案不代表 OpenMausBot 作者背書。
