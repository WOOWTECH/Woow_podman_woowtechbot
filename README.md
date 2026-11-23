# woowtechbot for Podman

woowtechbot 是 WOOWTECH 的團隊 AI 助理，基於 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 開源專案（Apache-2.0）。這個 repo 讓它以 rootless Podman（Quadlet、systemd --user）在自己的主機上執行。功能以 woowtechbot 的 Home Assistant 外掛版與 WOOW PaaS 雲端服務版為準，三個版本要一致。

> **狀態：規劃中。** 目前還沒有可安裝的版本。woowtechbot 的容器映像目前不公開，安裝時需要有 GHCR 讀取權限。

## 規劃的功能

與 HA 外掛版、PaaS 版相同：

- AI 團隊：Claude Code、Codex 與 OpenAI 相容模型；模型帳號在應用程式裡登入。
- 內建工具：瀏覽器、文件、OCR、試算表、資料分析與影音工具。
- 直接讀取對話附件：PDF 文字、XLSX 第一個工作表、CSV／TSV／TXT／MD／JSON。
- 發布網站：bot 做好的靜態網頁可以用獨立網址分享。
- 配對：瀏覽器一次性配對碼，以及手機 App 的 QR 或「伺服器網址＋配對碼」。
- Email 驗證碼登入，信件由公司郵件服務代寄，主機上不存放 SMTP 密碼。
- OpenAI 相容模型的輸出上限（預設 32000）、選配的 LLM 閘道與 Odoo MCP 唯讀接入。
- 備份、還原與升級失敗時退回上一版。

## 和其他版本的差別

| | HA 外掛 | PaaS | Podman（本 repo） |
|---|---|---|---|
| 執行位置 | Home Assistant 主機 | WOOW PaaS 工作區 | 自己的 Linux 主機（rootless Podman） |
| 管理入口 | HA 側邊欄 | PaaS 服務設定頁 | 主機指令；Cockpit 管理頁規劃中 |
| 對外網址 | Cloudflare Tunnel＋PaaS Security Access | 平台自動建立 | Cloudflare Tunnel＋PaaS Security Access |
| 備份 | HA 冷備份 | 刪除服務後保留 7 天 | 套件的備份／還原腳本 |

## 授權

本 repo 的封裝程式以 Apache License 2.0 授權，見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。容器映像內附各元件自己的授權與上游 OpenMausBot 的 NOTICE。本專案不代表 OpenMausBot 作者背書。
