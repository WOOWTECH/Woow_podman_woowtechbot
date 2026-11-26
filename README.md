# woowtechbot for Podman

woowtechbot 是 WOOWTECH 的團隊 AI 助理，基於 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 開源專案（Apache-2.0）。這個 repo 讓它以 rootless Podman（Quadlet、systemd --user）在自己的 Linux 主機上執行。功能以 woowtechbot 的 Home Assistant 外掛版與 WOOW PaaS 雲端服務版為準，三個版本要一致。

> **狀態：核心與兩個對外網址已在實機上驗證（2026-11-24，Intel N100、Ubuntu 24.04、Podman 4.9.3），手機 App 的配對、聊天、附件上下傳、背景返回與短暫斷線也已在 Pixel Tablet 上實測；Cockpit 管理頁已安裝在這台主機並實際使用；Email 登入信已用公司代寄實際收信並登入驗收（2026-11-25，測試模式）；冷備份與還原已在實機驗證（2026-11-26）；手機通知尚未實測。** 容器映像目前不公開，安裝時需要 GHCR 讀取權限。

## 它怎麼運作

Podman 版直接執行 HA 外掛的映像（`ghcr.io/woowtech/amd64-woowtechbot:0.1.7-rc.22`，以 digest 固定），外面只加一層 Podman 啟動程式。在 HA 上，Supervisor 會把外掛設定寫成 `/data/options.json` 並先檢查一遍；Podman 沒有 Supervisor，所以這一層做同樣的事：

1. 讀 `~/.config/woowtechbot/woowtechbot.env` 的 `WTB_*` 設定，以及選用的 podman secret；
2. 照 HA 外掛 `config.yaml` 的規則檢查，再用外掛自己的檢查程式檢查；有錯就停下，並指出是哪個設定（結束碼 78）；
3. 把設定寫到容器內的私有 tmpfs，`/data/options.json` 只是連結，所以帳密不會留在資料磁碟或它的備份裡；
4. 執行 HA 外掛原本的程式，程式不做任何修改。建置映像時檢查網頁用的是 PaaS 相同的 woowtech bot 圖示；HA rc.22 已帶內容雜湊網址，Podman 會保留它（見「圖示」）。

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
| `WTB_SERVER_NAME` | （PaaS 的伺服器名稱） | 選填。App 裡顯示的名稱；同時用 PaaS 或 HA 版時，用它分辨是哪一台 |
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
scripts/pair.sh devices   # 登入中的裝置
scripts/pair.sh signout 裝置代號
```

規則和 HA 管理員配對頁相同：配對碼 10 分鐘內有效、只能用一次，取得管理員權限；同一類重新產生時，舊的那組會作廢；取消不會讓已登入的裝置登出。配對碼只顯示在你的終端機，不會寫進日誌。

在瀏覽器打開配對連結後，配對碼會自動帶入，按「連線」就會登入。頁面上「在伺服器上執行 npx openmausbot pair」是上游的說明文字；在 Podman 上請改用 `scripts/pair.sh browser`。

**誰算管理員**：能在這台主機用這個帳號執行 podman 的人，以及 Cockpit 管理員群組裡、開啟了管理員存取權限的人（見下一節），就能產生配對碼，等於 HA 上的管理員。

## Cockpit 管理頁

主機有 Cockpit（362 以上）時，可以把 HA 側邊欄的那一頁裝進 Cockpit，左側「工具」底下會多一個「woowtechbot」：

- 按鈕產生瀏覽器配對碼和連結，或手機 App 的 QR Code、伺服器網址與配對碼，有倒數、複製和取消。
- bot 的狀態：容器、版本、啟動時間、兩個網址、AI 模型有沒有登入、首次初始化信箱和 Email 登入服務有沒有設定。
- 登入中的裝置，可以登出其中一台。

```bash
sudo scripts/cockpit-page.sh install     # bot 的帳號預設是這份 repo 的擁有者，或用 --owner 指定
scripts/cockpit-page.sh status
sudo scripts/cockpit-page.sh uninstall
```

只有管理員群組（預設 `sudo`，沒有就用 `wheel`，或用 `--group` 指定）的成員在選單裡看得到這一頁，而且要開啟 Cockpit 頂端的「管理員存取權限」才能使用，就像 HA 這一頁只給 HA 管理員。頁面透過一支 root 小程式工作：它用 bot 的帳號執行 podman，配對交給容器裡的 `pair.cjs`，不會重啟或更改 bot。每位管理員的配對碼分開，重新產生只會替換自己的。產生、取消和登出都會記在系統日誌（`journalctl -t woowtech-cockpit-woowtechbot`），只記誰做了什麼，不記配對碼。

頁面需要 0.1.7-rc.14-3 以上的映像；映像比較舊時，頁面會提示先執行 `scripts/install.sh`。

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
scripts/secret.sh set signin-relay-token   # 先放權杖（輸入時不顯示）
scripts/install.sh --set WTB_SIGNIN_RELAY_URL=https://<公司代寄網址>/api/woowtechbot/signin-mail
```

