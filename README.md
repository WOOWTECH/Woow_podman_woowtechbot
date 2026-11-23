# woowtechbot for Podman

woowtechbot 是 WOOWTECH 的團隊 AI 助理，基於 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 開源專案（Apache-2.0）。這個 repo 讓它以 rootless Podman（Quadlet、systemd --user）在自己的 Linux 主機上執行。功能以 woowtechbot 的 Home Assistant 外掛版與 WOOW PaaS 雲端服務版為準，三個版本要一致。

> **狀態：第 1 階段（核心）已在實機上驗證（2026-11-24，Intel N100、Ubuntu 24.04、Podman 4.9.3）；對外網址與登入信的程式已備好、等開通後實測；Cockpit 管理頁與備份在後續階段。** 容器映像目前不公開，安裝時需要 GHCR 讀取權限。

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
scripts/secret.sh set tunnel-token               # 選填：bot 自己的對外通道（見「對外網址」）
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

在瀏覽器打開配對連結後，配對碼會自動帶入，按「連線」就會登入。頁面上「在伺服器上執行 npx openmausbot pair」是上游的說明文字；在 Podman 上請改用 `scripts/pair.sh browser`。

**誰算管理員**：能在這台主機用這個帳號執行 podman 的人，就能產生配對碼，等於 HA 上的管理員。之後的 Cockpit 管理頁也會限定只有管理員能用。

## 對外網址

容器只在主機的 `127.0.0.1:18799` 開入口；有設定發布網址時，另開 `127.0.0.1:18781`。8099（HA Ingress）和 8799（應用程式的擁有者 API）永遠不會對外開放，也不可以改用主機網路模式。

對外網址由 Cloudflare Tunnel 轉進來，兩種接法擇一：

| 接法 | 路由的服務位址 | 適合 |
|---|---|---|
| 主機上已經有通道，而且還有空的路由 | bot：`http://localhost:18799`；發布網站：`http://localhost:18781` | 已安裝 [Woow_cloudflare_tunnel_webgui](https://github.com/WOOWTECH/Woow_cloudflare_tunnel_webgui) 的主機 |
| bot 自己的連線程式（選配） | bot：`http://woowtechbot:8080`；發布網站：`http://woowtechbot:8081` | 沒有通道，或現有通道的路由已用滿 |

用 bot 自己的連線程式時，把通道金鑰放進密鑰再安裝一次即可。金鑰只給連線程式，bot 讀不到：

```bash
scripts/secret.sh set tunnel-token        # 貼上通道金鑰（輸入時不顯示）
scripts/secret.sh set apps-tunnel-token   # 只有發布網站用另一條通道時才需要
scripts/install.sh
```

網址開通後：

1. 在設定檔填入 `WTB_PUBLIC_URL`（和選填的 `WTB_PUBLISHED_URL`），執行 `scripts/install.sh`。
2. 執行 `scripts/check-public.sh`，再執行 `scripts/check-public.sh --pairing`，從外面驗收網址、登入邊界、發布網站的隔離，以及一次完整的配對與登出。

注意：

- 這兩個網址要設成公開路由，不要在前面加 Cloudflare Access 的登入頁，否則手機 App 連不上。bot 自己會要求配對或登入。
- 發布網址要用另一個網域名稱，不能是 bot 網址的上層或下層網域。
- 沒有發布網址也可以用：發布的網站會放在 bot 網址的 `/published/` 底下，但在較嚴格的沙盒裡，JavaScript module、讀取 JSON 與 localStorage 不能用。

## Email 驗證碼登入

信件由公司的代寄服務寄出，主機上不放 SMTP 密碼。每一台主機要有自己的代寄憑證，不沿用 HA 的。憑證由公司平台的系統管理員核發，需要提供：

- 站點名稱與負責人；
- 登入網址，也就是 `WTB_PUBLIC_URL`；
- 1 到 20 個測試收件信箱。新憑證一開始是測試模式，只會寄給這些信箱。

拿到代寄網址與權杖後：

```bash
scripts/install.sh --set WTB_SIGNIN_RELAY_URL=https://<公司代寄網址>/api/woowtechbot/signin-mail
scripts/secret.sh set signin-relay-token   # 貼上權杖（輸入時不顯示）
scripts/install.sh
```

驗收：收件匣收到 8 碼驗證碼並成功登入一次；同一碼再用會被拒（401）。通過後才由管理員關掉測試模式。憑證最長 365 天，到期前要換發。

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

## 測試

- `node --test tests/*.test.cjs`、`tests/dryrun.local.sh`：不需要映像，CI 每次都跑。
- `tests/smoke.sh`：安裝後在主機上跑，檢查服務、開放的埠、設定與密鑰的權限、資源上限、配對碼只能用一次、配對碼不進日誌。會產生並用掉一組配對碼，最後清乾淨。
- `tests/ha-suites.sh <HA 外掛的 checkout>`：拿同一版 HA 外掛自己的測試來跑 Podman 映像（工具、發布網站兩種模式、Email 登入），不另外抄一份。
- `tests/public.sh`：用本機的 TLS 替身試跑 `check-public.sh`，也確認它會擋下接錯的設定。
- `tests/runtime.sh`：用一個用完即丟、沒有網路的容器，跑 HA 外掛的執行期檢查（Odoo MCP 唯讀閘道、未配對與假冒 HA 入口的請求被拒、引擎版本），不影響已安裝的 bot。

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
