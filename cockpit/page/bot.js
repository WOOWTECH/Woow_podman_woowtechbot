/* Follow Cockpit's light or dark preference, including live changes. */
(() => {
  "use strict";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  function apply(override) {
    let style = override;
    if (!style) { try { style = localStorage.getItem("shell:style"); } catch { /* use the system's */ } }
    document.documentElement.classList.toggle("pf-v6-theme-dark", style === "dark" || ((style || "auto") === "auto" && system.matches));
  }
  window.addEventListener("storage", event => { if (event.key === "shell:style" || event.key === null) apply(); });
  window.addEventListener("cockpit-style", event => apply(event.detail?.style));
  system.addEventListener("change", () => apply());
  apply();
})();

/* Everything goes through the root helper; a code lives only in this page's memory. */
(() => {
  "use strict";
  const cockpit = window.cockpit;
  const $ = id => document.getElementById(id);
  const HELPER = "/usr/local/libexec/woowtech-cockpit-woowtechbot";
  const KINDS = ["browser", "phone"];
  const SLOW = 30000;
  const FAST = 5000;
  const empty = () => ({ state: "none", pairing: null, busy: "", note: "" });
  const codes = { browser: empty(), phone: empty() };
  // generation: an answer that was asked for before a change must not judge the new code.
  const page = { data: null, denied: false, error: "", offset: 0, timer: null, generation: 0, loading: false, last: 0, signout: null };

  const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const say = message => text("feedback", message);
  const now = () => Date.now() + page.offset;
  const visible = () => !document.hidden && !cockpit.hidden;
  const isActive = kind => codes[kind].state === "active" && codes[kind].pairing?.expiresAt > now();
  const time = value => Number.isFinite(value) ? new Date(value).toLocaleString("zh-TW",
    { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

  function web(value) {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  function setLink(link, href) {
    if (href) link.href = href; else link.removeAttribute("href");
    link.hidden = !href;
  }

  function call(command, ...args) {
    return new Promise((resolve, reject) => {
      let output = "";
      const answer = (error, rest) => {
        let value = null;
        try { value = JSON.parse(output + (rest || "")); } catch { /* not the helper's answer */ }
        if (value && typeof value === "object" && !value.error && !error) { resolve(value); return; }
        const failure = new Error(typeof value?.error === "string" ? value.error
          : error?.problem === "not-found" ? "這台主機還沒安裝 woowtechbot 的頁面元件。"
            : error?.problem === "disconnected" ? "Cockpit 的連線已中斷，請重新載入頁面。" : "暫時無法取得資料，請稍後再試。");
        failure.denied = ["access-denied", "not-authorized"].includes(error?.problem) || /管理員存取權限/.test(failure.message);
        reject(failure);
      };
      const child = cockpit.spawn([HELPER, command, ...args], { superuser: "require", err: "message" });
      const timeout = setTimeout(() => child.close("timeout"), 60000);
      child.stream(chunk => { output += chunk; });
      child.then(rest => { clearTimeout(timeout); answer(null, rest); },
        (error, rest) => { clearTimeout(timeout); answer(error, rest); });
    });
  }

  function forget() { for (const kind of KINDS) codes[kind] = empty(); }

  function renderStatus() {
    const { container: box, unit, app } = page.data;
    let label = "沒有在執行", tone = "bad";
    if (box?.status === "running") {
      if (box.health === "unhealthy") label = "異常";
      else if (app) { label = "運作中"; tone = "good"; }
      else { label = "啟動中"; tone = "active"; }
    } else if (!box) label = "尚未安裝";
    text("status-badge", label);
    $("status-badge").dataset.tone = tone;
    text("fact-podman", box ? `Podman 容器 woowtechbot（rootless，帳號 ${page.data.owner}，Podman ${page.data.podman}）` : `帳號 ${page.data.owner} 目前沒有這個容器`);
    text("fact-version", box ? `${box.version || "—"}${app?.version ? `（App ${app.version}）` : ""}` : "—");
    text("fact-started", box ? time(box.startedAt) : "—");
    for (const [id, value] of [["fact-public", app?.publicUrl], ["fact-published", app?.publishedUrl]]) {
      const href = web(value || "");
      if ($(id).textContent === (href ? value : "尚未設定")) continue;
      $(id).replaceChildren();
      if (!href) { $(id).textContent = app ? "尚未設定" : "—"; continue; }
      const link = document.createElement("a");
      link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = value;
      $(id).append(link);
    }
    text("fact-engines", app ? app.engines.map(e => `${e.name} ${e.ready ? "已登入" : "未登入"}`).join("、") || "沒有可用的模型" : "—");
    text("fact-admin", app ? app.adminEmailConfigured ? "已設定初始化信箱" : "尚未設定初始化信箱" : "—");
    text("fact-mail", app ? app.emailReady ? "已設定寄信連線" : "尚未設定寄信連線" : "—");
    const help = page.data.appError || (unit?.active === "failed" ? "服務啟動失敗，請查看日誌。" : "") ||
      (app && !app.engines.some(e => e.ready) ? "還沒有登入任何 AI 模型：先用下面的配對登入 woowtechbot，再到「連線 AI」登入。" : "");
    text("status-help", help);
    $("status-help").hidden = !help;
    $("open-services").hidden = !page.data.servicesPage;
    setLink($("open-bot"), web(app?.publicUrl || box?.local || ""));
  }

  function renderKind(kind) {
    const item = codes[kind], app = page.data?.app, active = isActive(kind);
    const other = !active && app?.pending.find(entry => entry.kind === kind);
    const allowed = Boolean(app) && (kind === "browser" || Boolean(app.publicUrl));
    const words = {
      none: other ? `你有一組還沒使用的配對碼，${time(other.expiresAt)} 到期。內容只顯示一次，可以重新產生或取消。` : "還沒有產生配對碼。",
      active: "配對碼準備好了，請在到期前使用。",
      expired: "這組配對碼已到期，需要時可以重新產生。",
      used: item.note || "這組配對碼已經用掉或被取代了。",
      cancelled: "已取消這組配對碼，登入中的裝置不受影響。"
    };
    const badges = { none: other ? "等待配對" : "尚未產生", active: "等待配對", expired: "已到期", used: "已使用", cancelled: "已取消" };
    text(`${kind}-state`, item.busy ? "處理中，請稍候。" : !app ? "bot 準備好之後才能配對。"
      : !allowed ? "手機配對需要手機連得到的網址，請先在主機設定 WTB_PUBLIC_URL。" : words[item.state]);
    text(`${kind}-badge`, item.busy ? "處理中" : badges[item.state]);
    $(`${kind}-badge`).dataset.tone = active ? "active" : "";
    $(`${kind}-secret`).hidden = !active;
    $(`${kind}-generate`).disabled = !allowed || Boolean(item.busy);
    text(`${kind}-generate`, item.busy === "pair" ? "產生中…" : active || other || item.state !== "none" ? "重新產生"
      : kind === "browser" ? "產生配對碼" : "產生手機配對");
    $(`${kind}-generate`).classList.toggle("primary", !active);
    $(`${kind}-cancel`).hidden = !active && !other;
    $(`${kind}-cancel`).disabled = Boolean(item.busy);
    const pairing = active ? item.pairing : null;
    $(`${kind}-code`).value = pairing?.code || "";
    text(`${kind}-expiry`, pairing ? time(pairing.expiresAt) : "");
    if (kind === "browser") {
      setLink($("browser-open"), web(pairing?.url || ""));
      text("browser-help", !pairing ? "" : pairing.server ? "「開啟並配對」會讓這個瀏覽器登入；要登入別的瀏覽器，請複製連結過去。"
        : "還沒設定對外網址，這個連結只有在主機本身才打得開。");
    } else {
      $("phone-address").value = pairing?.server || "";
      setLink($("phone-open"), pairing?.inviteUrl?.startsWith("openmausbot://pair?") ? pairing.inviteUrl : "");
      // The SVG stays an image: never parsed into the document.
      const source = pairing?.qrSvg?.startsWith("<svg") ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}` : "";
      if (source) $("phone-qr").src = source; else $("phone-qr").removeAttribute("src");
      $("phone-qr").hidden = !source;
    }
  }

  function renderDevices() {
    const list = [...page.data?.app?.devices || []].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    text("devices-count", page.data?.app ? `${list.length} 台` : "—");
    $("devices").hidden = !list.length;
    $("devices-empty").hidden = !page.data?.app || list.length > 0;
    $("devices-body").replaceChildren(...list.map(device => {
      const row = document.createElement("tr");
      const name = device.label || "未命名的裝置";
      const head = document.createElement("th");
      head.scope = "row";
      head.textContent = device.person || device.email ? `${name}（${device.person || device.email}）` : name;
      row.append(head);
      for (const [label, value] of [["權限", (device.scopes || []).includes("admin") ? "管理員" : "一般"],
        ["登入時間", time(device.createdAt)], ["最近使用", time(device.lastSeenAt)], ["到期", time(device.expiresAt)]]) {
        const cell = document.createElement("td");
        cell.dataset.label = label; cell.textContent = value;
        row.append(cell);
      }
      const cell = document.createElement("td"), button = document.createElement("button");
      button.type = "button"; button.textContent = "登出";
      button.setAttribute("aria-label", `登出 ${name}`);
      button.addEventListener("click", () => askSignOut(device.id, name));
      cell.append(button); row.append(cell);
      return row;
    }));
  }

  function render() {
    $("access-note").hidden = !page.denied;
    $("page-error").hidden = !page.error || page.denied;
    text("error-message", page.error);
    $("content").hidden = !page.data || page.denied;
    $("refresh").disabled = page.loading || page.denied;
    if (!page.data || page.denied) { setLink($("open-bot"), ""); return; }
    renderStatus();
    KINDS.forEach(renderKind);
    renderDevices();
    countdown();
  }

  function countdown() {
    for (const kind of KINDS) {
      const item = codes[kind];
      if (item.state !== "active") continue;
      const left = Math.ceil((item.pairing.expiresAt - now()) / 1000);
      if (left <= 0) { Object.assign(item, { state: "expired", pairing: null }); renderKind(kind); continue; }
      text(`${kind}-countdown`, `剩餘 ${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`);
    }
  }

  function judge(app) {
    for (const kind of KINDS) {
      const item = codes[kind];
      if (!isActive(kind) || app.pending.some(entry => entry.id === item.pairing.id)) continue;
      const device = app.devices.find(entry => entry.createdAt >= item.pairing.now - 1000);
      Object.assign(item, { state: "used", pairing: null, note: device ? `配對完成：「${device.label || "新裝置"}」已登入。` : "" });
    }
  }

  async function refresh(command = "state") {
    if (page.loading) return;
    const generation = page.generation;
    clearTimeout(page.timer);
    page.loading = true;
    $("refresh").disabled = true;
    try {
      const answer = await call(page.data ? command : "state");
      page.data = { ...page.data, ...answer };
      if (answer.app) {
        page.offset = Number.isFinite(answer.app.now) ? answer.app.now - Date.now() : 0;
        if (generation === page.generation) judge(answer.app);
      }
      page.denied = false; page.error = ""; page.last = Date.now();
      if ($("feedback").textContent.startsWith("正在讀取")) say("");
    } catch (error) {
      page.denied = error.denied;
      page.error = error.message;
      if (error.denied) { page.data = null; forget(); }
      if ($("feedback").textContent.startsWith("正在讀取")) say("");
    }
    page.loading = false;
    render();
    schedule();
  }

  function schedule() {
    clearTimeout(page.timer);
    if (page.denied || !visible()) return;
    const fast = KINDS.some(isActive) && !page.error;
    page.timer = setTimeout(() => refresh(fast ? "poll" : "state"), fast ? FAST : SLOW);
  }

  async function change(kind, command) {
    const item = codes[kind];
    if (item.busy) return;
    page.generation++;
    Object.assign(item, { busy: command, pairing: null, state: "none", note: "" });
    say("");
    renderKind(kind);
    try {
      const answer = await call(command, kind);
      if (command === "pair") {
        page.offset = answer.pairing.now - Date.now();
        Object.assign(item, { state: "active", pairing: answer.pairing });
        say("已產生一次性配對碼，請在到期前使用。");
      } else {
        item.state = "cancelled";
        if (page.data?.app) page.data.app.pending = page.data.app.pending.filter(entry => entry.kind !== kind);
        say("已取消配對碼；登入中的裝置維持登入。");
      }
    } catch (error) {
      if (error.denied) { page.denied = true; page.data = null; forget(); } else say(error.message);
    }
    page.generation++;
    item.busy = "";
    render();
    schedule();
  }

  async function copy(value, label) {
    if (!value) return;
    let done = false;
    try { await navigator.clipboard.writeText(value); done = true; } catch {
      // Cockpit over plain HTTP has no clipboard API.
      const area = document.createElement("textarea");
      area.value = value; area.className = "code"; area.setAttribute("readonly", "");
      document.body.append(area); area.select();
      try { done = document.execCommand("copy"); } catch { /* tell the administrator */ }
      area.remove();
    }
    say(done ? `已複製${label}，請只在你自己的裝置使用。` : `瀏覽器不允許複製，請手動選取${label}。`);
  }

  function askSignOut(id, name) {
    page.signout = id;
    text("signout-text", `「${name}」會立刻被登出，要再使用必須重新配對。`);
    $("signout-error").hidden = true;
    $("signout-confirm").disabled = false;
    $("signout-dialog").showModal();
  }

  async function signOut() {
    $("signout-confirm").disabled = true;
    try {
      const answer = await call("signout", page.signout);
      $("signout-dialog").close();
      say(`已登出「${answer.label || "裝置"}」。`);
      await refresh("poll");
    } catch (error) {
      text("signout-error", error.message);
      $("signout-error").hidden = false;
      $("signout-confirm").disabled = false;
    }
  }

  if (!cockpit?.spawn) { say("請從 Cockpit 的選單開啟這一頁。"); return; }
  for (const kind of KINDS) {
    $(`${kind}-generate`).addEventListener("click", () => change(kind, "pair"));
    $(`${kind}-cancel`).addEventListener("click", () => change(kind, "cancel"));
    $(`${kind}-copy-code`).addEventListener("click", () => copy(codes[kind].pairing?.code, "配對碼"));
  }
  $("browser-copy-link").addEventListener("click", () => copy(codes.browser.pairing?.url, "配對連結"));
  $("phone-copy-address").addEventListener("click", () => copy(codes.phone.pairing?.server, "伺服器網址"));
  $("refresh").addEventListener("click", () => refresh());
  $("retry").addEventListener("click", () => refresh());
  $("open-services").addEventListener("click", () => cockpit.jump("/woowtechservices"));
  $("signout-cancel").addEventListener("click", () => $("signout-dialog").close());
  $("signout-confirm").addEventListener("click", signOut);
  const permission = cockpit.permission({ admin: true });
  permission.addEventListener("changed", () => {
    if (permission.allowed === false) { page.denied = true; page.data = null; forget(); render(); } else if (permission.allowed) refresh();
  });
  const shown = () => {
    clearTimeout(page.timer);
    if (!visible()) return;
    countdown();
    if (Date.now() - page.last > FAST) refresh(); else schedule();
  };
  document.addEventListener("visibilitychange", shown);
  cockpit.addEventListener("visibilitychange", shown);
  window.addEventListener("pagehide", () => { clearTimeout(page.timer); page.generation++; page.data = null; forget(); KINDS.forEach(renderKind); });
  setInterval(() => { if (visible()) countdown(); }, 1000);
  refresh();
})();