誰可以用 Email 登入：

- `WTB_FIRST_ADMIN_EMAIL`：還沒有任何管理員信箱時，把這個信箱設成第一位管理員，只套用一次。
- 之後在 App 的設定裡管理，或在主機上執行下面的指令，立刻生效，不用重啟。加 `--chat-only` 的信箱只能聊天與核准，不能改設定。

```bash
podman exec --user maus -e HOME=/data woowtechbot openmausbot access list
podman exec --user maus -e HOME=/data woowtechbot openmausbot access add 信箱 --chat-only
podman exec --user maus -e HOME=/data woowtechbot openmausbot access remove 信箱
```

不在名單上的信箱要不到驗證碼。

驗收：收件匣收到 8 碼驗證碼並成功登入一次；同一碼再用會被拒（401）。通過後才由管理員關掉測試模式。憑證最長 365 天，到期前要換發。

## 選用的模型請求閘道（llm-gw）

這是容器內的模型請求轉送程式，預設關閉。模型請求沒有指定輸出長度時，它會補上上限，避免上游服務採用過小的預設值而截斷回覆或工具參數。已指定的上限會照原樣轉送；`WTB_LLM_GW_MAX_TOKENS` 也會傳給應用程式的 OpenAI 相容模型驅動，預設是 32000。

需要使用閘道時，在設定檔填入以下三項，再執行 `scripts/install.sh` 套用（會重啟 bot）：

```ini
WTB_LLM_GW_ENABLED=true
WTB_LLM_GW_UPSTREAM=https://models.example.com
WTB_LLM_GW_MAX_TOKENS=32000
```

接著到 bot 的模型供應商設定，把 OpenAI 相容端點設為 `http://127.0.0.1:8092/v1`，API key 仍填在模型供應商設定裡。啟用閘道不會自動更改現有模型連線。上限要符合所選模型的限制。

- 上游網址不可包含帳密、查詢參數或 `#` 片段。若上游已填 `https://models.example.com/v1`，模型端點就填 `http://127.0.0.1:8092`，避免出現兩次 `/v1`。
- 8092 只聽容器內的 loopback，不對主機或公開網址開放。這裡的 `127.0.0.1` 指 bot 容器；若模型服務跑在主機上，必須另外安排容器能到達的位址。
- 停用前，先把模型供應商端點改回可連線的上游，再設 `WTB_LLM_GW_ENABLED=false` 並重新套用。

`tests/ha-suites.sh <HA 外掛的 checkout> llm-gw` 以同版本 HA 測試及隔離容器內的模擬上游，驗證預設停用、設定傳入、輸出上限、授權與路徑轉送、串流、中斷取消、錯誤回傳、重啟及閘道故障時容器退出。測試不連外、不使用正式模型金鑰；真正模型的長回覆與長工具參數仍需另外驗收。

## 圖示

網頁版用 woowtech bot 圖示（藍底機器人），和 PaaS 相同：瀏覽器分頁、「關於」視窗、設定頁，以及加到手機主畫面後的圖示和打開畫面。產品名稱也是 woowtechbot，新安裝的幕僚長就叫 woowtechbot。這是 HA 外掛映像從 0.1.7-rc.19 起的樣子，它採用了 PaaS 的整套品牌修改（rc.14 還是 MausBot 的圖示和名稱）。建置時會檢查圖示和 PaaS 的檔案逐位元相同，不同就停下；檔案副本在 `image/brand`。圖示網址會加上 `?v=<雜湊>`，Cloudflare 和瀏覽器不會再拿出舊圖。

已經建好的幕僚長，名字存在資料裡，換版本不會改：在 App 裡改名，或用 owner API（容器內 `PATCH /api/bots/<id>`，內容 `{"name":"woowtechbot"}`）。

手機上的 MausBot App 是上游在應用程式商店發佈的，圖示和打開畫面是 App 自帶的，這裡改不了。想在手機上也看到 woowtech bot 圖示，可以改用網頁版，和 PaaS 的建議相同：

1. 手機用 Chrome 打開 bot 的網址，例如 `https://woowtechbot-openclaw.woowtech.io`。
2. 登入：管理員用 Cockpit 管理頁產生的瀏覽器配對碼；或用允許的信箱收驗證碼（見「Email 驗證碼登入」）。
3. 按右上角 ⋮，選「加到主畫面」。iPhone 用 Safari 的分享按鈕，選「加入主畫面」。
4. 之後從主畫面的 woowtechbot 圖示打開。

網頁版沒有手機通知，也不能讓 bot 操作手機，這兩件事要用 App。以前就加到主畫面的，圖示可能要過一陣子才會更新；想馬上換，就從主畫面移除再加一次。

## 冷備份與還原

```bash
scripts/backup.sh                                  # 短暫停止 bot；備份資料與設定，再啟動
scripts/restore.sh 備份目錄 --verify-only            # 驗證校驗值與資料檔，不停止 bot
scripts/restore.sh 備份目錄                          # 還原前輸入 woowtechbot 確認
```

備份會放在 `~/.local/share/woow-backups/woowtechbot/backup-<時間>/`，包含資料磁碟匯出、設定檔、版本資訊和 SHA-256 校驗值。資料磁碟有 bot、對話、附件、模型登入與裝置登入狀態，所以目錄設為 0700、檔案設為 0600，搬到別處時也要保持私密。備份時會停止 bot，避免 SQLite 等檔案在寫入中被複製；若原本是執行中，完成後會啟動並檢查健康。備份不自動刪除。

一般備份不包含 Podman 密鑰，適合同一台主機還原，既有密鑰會保留。如果要帶到另一台主機、連公司代寄信和通道密鑰也一起還原，先用 `age-keygen -o 私鑰檔` 建立密鑰組，妥善保管私鑰，然後用 `age-keygen -y 私鑰檔` 取得公鑰：

```bash
scripts/backup.sh --age-recipient age1...              # 資料、設定、Podman 密鑰皆加密
scripts/restore.sh 備份目錄 --identity 私鑰檔 --verify-only
scripts/restore.sh 備份目錄 --identity 私鑰檔 --with-secrets
```

私鑰要另外保存；遺失後無法解開加密備份。密鑰內容透過管線加密，備份目錄不會出現密鑰明文。若不選 `--with-secrets`，還原時保留目前主機上的密鑰。搬到另一台主機時，先取得與備份相同的 HA 映像版本、執行 `scripts/install.sh --gh-auth` 安裝，再還原；外部 DNS 與 Cloudflare 路由需另外指向新主機。還原可接受同一個 HA 映像的不同 Podman 修訂版，不會自動跨 HA 映像版本還原。

還原會先校驗，再停止 bot，另存一份 `pre-restore-<時間>/`，接著匯入資料、設定並重啟驗收。失敗會嘗試從這份舊資料自動回退；請保留它，直到確認服務與資料正常。`scripts/uninstall.sh --purge` 仍使用舊式的最後資料卷匯出，不包含 Podman 密鑰；要完整保存密鑰，請先做加密冷備份。

## 更新與移除

- 更新：拉新版本的 repo 後執行 `scripts/install.sh`。舊版的本機映像會保留，方便退回。
- 移除：執行 `scripts/uninstall.sh`，資料磁碟、密鑰與設定都會保留；加 `--purge` 才會刪除，刪除前會先做一份最後備份。

## 已知限制

- 沒有 HA 側邊欄，也沒有 HA 管理員驗證；改由主機帳號與 Cockpit 管理員群組決定誰是管理員（見「Cockpit 管理頁」）。
- 沒有 HA Supervisor 備份；改用本 repo 的冷備份與還原腳本（見上一節）。
- 外掛程式目前要求一定要有 `ingress_origin`，Podman 會自動用 bot 自己的網址代入。
- Chromium 的沙盒是關閉的，改靠容器隔離，和 HA、PaaS 相同。
- 沒有 FCM 遠端推播；App 開著或「保持連線」時才收得到通知。
- 手機 App 的圖示和打開畫面是 MausBot 的，那是 App 自帶的，這裡改不了；見「圖示」。
- 上游 MausBot 的廣告（團隊方案、ModelGo、Boat 優惠等）和「公告」頁已拿掉，這是 PaaS 的修補 0016，HA 映像從 0.1.7-rc.20 起帶著。畫面上還有約一百處「MausBot」字樣，講的是手機 App、MausBot Cloud 和帳號等上游的東西，和 PaaS 一樣刻意保留。
- HA rc.22 帶入 PaaS 修補 0017：頭像的十種通用輪廓、十種表情和黑白五官可切換；兩種編輯器不再列節慶款式，也不會自動裝扮。舊節慶 body ID 僅在畫面顯示通用機器人，原資料與上傳頭像保留。
- 官方 App 2.0.0 從檔案選擇器選 CSV 會被拒，可以改成 .txt 或壓成 ZIP（上游 #7084）。配對連結沒有確認畫面。
- 發布的網站請用 `.js` 當 JavaScript module 的副檔名：`.mjs` 會被當成一般下載檔送出，瀏覽器不會執行（HA、PaaS 相同）。
- Codex 的工具範圍一定要保留 `native:*`。
- 模型帳號的用量由各帳號自己負責。

## 測試

- `node --test tests/*.test.cjs`、`tests/dryrun.local.sh`：不需要映像，CI 每次都跑。
- `tests/smoke.sh`：安裝後在主機上跑，檢查服務、開放的埠、設定與密鑰的權限、資源上限、網頁圖示、配對碼只能用一次、配對碼不進日誌。會產生並用掉一組配對碼，最後清乾淨。
- `tests/ha-suites.sh <HA 外掛的 checkout>`：拿同一版 HA 外掛自己的測試來跑 Podman 映像（工具、發布網站兩種模式、Email 登入、llm-gw），不另外抄一份。可在後面指定 `toolchain`、`published`、`signin` 或 `llm-gw`，只跑其中一項。
- `tests/public.sh`：用本機的 TLS 替身試跑 `check-public.sh`，也確認它會擋下接錯的設定。
- `tests/runtime.sh`：用一個用完即丟、沒有網路的容器，跑 HA 外掛的執行期檢查（Odoo MCP 唯讀閘道、未配對與假冒 HA 入口的請求被拒、引擎版本），不影響已安裝的 bot。
- `tests/backup-restore.sh`：用拋棄式 Podman 資料卷測試明文／加密備份、SQLite、連結、合成密鑰、匯入與校驗拒絕；不碰正式資料卷。CI 另測危險 tar 路徑的拒絕。

## 與其他版本對照

| | HA 外掛 | PaaS | Podman（本 repo） |
|---|---|---|---|
| 執行位置 | Home Assistant 主機 | WOOW PaaS 工作區 | 自己的 Linux 主機 |
| 管理入口 | HA 側邊欄 | PaaS 服務設定頁 | 主機指令、Cockpit 管理頁 |
| 對外網址 | CF Web GUI＋Security Access | 平台自動建立 | 主機上的 Cloudflare Tunnel＋Security Access |
| 資源 | 共用主機，不設上限 | 4 CPU／8 GiB，5 個對話 | 預設 2 核／4 GiB，3 個對話 |
| 備份 | HA 冷備份 | 刪除後保留 7 天 | 冷備份與還原；可用 age 加密並包含 Podman 密鑰 |
| 網頁圖示與名稱 | woowtech bot（rc.19 起） | woowtech bot | woowtech bot（來自 HA 映像） |

## 授權

本 repo 的封裝程式以 Apache License 2.0 授權，見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。容器映像內附各元件自己的授權，以及上游 OpenMausBot 的 NOTICE。本專案不代表 OpenMausBot 作者背書。
